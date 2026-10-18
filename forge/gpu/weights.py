"""
Downloads every model the service needs and patches TRELLIS.2's pipeline.json to the open swaps (see gen3d.py):

    python weights.py MODEL_DIR POSE_MODEL_PATH

Skips what's already there, so it's cheap to call at every start (the HF Space does).
"""
import json
import os
import sys
import urllib.request

POSE_URL = "https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_heavy/float16/1/pose_landmarker_heavy.task"


def ensure(model_dir: str, pose_path: str) -> None:
    os.environ.setdefault("HF_HUB_ENABLE_HF_TRANSFER", "1")
    from huggingface_hub import hf_hub_download, snapshot_download

    done = os.path.join(model_dir, ".forge3d-ready")
    if not os.path.exists(done):
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
    if not os.path.exists(pose_path):
        os.makedirs(os.path.dirname(pose_path), exist_ok=True)
        urllib.request.urlretrieve(POSE_URL, pose_path + ".part")
        os.replace(pose_path + ".part", pose_path)


if __name__ == "__main__":
    ensure(sys.argv[1], sys.argv[2])
    print("weights ready")
