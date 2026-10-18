# The forge's GPU service (forge/gpu) as a Hugging Face Docker Space: TRELLIS.2 + MediaPipe + Blender rig on port
# 7860. Same versions and pins as forge/gpu/setup.sh. Builds without a GPU (the CUDA extensions are compiled for
# A100 / A10G / L40S); the weights (17 GB) are fetched on the first start into /data (persistent storage, if the
# Space has it) by weights.py, then the service warms up.
FROM nvidia/cuda:12.4.1-cudnn-devel-ubuntu22.04

ENV DEBIAN_FRONTEND=noninteractive PYTHONUNBUFFERED=1 PIP_NO_CACHE_DIR=1 \
    CUDA_HOME=/usr/local/cuda TORCH_CUDA_ARCH_LIST="8.0;8.6;8.9" NVCC_APPEND_FLAGS="--extended-lambda" BUILD_TARGET=cuda

RUN apt-get update && apt-get install -y --no-install-recommends \
      python3.10 python3.10-dev python3-pip git curl ca-certificates xz-utils build-essential ninja-build \
      libjpeg-dev zlib1g-dev libgl1 libglib2.0-0 libegl1 libxi6 libxkbcommon0 libxrender1 libxfixes3 libxxf86vm1 \
      libsm6 libice6 libx11-6 libxext6 \
    && rm -rf /var/lib/apt/lists/* && ln -sf /usr/bin/python3.10 /usr/local/bin/python

RUN python -m pip install --upgrade pip setuptools wheel \
    && python -m pip install torch==2.6.0 torchvision==0.21.0 --index-url https://download.pytorch.org/whl/cu124
RUN python -m pip install imageio imageio-ffmpeg tqdm easydict opencv-python-headless ninja trimesh transformers pandas \
      zstandard kornia "timm>=1.0.20" pillow mediapipe huggingface_hub hf_transfer safetensors plyfile \
      "git+https://github.com/EasternJournalist/utils3d.git@9a4eb15e4021b67b12c460c7057d642626897ec8" \
      "https://github.com/Dao-AILab/flash-attention/releases/download/v2.7.4.post1/flash_attn-2.7.4.post1+cu12torch2.6cxx11abiFALSE-cp310-cp310-linux_x86_64.whl"

RUN git clone https://github.com/microsoft/TRELLIS.2.git /opt/TRELLIS.2 \
    && git -C /opt/TRELLIS.2 checkout 75fbf0183001ed9876c8dbb35de6b68552ee08bd \
    && git -C /opt/TRELLIS.2 submodule update --init --recursive

# TRELLIS.2's CUDA extensions, one layer each so a rebuild resumes where it stopped.
WORKDIR /tmp/ext
RUN git clone -b v0.4.0 https://github.com/NVlabs/nvdiffrast.git && pip install ./nvdiffrast --no-build-isolation && rm -rf nvdiffrast
RUN git clone https://github.com/JeffreyXiang/nvdiffrec.git && git -C nvdiffrec checkout b296927cc7fd01c2ac1087c8065c4d7248f72da4 \
    && pip install ./nvdiffrec --no-build-isolation && rm -rf nvdiffrec
RUN git clone --recursive https://github.com/JeffreyXiang/CuMesh.git && git -C CuMesh checkout 12289e1062f0603f2f0d0771b02e1395d247f26f \
    && git -C CuMesh submodule update --init --recursive && MAX_JOBS=$(nproc) pip install ./CuMesh --no-build-isolation && rm -rf CuMesh
RUN git clone --recursive https://github.com/JeffreyXiang/FlexGEMM.git && git -C FlexGEMM checkout 6dd94a859c26ee8246888502eada3dd8ad85532e \
    && git -C FlexGEMM submodule update --init --recursive && MAX_JOBS=$(nproc) pip install ./FlexGEMM --no-build-isolation && rm -rf FlexGEMM
RUN cp -r /opt/TRELLIS.2/o-voxel ./o-voxel && MAX_JOBS=$(nproc) pip install ./o-voxel --no-build-isolation && rm -rf o-voxel

RUN curl -sSfL https://download.blender.org/release/Blender5.2/blender-5.2.1-linux-x64.tar.xz | tar -xJ -C /opt \
    && mv /opt/blender-5.2.1-linux-x64 /opt/blender

# Spaces run as uid 1000. /data is the persistent disk when the Space has one (a plain folder otherwise).
RUN useradd -m -u 1000 user && mkdir -p /data /tmp/forge3d && chown -R user /data /tmp/forge3d
USER user
ENV HOME=/home/user PYTHONPATH=/opt/TRELLIS.2 HF_HOME=/data/hf HF_HUB_ENABLE_HF_TRANSFER=1 \
    FORGE3D_PORT=7860 FORGE3D_DOWNLOAD=1 FORGE3D_BLENDER=/opt/blender/blender FORGE3D_WORK=/tmp/forge3d/jobs \
    FORGE3D_MODEL_DIR=/data/models/TRELLIS.2-4B FORGE3D_POSE_MODEL=/data/models/pose_landmarker_heavy.task
WORKDIR /app
COPY --chown=user *.py /app/
EXPOSE 7860
CMD ["python", "/app/server.py"]
