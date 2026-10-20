"""
Downloads every model the service needs and patches TRELLIS.2's pipeline.json to the open swaps (see gen3d.py):

    python weights.py MODEL_DIR POSE_MODEL_PATH

Skips what's already there, so it's cheap to call at every start (the HF Space does).
"""
import glob
import json
import os
import sys
import threading
import urllib.request

POSE_URL = "https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_heavy/float16/1/pose_landmarker_heavy.task"
# The face step's landmarker (face_project.py), saved next to the pose model.
FACE_URL = "https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task"


def ensure(model_dir: str, pose_path: str, trellis: bool = True) -> None:
    os.environ.setdefault("HF_HUB_ENABLE_HF_TRANSFER", "1")
    from huggingface_hub import hf_hub_download, snapshot_download

    done = os.path.join(model_dir, ".forge3d-ready")
    if trellis and not os.path.exists(done):
        snapshot_download("microsoft/TRELLIS.2-4B", local_dir=model_dir)
        for ext in ("json", "safetensors"):
            hf_hub_download("microsoft/TRELLIS-image-large", f"ckpts/ss_dec_conv3d_16l8_fp16.{ext}")
        snapshot_download("timm/vit_large_patch16_dinov3.lvd1689m")
        snapshot_download("ZhengPeng7/BiRefNet")
        path = os.path.join(model_dir, "pipeline.json")
        with open(path) as f:
            cfg = json.load(f)
        # DINOv3 from timm's ungated copy (same weights), background removal with MIT BiRefNet instead of RMBG-2.0.
        cfg["args"]["image_cond_model"] = {"name": "TimmDinoV3FeatureExtractor", "args": {"model_name": "timm/vit_large_patch16_dinov3.lvd1689m"}}
        cfg["args"]["rembg_model"] = {"name": "BiRefNet", "args": {"model_name": "ZhengPeng7/BiRefNet"}}
        with open(path, "w") as f:
            json.dump(cfg, f, indent=4)
        open(done, "w").close()
    face_path = os.path.join(os.path.dirname(pose_path), "face_landmarker.task")
    for url, path in ((POSE_URL, pose_path), (FACE_URL, face_path)):
        if not os.path.exists(path):
            os.makedirs(os.path.dirname(path), exist_ok=True)
            urllib.request.urlretrieve(url, path + ".part")
            os.replace(path + ".part", path)


# The models each pipeline type runs that the others don't: gen3d.py loads only its type's, and the rest when a job
# asks for that type.
ONLY_FOR = {"tex_slat_flow_model_512": "512", "shape_slat_flow_model_512": "512 1024_cascade 1536_cascade",
            "shape_slat_flow_model_1024": "1024 1024_cascade 1536_cascade", "tex_slat_flow_model_1024": "1024 1024_cascade 1536_cascade"}


def prefetch(model_dir: str, pipeline_type: str, threads: int = 4) -> None:
    """Reads the weights a start will load into the page cache, in the background and in load order, while Python's
    still importing torch and TRELLIS. A cold start is mostly reading ~16 GB off the EBS disk, and it reads ~550 MB/s
    four files at a time against ~335 one at a time."""
    try:
        with open(os.path.join(model_dir, "pipeline.json")) as f:
            names = json.load(f)["args"]["models"]
    except OSError:
        return
    files = [os.path.join(model_dir, f"{v}.safetensors") for k, v in names.items() if pipeline_type in ONLY_FOR.get(k, pipeline_type).split()]
    # The rest is in the HF cache (DINOv3, BiRefNet, TRELLIS v1's structure decoder).
    hub = os.path.join(os.environ.get("HF_HOME", os.path.expanduser("~/.cache/huggingface")), "hub")
    files += sorted(glob.glob(os.path.join(hub, "models--*", "snapshots", "*", "**", "*.safetensors"), recursive=True))
    todo = iter([f for f in files if os.path.exists(f)])
    lock = threading.Lock()

    def read():
        while True:
            with lock:
                path = next(todo, None)
            if path is None:
                return
            with open(path, "rb", buffering=0) as f:
                while f.read(16 << 20):
                    pass

    for _ in range(threads):
        threading.Thread(target=read, daemon=True).start()


if __name__ == "__main__":
    ensure(sys.argv[1], sys.argv[2])
    print("weights ready")
