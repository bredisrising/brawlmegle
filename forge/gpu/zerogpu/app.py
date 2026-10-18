"""
The forge's GPU service as a private ZeroGPU Gradio Space (see README.md here and forge/gpu/README.md).

One API endpoint, /forge3d: the model sheet (base64 PNG/JPEG) in, a Mixamo-rigged GLB out. It streams its steps
("model", then "rig") and ends with the rigged GLB and the timings. Only TRELLIS.2 (generation + GLB bake, which
needs CUDA) holds the GPU; the sheet landmarks, the Blender rig and the files run on the Space's CPU.
"""
import base64
import io
import os
import re
import shutil
import tarfile
import threading
import time
import urllib.request
import uuid

HERE = os.path.dirname(os.path.abspath(__file__))
DATA = os.environ.get("FORGE3D_DATA", "/data" if os.access("/data", os.W_OK) else os.path.join(HERE, "data"))
BLENDER_DIR = os.path.join(DATA, "blender-5.2.1-linux-x64")
os.environ.setdefault("FORGE3D_BLENDER", os.path.join(BLENDER_DIR, "blender"))
os.environ.setdefault("FORGE3D_MODEL_DIR", os.path.join(DATA, "models", "TRELLIS.2-4B"))
os.environ.setdefault("FORGE3D_POSE_MODEL", os.path.join(DATA, "models", "pose_landmarker_heavy.task"))
os.environ.setdefault("FORGE3D_WORK", "/tmp/forge3d/jobs")
os.environ.setdefault("FORGE3D_KEY", "")
os.environ["FLEX_GEMM_AUTOTUNE_CACHE_PATH"] = os.path.join(HERE, "autotune_cache.json")
os.environ.setdefault("HF_HUB_ENABLE_HF_TRANSFER", "1")

import gradio as gr  # noqa: E402
import spaces  # noqa: E402
from PIL import Image  # noqa: E402

import server as core  # noqa: E402  (forge/gpu/server.py: settings, landmarks, Blender rig)
from weights import ensure  # noqa: E402


def blender():
    if not os.path.exists(os.environ["FORGE3D_BLENDER"]):
        url = "https://download.blender.org/release/Blender5.2/blender-5.2.1-linux-x64.tar.xz"
        with urllib.request.urlopen(url) as res, tarfile.open(fileobj=res, mode="r|xz") as tar:
            tar.extractall(DATA)


start = time.time()
os.makedirs(core.WORK, exist_ok=True)
FAKE = os.environ.get("FORGE3D_FAKE_GLB")  # dev mode without a GPU: every "generated" model is this GLB
ensure(core.MODEL_DIR, core.POSE_MODEL, trellis=not FAKE)
blender()
core.landmarker = core.Landmarker(core.POSE_MODEL)
S = core.SETTINGS
if FAKE:
    def generator(_sheet, out_path):
        shutil.copy(FAKE, out_path)
        return {"generate": 0.0, "export": 0.0}
else:
    from gen3d import Generator

    generator = Generator(core.MODEL_DIR, S["pipeline"], S["steps"], S["faces"], S["texture"])
print(f"forge3d loaded in {time.time() - start:.0f}s", S, flush=True)


@spaces.GPU(duration=int(os.environ.get("FORGE3D_GPU_SECONDS", 90)))
def generate(sheet: Image.Image, out_path: str) -> dict:
    return generator(sheet, out_path)


def forge3d(image_b64: str, request: gr.Request):
    """Model sheet (base64) -> rigged GLB. Yields (file, status) as it goes."""
    if core.KEY and request is not None and request.headers.get("x-forge3d-key", "") != core.KEY:
        raise gr.Error("bad key")
    t0 = time.time()
    raw = base64.b64decode(re.sub(r"^data:image/\w+;base64,", "", image_b64))
    sheet = Image.open(io.BytesIO(raw))
    sheet.load()
    sheet = sheet.convert("RGBA" if sheet.mode in ("RGBA", "LA", "P") else "RGB")
    job = {"id": uuid.uuid4().hex, "sheet": sheet, "timings": {}}
    job["dir"] = os.path.join(core.WORK, job["id"])
    os.makedirs(job["dir"])
    lm = threading.Thread(target=core.find_landmarks, args=(job,), daemon=True)
    lm.start()
    yield None, {"status": "model"}
    t = time.time()
    job["timings"].update(generate(sheet, os.path.join(job["dir"], "raw.glb")))
    job["timings"]["model"] = round(time.time() - t, 2)  # includes waiting for a ZeroGPU slot
    yield None, {"status": "rig", "timings": job["timings"]}
    t = time.time()
    lm.join()
    report = core.rig(job["dir"])
    job["timings"]["rig"] = round(time.time() - t, 2)
    job["timings"]["total"] = round(time.time() - t0, 2)
    out = os.path.join(core.WORK, f"{job['id']}-rigged.glb")
    shutil.move(os.path.join(job["dir"], "rigged.glb"), out)
    shutil.rmtree(job["dir"], ignore_errors=True)
    print(job["id"][:8], "done", job["timings"], flush=True)
    yield out, {"status": "done", "timings": job["timings"], "report": report}


with gr.Blocks(title="Brawlegle forge 3D", delete_cache=(600, 900)) as demo:
    gr.Markdown("Private API for the Brawlegle forge: model sheet in, Mixamo-rigged GLB out (`/forge3d`).")
    sheet_in = gr.Textbox(label="model sheet (base64 PNG/JPEG)", lines=2)
    glb_out = gr.File(label="rigged.glb")
    status_out = gr.JSON(label="status")
    gr.Button("Forge").click(forge3d, inputs=[sheet_in], outputs=[glb_out, status_out], api_name="forge3d")

demo.queue(default_concurrency_limit=4).launch(allowed_paths=[core.WORK], show_error=True)
