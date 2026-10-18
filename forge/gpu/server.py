"""
Forge 3D service: model sheet in, Mixamo-rigged GLB out, on one GPU box (see README.md).

    POST /jobs                 {"image": base64 PNG/JPEG model sheet, "model"?: base64 GLB to rig only}  ->  202 {"id"}
    GET  /jobs/<id>            ->  {"status": queued|model|rig|done|failed, "timings", "error", "rigged", "queued"}
    GET  /jobs/<id>/rigged.glb ->  the rigged model (model.glb: the same model without a skeleton)
    GET  /health               ->  {"ok", "ready", "queued", "settings"}

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
WORK = os.environ.get("FORGE3D_WORK", "/var/lib/forge3d/jobs")
SETTINGS = {
    "pipeline": os.environ.get("FORGE3D_PIPELINE", "1024_cascade"),
    "steps": int(os.environ.get("FORGE3D_STEPS", 12)),
    "faces": int(os.environ.get("FORGE3D_FACES", 60000)),
    "texture": int(os.environ.get("FORGE3D_TEXTURE", 2048)),
    "yaw": float(os.environ.get("FORGE3D_YAW", 0)),
}
MAX_QUEUED = int(os.environ.get("FORGE3D_MAX_QUEUED", 6))
JOB_TTL = 15 * 60
MAX_BODY = 30 * 1024 * 1024

jobs: dict[str, dict] = {}
jobs_lock = threading.Lock()
gpu_q: "queue.Queue[dict]" = queue.Queue()
rig_q: "queue.Queue[dict]" = queue.Queue()
state = {"ready": False, "error": None}
generator = None
landmarker = None
landmark_lock = threading.Lock()


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


def gpu_worker():
    while True:
        job = gpu_q.get()
        try:
            job["status"] = "model"
            start = time.time()
            job["lm_thread"] = threading.Thread(target=find_landmarks, args=(job,), daemon=True)
            job["lm_thread"].start()
            job["timings"].update(generator(job["sheet"], os.path.join(job["dir"], "raw.glb")))
            job["timings"]["model"] = round(time.time() - start, 2)
            rig_q.put(job)
        except Exception as err:  # noqa: BLE001
            traceback.print_exc()
            job.update(status="failed", error=f"model: {err}")


def rig(job_dir, out_name="rigged.glb"):
    """Blender rig step. Returns the rigger's report, raises on failure."""
    cmd = [BLENDER, "-b", "--factory-startup", "--python-exit-code", "1", "-P", os.path.join(HERE, "rig_blender.py"), "--",
           os.path.join(job_dir, "raw.glb"), os.path.join(job_dir, "landmarks.json"), os.path.join(job_dir, out_name),
           "--static", os.path.join(job_dir, "model.glb"), "--yaw", str(SETTINGS["yaw"])]
    # Without a display: Blender stalls ~30 s at startup when it can see one (WSLg), even in background mode.
    env = {k: v for k, v in os.environ.items() if k not in ("DISPLAY", "WAYLAND_DISPLAY")}
    out = subprocess.run(cmd, capture_output=True, text=True, timeout=120, env=env)
    report = re.search(r"^RIG_RESULT (.*)$", out.stdout, re.M)
    if out.returncode != 0 or not report:
        tail = (out.stderr or out.stdout)[-600:]
        raise RuntimeError(f"blender exited {out.returncode}: {tail}")
    return json.loads(report.group(1))


def rig_worker():
    while True:
        job = rig_q.get()
        try:
            job["status"] = "rig"
            start = time.time()
            job["lm_thread"].join()
            job["report"] = rig(job["dir"])
            job["timings"]["rig"] = round(time.time() - start, 2)
            job["rigged"] = True
            job["status"] = "done"
        except Exception as err:  # noqa: BLE001
            traceback.print_exc()
            job.update(status="failed", error=f"rig: {err}")
        job["timings"]["total"] = round(time.time() - job["created"], 2)
        log(job["id"][:8], job["status"], job["timings"], job.get("error", ""))


def janitor():
    while True:
        time.sleep(60)
        now = time.time()
        with jobs_lock:
            old = [i for i, j in jobs.items() if now - j["created"] > JOB_TTL]
            for i in old:
                shutil.rmtree(jobs.pop(i)["dir"], ignore_errors=True)


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


def load():
    global generator, landmarker
    try:
        start = time.time()
        if os.environ.get("FORGE3D_DOWNLOAD") == "1":  # the HF Space fetches its weights on the first start
            from weights import ensure

            ensure(MODEL_DIR, POSE_MODEL)
            log(f"weights ready in {time.time() - start:.0f}s")
        landmarker = Landmarker(POSE_MODEL)
        if os.environ.get("FORGE3D_FAKE_GLB"):
            # Dev mode without a GPU: every "generated" model is this GLB (the HTTP, landmark and rig steps are real).
            def generator(_sheet, out_path):
                time.sleep(float(os.environ.get("FORGE3D_FAKE_SECONDS", 1)))
                shutil.copy(os.environ["FORGE3D_FAKE_GLB"], out_path)
                return {"generate": 0.0, "export": 0.0}
        else:
            from gen3d import Generator

            generator = Generator(MODEL_DIR, SETTINGS["pipeline"], SETTINGS["steps"], SETTINGS["faces"], SETTINGS["texture"])
        log(f"model loaded in {time.time() - start:.1f}s, warming up")
        warm_dir = os.path.join(WORK, "warmup")
        os.makedirs(warm_dir, exist_ok=True)
        sheet = warm_sheet()
        for i in range(2):  # the second run shows the steady-state time
            start = time.time()
            timings = generator(sheet, os.path.join(warm_dir, "raw.glb"))
            find_landmarks({"id": "warmup", "sheet": sheet, "dir": warm_dir})
            try:
                rig(warm_dir)
                timings["rig"] = "ok"
            except Exception as err:  # noqa: BLE001  (the crude figure may not rig; that's fine)
                timings["rig"] = f"failed ({str(err)[:80]})"
            log(f"warm-up {i + 1}: {time.time() - start:.1f}s", timings)
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
        if len(parts) >= 2 and parts[0] == "jobs":
            job = jobs.get(parts[1])
            if not job:
                return self.send(404, {"error": "no such job"})
            if len(parts) == 2:
                ahead = sum(1 for j in list(jobs.values()) if j["status"] == "queued" and j["created"] < job["created"])
                return self.send(200, {k: job.get(k) for k in ("status", "timings", "error", "rigged", "report")} | {"queued": ahead})
            if len(parts) == 3 and parts[2] in ("rigged.glb", "model.glb"):
                path = os.path.join(job["dir"], parts[2])
                if not os.path.exists(path):
                    return self.send(404, {"error": "not ready"})
                with open(path, "rb") as f:
                    return self.send(200, f.read(), "model/gltf-binary")
        self.send(404, {"error": "not found"})

    def do_POST(self):
        if self.path.split("?")[0].rstrip("/") != "/jobs":
            return self.send(404, {"error": "not found"})
        if not self.authorized():
            return
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
        job = {"id": job_id, "dir": job_dir, "sheet": sheet, "status": "queued", "created": time.time(), "timings": {}, "rigged": False}
        with jobs_lock:
            jobs[job_id] = job
        if model is None:
            gpu_q.put(job)
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
