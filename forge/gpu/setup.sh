#!/bin/bash
# Sets up the forge's GPU box: TRELLIS.2 (image -> textured 3D), MediaPipe + Blender (rig), the HTTP service.
# Run on an AWS "Deep Learning Base OSS Nvidia Driver GPU AMI (Ubuntu 22.04)" instance (L40S / A10G):
#
#   scp -r forge/gpu ubuntu@BOX:forge-gpu && ssh ubuntu@BOX 'sudo bash forge-gpu/setup.sh'
#
# Safe to re-run (each step skips what's already there). Takes about 30-40 min the first time, mostly compiling
# TRELLIS.2's CUDA extensions and downloading 17 GB of weights. The service key goes in /etc/forge3d.env
# (generated on the first run; read it with: sudo grep KEY /etc/forge3d.env).
set -euo pipefail
SRC="$(cd "$(dirname "$0")" && pwd)"
ROOT=/opt/forge3d
CONDA=$ROOT/conda
ENV=$CONDA/envs/trellis2
PY=$ENV/bin/python
TRELLIS_COMMIT=75fbf0183001ed9876c8dbb35de6b68552ee08bd
BLENDER_URL=https://download.blender.org/release/Blender5.2/blender-5.2.1-linux-x64.tar.xz
POSE_URL=https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_heavy/float16/1/pose_landmarker_heavy.task
mkdir -p $ROOT/models /var/lib/forge3d/jobs
export DEBIAN_FRONTEND=noninteractive

echo "== system packages"
apt-get update -q
apt-get install -y -q git git-lfs libjpeg-dev zlib1g-dev libgl1 libglib2.0-0 libegl1 libxi6 libxkbcommon0 libxrender1 \
  libxfixes3 libxxf86vm1 libsm6 libice6 libx11-6 libxext6 xz-utils >/dev/null

# The newest CUDA 12 toolkit on the AMI compiles the extensions (torch is cu124; only the major version must match).
CUDA_HOME=$(ls -d /usr/local/cuda-12.4 2>/dev/null || ls -d /usr/local/cuda-12.* | sort -V | tail -1)
export CUDA_HOME PATH=$CUDA_HOME/bin:$PATH
export TORCH_CUDA_ARCH_LIST="8.6;8.9" NVCC_APPEND_FLAGS="--extended-lambda" MAX_JOBS=$(nproc)
echo "== CUDA $CUDA_HOME, $(nproc) cores"

if [ ! -x $CONDA/bin/conda ]; then
  echo "== miniforge"
  curl -sSfL -o /tmp/miniforge.sh https://github.com/conda-forge/miniforge/releases/latest/download/Miniforge3-Linux-x86_64.sh
  bash /tmp/miniforge.sh -b -p $CONDA
fi
if [ ! -x $PY ]; then
  $CONDA/bin/conda create -y -q -n trellis2 python=3.10
fi
PIP="$PY -m pip install -q"

if ! $PY -c "import torch" 2>/dev/null; then
  echo "== torch"
  $PIP torch==2.6.0 torchvision==0.21.0 --index-url https://download.pytorch.org/whl/cu124
fi

if [ ! -d $ROOT/TRELLIS.2/.git ]; then
  echo "== TRELLIS.2"
  git clone -q --recursive https://github.com/microsoft/TRELLIS.2.git $ROOT/TRELLIS.2
  git -C $ROOT/TRELLIS.2 checkout -q $TRELLIS_COMMIT
fi

echo "== python packages"
$PIP imageio imageio-ffmpeg tqdm easydict opencv-python-headless ninja trimesh transformers tensorboard pandas lpips zstandard \
  kornia "timm>=1.0.20" pillow mediapipe huggingface_hub hf_transfer safetensors plyfile
$PIP "git+https://github.com/EasternJournalist/utils3d.git@9a4eb15e4021b67b12c460c7057d642626897ec8"

if ! $PY -c "import flash_attn" 2>/dev/null; then
  echo "== flash-attn (prebuilt wheel)"
  $PIP "https://github.com/Dao-AILab/flash-attention/releases/download/v2.7.4.post1/flash_attn-2.7.4.post1+cu12torch2.6cxx11abiFALSE-cp310-cp310-linux_x86_64.whl" \
    || $PIP xformers==0.0.29.post3 --index-url https://download.pytorch.org/whl/cu124
fi

build() {  # name, import name, repo url or local dir, [branch]
  if ! $PY -c "import $2" 2>/dev/null; then
    echo "== build $1"
    rm -rf /tmp/ext/$1 && mkdir -p /tmp/ext
    if [ -d "$3" ]; then cp -r "$3" /tmp/ext/$1; else git clone -q --recursive ${4:+-b $4} "$3" /tmp/ext/$1; fi
    (cd /tmp/ext && $PY -m pip install -q /tmp/ext/$1 --no-build-isolation)
  fi
}
build nvdiffrast nvdiffrast https://github.com/NVlabs/nvdiffrast.git v0.4.0
build nvdiffrec nvdiffrec_render https://github.com/JeffreyXiang/nvdiffrec.git renderutils
build CuMesh cumesh https://github.com/JeffreyXiang/CuMesh.git
build FlexGEMM flex_gemm https://github.com/JeffreyXiang/FlexGEMM.git
build o-voxel o_voxel $ROOT/TRELLIS.2/o-voxel

echo "== weights"
export HF_HUB_ENABLE_HF_TRANSFER=1 HF_HOME=$ROOT/hf
$PY - <<'EOF'
import json, os
from huggingface_hub import hf_hub_download, snapshot_download
root = "/opt/forge3d/models/TRELLIS.2-4B"
snapshot_download("microsoft/TRELLIS.2-4B", local_dir=root)
for ext in ("json", "safetensors"):
    hf_hub_download("microsoft/TRELLIS-image-large", f"ckpts/ss_dec_conv3d_16l8_fp16.{ext}")
snapshot_download("timm/vit_large_patch16_dinov3.lvd1689m")
snapshot_download("ZhengPeng7/BiRefNet")
# DINOv3 from timm's ungated copy, background removal with MIT BiRefNet (see gen3d.py).
p = f"{root}/pipeline.json"
cfg = json.load(open(p))
cfg["args"]["image_cond_model"] = {"name": "TimmDinoV3FeatureExtractor", "args": {"model_name": "timm/vit_large_patch16_dinov3.lvd1689m"}}
cfg["args"]["rembg_model"] = {"name": "BiRefNet", "args": {"model_name": "ZhengPeng7/BiRefNet"}}
json.dump(cfg, open(p, "w"), indent=4)
print("pipeline.json patched")
EOF
[ -f $ROOT/models/pose_landmarker_heavy.task ] || curl -sSfL -o $ROOT/models/pose_landmarker_heavy.task $POSE_URL

if [ ! -x $ROOT/blender/blender ]; then
  echo "== Blender"
  curl -sSfL $BLENDER_URL | tar -xJ -C $ROOT
  rm -rf $ROOT/blender && mv $ROOT/blender-5.2.1-linux-x64 $ROOT/blender
fi

echo "== service"
mkdir -p $ROOT/app
cp "$SRC"/server.py "$SRC"/gen3d.py "$SRC"/landmarks.py "$SRC"/rig_blender.py $ROOT/app/
if [ ! -f /etc/forge3d.env ]; then
  umask 077
  cat > /etc/forge3d.env <<EOF
FORGE3D_KEY=$(openssl rand -hex 24)
FORGE3D_PORT=8790
FORGE3D_PIPELINE=1024_cascade
FORGE3D_STEPS=12
FORGE3D_FACES=60000
FORGE3D_TEXTURE=2048
EOF
fi
cp "$SRC"/forge3d.service /etc/systemd/system/forge3d.service
systemctl daemon-reload
systemctl enable -q forge3d
systemctl restart forge3d
echo "== done. Follow the warm-up with: journalctl -u forge3d -f"
