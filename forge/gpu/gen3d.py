"""
Model sheet -> textured GLB with Microsoft TRELLIS.2-4B (MIT), kept loaded on the GPU.

Two swaps from the stock pipeline.json, so nothing gated or non-commercial is needed (setup.sh writes them):
  - image features: DINOv3 ViT-L/16 from timm's ungated copy (timm/vit_large_patch16_dinov3.lvd1689m, same weights
    and license as facebook/dinov3-vitl16-pretrain-lvd1689m, which is behind a manual approval)
  - background removal: ZhengPeng7/BiRefNet (MIT) instead of briaai/RMBG-2.0 (non-commercial)
"""
import os
import time

os.environ.setdefault("PYTORCH_CUDA_ALLOC_CONF", "expandable_segments:True")
os.environ.setdefault("OPENCV_IO_ENABLE_OPENEXR", "1")

import numpy as np
import torch
import torch.nn.functional as F
from PIL import Image


class TimmDinoV3FeatureExtractor:
    """Drop-in for trellis2's DinoV3FeatureExtractor: every token (cls, registers, patches) after the last block,
    layer-normed without affine, like the original."""

    def __init__(self, model_name: str = "timm/vit_large_patch16_dinov3.lvd1689m", image_size: int = 512):
        import timm

        self.model = timm.create_model(f"hf-hub:{model_name}", pretrained=True, dynamic_img_size=True)
        self.model.eval()
        self.image_size = image_size
        self.mean = torch.tensor([0.485, 0.456, 0.406]).view(1, 3, 1, 1)
        self.std = torch.tensor([0.229, 0.224, 0.225]).view(1, 3, 1, 1)

    def to(self, device):
        self.model.to(device)

    def cuda(self):
        self.model.cuda()

    def cpu(self):
        self.model.cpu()

    def extract_features(self, image: torch.Tensor) -> torch.Tensor:
        m = self.model
        x = m.patch_embed(image.to(next(m.parameters()).dtype))
        x, rope = m._pos_embed(x)
        x = m.norm_pre(x)
        for blk in m.blocks:
            x = blk(x, rope=rope)
        return F.layer_norm(x, x.shape[-1:])

    @torch.no_grad()
    def __call__(self, image) -> torch.Tensor:
        if isinstance(image, list):
            image = [i.resize((self.image_size, self.image_size), Image.LANCZOS) for i in image]
            image = [torch.from_numpy(np.array(i.convert("RGB")).astype(np.float32) / 255).permute(2, 0, 1) for i in image]
            image = torch.stack(image)
        image = image.cuda()
        image = (image - self.mean.to(image.device)) / self.std.to(image.device)
        return self.extract_features(image)


class Generator:
    def __init__(self, model_dir: str, pipeline_type: str = "1024_cascade", steps: int = 12, faces: int = 60000, texture: int = 2048):
        import trellis2.modules.image_feature_extractor as fe

        fe.TimmDinoV3FeatureExtractor = TimmDinoV3FeatureExtractor
        from trellis2.pipelines import Trellis2ImageTo3DPipeline

        self.pipe = Trellis2ImageTo3DPipeline.from_pretrained(model_dir)
        self.pipe.cuda()
        self.pipeline_type = pipeline_type
        self.steps = steps
        self.faces = faces
        self.texture = texture

    @torch.inference_mode()
    def __call__(self, image: Image.Image, out_path: str, seed: int = 42) -> dict:
        import o_voxel

        timings = {}
        t = time.time()
        sampler = {"steps": self.steps}
        mesh = self.pipe.run(
            image,
            seed=seed,
            pipeline_type=self.pipeline_type,
            sparse_structure_sampler_params=sampler,
            shape_slat_sampler_params=sampler,
            tex_slat_sampler_params=sampler,
        )[0]
        torch.cuda.synchronize()
        timings["generate"] = round(time.time() - t, 2)
        t = time.time()
        mesh.simplify(16777216)  # nvdiffrast limit
        glb = o_voxel.postprocess.to_glb(
            vertices=mesh.vertices,
            faces=mesh.faces,
            attr_volume=mesh.attrs,
            coords=mesh.coords,
            attr_layout=mesh.layout,
            voxel_size=mesh.voxel_size,
            aabb=[[-0.5, -0.5, -0.5], [0.5, 0.5, 0.5]],
            decimation_target=self.faces,
            texture_size=self.texture,
            remesh=True,
            remesh_band=1,
            remesh_project=0,
        )
        glb.export(out_path, extension_webp=False)
        timings["export"] = round(time.time() - t, 2)
        del mesh
        torch.cuda.empty_cache()
        return timings
