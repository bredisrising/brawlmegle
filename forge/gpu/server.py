"""
Forge 3D service: model sheet in, Mixamo-rigged GLB out, on one GPU box (see README.md).

    POST /jobs                 {"image": base64 PNG/JPEG model sheet, "model"?: base64 GLB to rig only,
                                "rigAttempt"?: 2 for a re-rig the forge's rig check asked for,
                                "face"?: true/false to paint the sheet's face on (default: FORGE3D_FACE_PROJECT),
                                "faceOnly"?: true: "model" is already rigged, only paint its face}  ->  202 {"id"}
    GET  /jobs/<id>            ->  {"status": queued|model|rig|done|failed, "timings", "error", "rigged", "queued",
                                    "face": {"painted", "seconds", ...} when the face step ran}
    GET  /jobs/<id>/rigged.glb ->  the rigged model (model.glb: the same model without a skeleton)
    GET  /health               ->  {"ok", "ready", "queued", "settings"}
    POST /keepalive            ->  {"ok", "ready"}  (a scan's started: put off the idle power-off)

Every call but /health needs the header x-forge3d-key: $FORGE3D_KEY. One GPU thread makes models (TRELLIS.2) and
one CPU thread rigs them (MediaPipe on the sheet, then Blender), so back-to-back forges overlap.
"""
import base64
import hmac
import io
import json
import os
import queue
import re
import shutil
import subprocess
import sys
import threading
import time
import traceback
import uuid
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

from PIL import Image, ImageDraw

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
from landmarks import Landmarker, template  # noqa: E402

KEY = os.environ.get("FORGE3D_KEY", "")
PORT = int(os.environ.get("FORGE3D_PORT", 8790))
BIND = os.environ.get("FORGE3D_BIND", "0.0.0.0")
ROOT = os.environ.get("FORGE3D_ROOT", "/opt/forge3d")
MODEL_DIR = os.environ.get("FORGE3D_MODEL_DIR", f"{ROOT}/models/TRELLIS.2-4B")
POSE_MODEL = os.environ.get("FORGE3D_POSE_MODEL", f"{ROOT}/models/pose_landmarker_heavy.task")
BLENDER = os.environ.get("FORGE3D_BLENDER", f"{ROOT}/blender/blender")
# The forge's own optimizer (forge/optimize.js: WebP textures + meshopt), run here on the GPU box's faster CPU so the
# forge box only stores the result. Off when Node or the optimizer isn't installed.
NODE = os.environ.get("FORGE3D_NODE", f"{ROOT}/node/bin/node")
OPTIMIZER = os.environ.get("FORGE3D_OPTIMIZER", f"{ROOT}/optimizer/optimize-glb.mjs")
# The forge's rig check (forge/rigcheck.js: poses the rig like the game and skins it), next to the optimizer. When a
# rig fails it, the rigger's next attempt plan is tried (rig_blender.py PLANS), up to LAST_RIG_ATTEMPT.
RIGCHECK = os.environ.get("FORGE3D_RIGCHECK", f"{ROOT}/optimizer/rigcheck.js")
LAST_RIG_ATTEMPT = 4
# Sharper faces (face_project.py): the sheet's own face painted onto the rigged model's texture. Off by default.
FACE_PROJECT = os.environ.get("FORGE3D_FACE_PROJECT", "0") == "1"
FACE_MODEL = os.environ.get("FORGE3D_FACE_MODEL", os.path.join(os.path.dirname(POSE_MODEL), "face_landmarker.task"))  # weights.py
WORK = os.environ.get("FORGE3D_WORK", "/var/lib/forge3d/jobs")
SETTINGS = {
    "pipeline": os.environ.get("FORGE3D_PIPELINE", "1024_cascade"),
    # 8 steps, 40k faces and a 1024 texture: ~11 s faster than 12 / 60k / 2048 with the same fighter at fight distance
    # (TRELLIS's texture detail is capped by its voxels, not the bake size). See research/forge-gpu.md.
    "steps": int(os.environ.get("FORGE3D_STEPS", 8)),
    "faces": int(os.environ.get("FORGE3D_FACES", 40000)),
    "texture": int(os.environ.get("FORGE3D_TEXTURE", 1024)),
    "yaw": float(os.environ.get("FORGE3D_YAW", 0)),
}
MAX_QUEUED = int(os.environ.get("FORGE3D_MAX_QUEUED", 6))
# The box powers itself off after this many minutes with nothing to do (0: never). A stopped box costs only its disk;
# bingus's waker starts it again when someone scans (waker.sh), and it's ready about a minute later.
IDLE_STOP = float(os.environ.get("FORGE3D_IDLE_STOP_MIN", 0)) * 60
# Warm-up runs at startup: the first compiles every kernel; a second one only logs the steady-state time. 0 for a box
# that's started for a scan: once a GPU type's kernels are compiled and tuned (cached on disk), the first real job is
# only ~2 s slower than the rest, and a warm-up would make it wait 12-29 s.
WARMUPS = int(os.environ.get("FORGE3D_WARMUPS", 2))
JOB_TTL = 15 * 60
MAX_BODY = 30 * 1024 * 1024

jobs: dict[str, dict] = {}
jobs_lock = threading.Lock()
gpu_q: "queue.Queue[dict]" = queue.Queue()
rig_q: "queue.Queue[dict]" = queue.Queue()
state = {"ready": False, "error": None, "used": time.time()}
generator = None
landmarker = None
landmark_lock = threading.Lock()
face_finder = None  # MediaPipe's face landmarker, loaded once when the face step can run
face_lock = threading.Lock()


def log(*args):
    print(time.strftime("%H:%M:%S"), *args, flush=True)


def find_landmarks(job):
    """Sheet joints for the rigger. Runs next to the GPU step; falls back to average A-pose proportions."""
    try:
        with landmark_lock:
            lm = landmarker(job["sheet"])
    except Exception as err:  # noqa: BLE001
        log(job["id"][:8], "landmarks failed, using the template:", err)
        lm = template(job["sheet"])
    with open(os.path.join(job["dir"], "landmarks.json"), "w") as f:
        json.dump(lm, f)


def write_atomic(path, data: bytes):
    with open(path + ".tmp", "wb") as f:
        f.write(data)
    os.replace(path + ".tmp", path)


def write_preview(job, kind, data):
    """The forge streams these to the forging screen: the sparse voxels (stage 1) and the untextured shape."""
    try:
        if kind == "voxels":
            # uint16 resolution, then x, y, z bytes per voxel (TRELLIS axes: z up).
            coords = data["coords"].astype("uint8")
            write_atomic(os.path.join(job["dir"], "voxels.bin"), int(data["resolution"]).to_bytes(2, "little") + coords.tobytes())
            name = "voxels.bin"
        elif kind == "shape":
            import trimesh

            glb = trimesh.Trimesh(data["vertices"], data["faces"], process=False).export(file_type="glb")
            write_atomic(os.path.join(job["dir"], "shape.glb"), glb)
            name = "shape.glb"
        else:
            return
        job["previews"][name] = round(time.time() - job["created"], 2)
    except Exception as err:  # noqa: BLE001
        log(job["id"][:8], f"{kind} preview failed:", err)


def gpu_worker():
    while True:
        job = gpu_q.get()
        try:
            job["status"] = "model"
            start = time.time()
            job["lm_thread"] = threading.Thread(target=find_landmarks, args=(job,), daemon=True)
            job["lm_thread"].start()
            preview = lambda kind, data: write_preview(job, kind, data)  # noqa: E731
            job["timings"].update(generator(job["sheet"], os.path.join(job["dir"], "raw.glb"), on_preview=preview, **job.get("settings", {})))
            job["timings"]["model"] = round(time.time() - start, 2)
            rig_q.put(job)
        except Exception as err:  # noqa: BLE001
            traceback.print_exc()
            job.update(status="failed", error=f"model: {err}")


def rig(job_dir, out_name="rigged.glb", attempt=1):
    """Blender rig step. Returns the rigger's report ("rig": which weighting path made it, "rig_ok": whether its
    weight check passed), raises on failure. attempt 2+: the forge's re-rig after its own rig check failed."""
    cmd = [BLENDER, "-b", "--factory-startup", "--python-exit-code", "1", "-P", os.path.join(HERE, "rig_blender.py"), "--",
           os.path.join(job_dir, "raw.glb"), os.path.join(job_dir, "landmarks.json"), os.path.join(job_dir, out_name),
           "--static", os.path.join(job_dir, "model.glb"), "--yaw", str(SETTINGS["yaw"]), "--attempt", str(int(attempt))]
    # Without a display: Blender stalls ~30 s at startup when it can see one (WSLg), even in background mode.
    env = {k: v for k, v in os.environ.items() if k not in ("DISPLAY", "WAYLAND_DISPLAY")}
    out = subprocess.run(cmd, capture_output=True, text=True, timeout=120, env=env)
    report = re.search(r"^RIG_RESULT (.*)$", out.stdout, re.M)
    if out.returncode != 0 or not report:
        tail = (out.stderr or out.stdout)[-600:]
        raise RuntimeError(f"blender exited {out.returncode}: {tail}")
    return json.loads(report.group(1))


def game_check(glb_path):
    """forge/rigcheck.js on a rigged GLB: {"ok", "score", "fails"}, or None when the checker isn't installed."""
    if not (os.path.exists(NODE) and os.path.exists(RIGCHECK)):
        return None
    try:
        out = subprocess.run([NODE, RIGCHECK, glb_path, "--json"], capture_output=True, text=True, timeout=60)
        r = json.loads(out.stdout.strip().splitlines()[-1])
    except Exception as err:  # noqa: BLE001
        log("rig check didn't run:", err)
        return None
    problems = r.get("problems", [])
    if any(p.get("code") == "unreadable" for p in problems):  # its packages are missing (or the GLB is): unchecked
        log("rig check couldn't read the GLB:", problems[0].get("message"))
        return None
    return {"ok": bool(r.get("ok")), "score": r.get("score"), "fails": [p["message"] for p in problems if p.get("level") == "fail"]}


def rig_until_ok(job):
    """Rigs the model with the rigger's attempt plans in turn (from the job's rigAttempt) until the game's rig check
    passes, and keeps the best rig as rigged.glb. The report says which attempt and path made it ("rig"), its own
    weight check ("rig_ok", "check"), the game's check ("game_check") and every try ("tries")."""
    tries, best = [], None
    for attempt in range(job.get("rig_attempt", 1), LAST_RIG_ATTEMPT + 1):
        name = f"rigged.try{attempt}.glb"
        report = rig(job["dir"], name, attempt)
        game = report["game_check"] = game_check(os.path.join(job["dir"], name))
        tries.append({"attempt": attempt, "rig": report.get("rig"), "rig_ok": report.get("rig_ok"),
                      **({"score": game["score"], "ok": game["ok"]} if game else {})})
        rank = (bool(game["ok"]) if game else bool(report.get("rig_ok", True)), (game or {}).get("score") or 0)
        if best is None or rank > best[0]:
            best = (rank, name, report)
        if game is None or game["ok"]:
            break
    _, name, report = best
    os.replace(os.path.join(job["dir"], name), os.path.join(job["dir"], "rigged.glb"))
    for t in tries:
        try:
            os.remove(os.path.join(job["dir"], f"rigged.try{t['attempt']}.glb"))
        except FileNotFoundError:
            pass
    report["tries"] = tries
    return report


def paint_face(job):
    """face_project.py on rigged.glb, in place: the sheet's face onto the texture (UVs, rig and skin untouched).
    Never fails the job: on any error, or when the faces don't match well enough, rigged.glb stays as it was."""
    start = time.perf_counter()
    path = os.path.join(job["dir"], "rigged.glb")
    try:
        if face_finder is None:
            raise RuntimeError("face landmarker not loaded")
        import face_project

        with open(path, "rb") as f:
            glb = f.read()
        with face_lock:
            out, info = face_project.run(glb, job["sheet"], face=face_finder)
        if out:
            write_atomic(path, out)
        job["face"] = {"painted": bool(out), **{k: info[k] for k in ("skipped", "face", "texture", "front", "iou") if k in info}}
    except Exception as err:  # noqa: BLE001
        traceback.print_exc()
        job["face"] = {"painted": False, "error": str(err)[:300]}
    job["face"]["seconds"] = job["timings"]["face"] = round(time.perf_counter() - start, 2)
    log(job["id"][:8], "face:", json.dumps(job["face"]))


def optimize(job):
    """rigged.glb -> its optimized version (the original stays as rigged.orig.glb). Keeps the original on failure."""
    if not (os.path.exists(NODE) and os.path.exists(OPTIMIZER)):
        return
    start = time.time()
    src, dst = os.path.join(job["dir"], "rigged.glb"), os.path.join(job["dir"], "rigged.opt.glb")
    out = subprocess.run([NODE, OPTIMIZER, src, dst], capture_output=True, text=True, timeout=60)
    if out.returncode == 0 and os.path.exists(dst):
        os.replace(src, os.path.join(job["dir"], "rigged.orig.glb"))
        os.replace(dst, src)
        job["optimized"] = True
    else:
        log(job["id"][:8], "optimize failed, sending the original:", (out.stderr or out.stdout)[-300:])
    job["timings"]["optimize"] = round(time.time() - start, 2)


def rig_worker():
    while True:
        job = rig_q.get()
        try:
            job["status"] = "rig"
            if not job.get("face_only"):
                start = time.time()
                job["lm_thread"].join()
                job["report"] = report = rig_until_ok(job)
                job["timings"]["rig"] = round(time.time() - start, 2)
                game = report.get("game_check")
                if not report.get("rig_ok", True) or (game and not game["ok"]):
                    log(job["id"][:8], "RIG CHECK FAILED on every attempt, sending the best:", json.dumps(report["tries"]))
                elif report.get("rig") != "bone-heat" or len(report["tries"]) > 1:
                    log(job["id"][:8], "rig:", json.dumps(report["tries"]))
            job["rigged"] = True
            # After the rig (and its check: the geometry doesn't change), before the optimizer re-encodes the texture.
            if job.get("face_project"):
                paint_face(job)
            optimize(job)
            job["status"] = "done"
        except Exception as err:  # noqa: BLE001
            traceback.print_exc()
            job.update(status="failed", error=f"rig: {err}")
        job["timings"]["total"] = round(time.time() - job["created"], 2)
        state["used"] = time.time()
        log(job["id"][:8], job["status"], job["timings"], job.get("error", ""))


def janitor():
    while True:
        time.sleep(60)
        now = time.time()
        with jobs_lock:
            old = [i for i, j in jobs.items() if now - j["created"] > JOB_TTL]
            for i in old:
                shutil.rmtree(jobs.pop(i)["dir"], ignore_errors=True)
            busy = any(j["status"] in ("queued", "model", "rig") for j in jobs.values())
        # Nothing to do for IDLE_STOP: power off (still loading counts as busy; a box that failed to load stops too).
        loading = not state["ready"] and state["error"] is None
        if IDLE_STOP and not busy and not loading and gpu_q.empty() and rig_q.empty() and now - state["used"] > IDLE_STOP:
            log(f"idle for {(now - state['used']) / 60:.0f} min: powering off")
            subprocess.run(["systemctl", "poweroff"], check=False)
            return


def warm_sheet() -> Image.Image:
    """A crude A-pose figure on light gray: enough to compile and warm every kernel before real players arrive."""
    im = Image.new("RGB", (768, 1152), (205, 205, 205))
    d = ImageDraw.Draw(im)
    skin, shirt, pants = (196, 140, 100), (40, 90, 160), (50, 50, 60)
    d.ellipse([324, 40, 444, 180], fill=skin)
    d.rectangle([364, 170, 404, 210], fill=skin)
    d.polygon([(284, 210), (484, 210), (460, 560), (308, 560)], fill=shirt)
    d.line([(294, 225), (180, 430), (130, 610)], fill=shirt, width=56)
    d.line([(474, 225), (588, 430), (638, 610)], fill=shirt, width=56)
    d.ellipse([100, 590, 160, 660], fill=skin)
    d.ellipse([608, 590, 668, 660], fill=skin)
    d.polygon([(308, 550), (384, 550), (370, 1060), (310, 1060)], fill=pants)
    d.polygon([(384, 550), (460, 550), (458, 1060), (398, 1060)], fill=pants)
    d.rectangle([290, 1060, 372, 1100], fill=(30, 30, 30))
    d.rectangle([396, 1060, 478, 1100], fill=(30, 30, 30))
    return im


def fake_previews(glb_path):
    """Fake mode's voxels and shape, made from the fake GLB (faces +x, y up) like TRELLIS's (y up: faces +z)."""
    import numpy as np
    import trimesh

    mesh = trimesh.load(glb_path, force="mesh")
    v = np.asarray(mesh.vertices, dtype=np.float32)
    v = (v - (v.min(0) + v.max(0)) / 2) / (v.max(0) - v.min(0)).max()  # into the [-0.5, 0.5] cube
    yup = np.stack([-v[:, 2], v[:, 1], v[:, 0]], axis=1)  # turned to face +z, like TRELLIS's output
    trellis = np.stack([yup[:, 0], -yup[:, 2], yup[:, 1]], axis=1)  # y up -> z up (inverse of gen3d._to_y_up)
    coords = np.unique(np.clip(((trellis + 0.5) * 32).astype(int), 0, 31), axis=0).astype(np.uint8)
    return {"voxels": {"coords": coords, "resolution": 32}, "shape": {"vertices": yup, "faces": np.asarray(mesh.faces)}}


def load_face():
    """The face step's landmarker (any failure only turns the face step off)."""
    global face_finder
    if not os.path.exists(FACE_MODEL):
        log("face step off: no", FACE_MODEL)
        return
    try:
        from face_project import FaceFinder

        face_finder = FaceFinder(FACE_MODEL)
        log("face step", "on" if FACE_PROJECT else "available (FORGE3D_FACE_PROJECT=1 or a job's face: true)")
    except Exception as err:  # noqa: BLE001
        log("face step off, its landmarker didn't load:", err)


def load():
    global generator, landmarker
    try:
        start = time.time()
        from weights import ensure, prefetch

        if os.environ.get("FORGE3D_DOWNLOAD") == "1":  # the HF Space fetches its weights on the first start
            ensure(MODEL_DIR, POSE_MODEL)
            log(f"weights ready in {time.time() - start:.0f}s")
        if not os.environ.get("FORGE3D_FAKE_GLB"):
            prefetch(MODEL_DIR, SETTINGS["pipeline"])
        landmarker = Landmarker(POSE_MODEL)
        load_face()
        if os.environ.get("FORGE3D_FAKE_GLB"):
            # Dev mode without a GPU: every "generated" model is this GLB (the HTTP, landmark and rig steps are real).
            fake = fake_previews(os.environ["FORGE3D_FAKE_GLB"])

            def generator(_sheet, out_path, on_preview=None, **_settings):
                # The real thing's rhythm: voxels after ~1/4 of the time, the shape after ~1/2, then the model.
                pause = float(os.environ.get("FORGE3D_FAKE_SECONDS", 1)) / 4
                for kind in ("voxels", "shape"):
                    time.sleep(pause)
                    if on_preview:
                        on_preview(kind, fake[kind])
                time.sleep(pause * 2)
                shutil.copy(os.environ["FORGE3D_FAKE_GLB"], out_path)
                return {"generate": 0.0, "export": 0.0}
        else:
            from gen3d import Generator

            generator = Generator(MODEL_DIR, SETTINGS["pipeline"], SETTINGS["steps"], SETTINGS["faces"], SETTINGS["texture"])
        log(f"model loaded in {time.time() - start:.1f}s, warming up")
        warm_dir = os.path.join(WORK, "warmup")
        os.makedirs(warm_dir, exist_ok=True)
        sheet = warm_sheet()
        for i in range(WARMUPS):
            start = time.time()
            timings = generator(sheet, os.path.join(warm_dir, "raw.glb"))
            find_landmarks({"id": "warmup", "sheet": sheet, "dir": warm_dir})
            try:
                rig(warm_dir)
                timings["rig"] = "ok"
            except Exception as err:  # noqa: BLE001  (the crude figure may not rig; that's fine)
                timings["rig"] = f"failed ({str(err)[:80]})"
            log(f"warm-up {i + 1}: {time.time() - start:.1f}s", timings)
        if face_finder is not None and os.path.exists(os.path.join(warm_dir, "rigged.glb")):
            # The face step's first run pays its imports and the landmarker's setup; pay them now. (The crude figure
            # has no face to find, so this only exercises the code.)
            start = time.time()
            try:
                import face_project

                with open(os.path.join(warm_dir, "rigged.glb"), "rb") as f:
                    face_project.run(f.read(), sheet, face=face_finder)
                log(f"face step warm-up: {time.time() - start:.1f}s")
            except Exception as err:  # noqa: BLE001
                log("face step warm-up failed (the step stays on, it never fails a job):", err)
        state["ready"] = True
        log("ready")
    except Exception as err:  # noqa: BLE001
        traceback.print_exc()
        state["error"] = str(err)


class Handler(BaseHTTPRequestHandler):
    server_version = "forge3d"

    def log_message(self, fmt, *args):
        pass

    def send(self, status, body, ctype="application/json"):
        data = json.dumps(body).encode() if ctype == "application/json" else body
        self.send_response(status)
        self.send_header("content-type", ctype)
        self.send_header("content-length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def authorized(self):
        if KEY and hmac.compare_digest(self.headers.get("x-forge3d-key", ""), KEY):
            return True
        self.send(403, {"error": "bad key"})
        return False

    def do_GET(self):
        parts = [p for p in self.path.split("?")[0].split("/") if p]
        if parts == ["health"]:
            return self.send(200, {"ok": state["error"] is None, "ready": state["ready"], "error": state["error"],
                                   "queued": gpu_q.qsize() + rig_q.qsize(), "settings": SETTINGS})
        if not self.authorized():
            return
        state["used"] = time.time()
        if len(parts) >= 2 and parts[0] == "jobs":
            job = jobs.get(parts[1])
            if not job:
                return self.send(404, {"error": "no such job"})
            if len(parts) == 2:
                ahead = sum(1 for j in list(jobs.values()) if j["status"] == "queued" and j["created"] < job["created"])
                fields = ("status", "timings", "error", "rigged", "optimized", "report", "previews", "face")
                return self.send(200, {k: job.get(k) for k in fields} | {"queued": ahead})
            if len(parts) == 3 and parts[2] in ("rigged.glb", "rigged.orig.glb", "model.glb", "voxels.bin", "shape.glb"):
                path = os.path.join(job["dir"], parts[2])
                if not os.path.exists(path):
                    return self.send(404, {"error": "not ready"})
                with open(path, "rb") as f:
                    return self.send(200, f.read(), "application/octet-stream" if parts[2].endswith(".bin") else "model/gltf-binary")
        self.send(404, {"error": "not found"})

    def do_POST(self):
        path = self.path.split("?")[0].rstrip("/")
        if path not in ("/jobs", "/keepalive"):
            return self.send(404, {"error": "not found"})
        if not self.authorized():
            return
        state["used"] = time.time()
        if path == "/keepalive":
            # Someone's scanning: don't power off now (their forge reaches the box in ~30 s).
            return self.send(200, {"ok": state["error"] is None, "ready": state["ready"]})
        if not state["ready"]:
            return self.send(503, {"error": state["error"] or "warming up"})
        if gpu_q.qsize() >= MAX_QUEUED:
            return self.send(429, {"error": "queue full"})
        size = int(self.headers.get("content-length", 0))
        if size <= 0 or size > MAX_BODY:
            return self.send(413, {"error": "bad body size"})
        try:
            body = json.loads(self.rfile.read(size))
            raw = base64.b64decode(re.sub(r"^data:image/\w+;base64,", "", body["image"]))
            sheet = Image.open(io.BytesIO(raw))
            sheet.load()
            sheet = sheet.convert("RGBA" if sheet.mode in ("RGBA", "LA", "P") else "RGB")
            # Rig only: a model is already there (say Tripo's, whose rig failed), so skip TRELLIS.
            model = base64.b64decode(body["model"]) if body.get("model") else None
            if model is not None and model[:4] != b"glTF":
                raise ValueError("model must be a GLB")
        except Exception as err:  # noqa: BLE001
            return self.send(400, {"error": f"send {{image: base64 PNG/JPEG, model?: base64 GLB}}: {err}"})
        job_id = uuid.uuid4().hex
        job_dir = os.path.join(WORK, job_id)
        os.makedirs(job_dir)
        sheet.save(os.path.join(job_dir, "sheet.png"))
        job = {"id": job_id, "dir": job_dir, "sheet": sheet, "status": "queued", "created": time.time(), "timings": {}, "rigged": False,
               "previews": {}, "optimized": False}
        # rigAttempt 2+: the forge's rig check turned down this model's first rig, so weight it another way.
        if isinstance(body.get("rigAttempt"), int) and body["rigAttempt"] > 1:
            job["rig_attempt"] = min(body["rigAttempt"], 9)
        # Per-job generator settings (A/B tests without a restart): pipeline, steps, faces, texture, remesh.
        if isinstance(body.get("settings"), dict):
            job["settings"] = {k: v for k, v in body["settings"].items() if k in ("pipeline", "steps", "faces", "texture", "remesh")}
        # The face step: the box's default, or the job's own say (A/B tests, the face rescue).
        job["face_project"] = body["face"] if isinstance(body.get("face"), bool) else FACE_PROJECT
        if body.get("faceOnly") is True:
            if model is None:
                shutil.rmtree(job_dir, ignore_errors=True)
                return self.send(400, {"error": "faceOnly needs the rigged model"})
            job.update(face_only=True, face_project=True)
        with jobs_lock:
            jobs[job_id] = job
        if model is None:
            gpu_q.put(job)
        elif job.get("face_only"):
            # Face rescue: the model keeps its rig; only its texture changes (then the optimizer, like a forge).
            with open(os.path.join(job_dir, "rigged.glb"), "wb") as f:
                f.write(model)
            rig_q.put(job)
        else:
            with open(os.path.join(job_dir, "raw.glb"), "wb") as f:
                f.write(model)
            job["lm_thread"] = threading.Thread(target=find_landmarks, args=(job,), daemon=True)
            job["lm_thread"].start()
            rig_q.put(job)
        self.send(202, {"id": job_id})


if __name__ == "__main__":
    if not KEY:
        sys.exit("FORGE3D_KEY is not set")
    os.makedirs(WORK, exist_ok=True)
    threading.Thread(target=load, daemon=True).start()
    threading.Thread(target=gpu_worker, daemon=True).start()
    threading.Thread(target=rig_worker, daemon=True).start()
    threading.Thread(target=janitor, daemon=True).start()
    log(f"forge3d on {BIND}:{PORT}", SETTINGS)
    ThreadingHTTPServer((BIND, PORT), Handler).serve_forever()
