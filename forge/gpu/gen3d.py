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


def _to_y_up(v):
    """TRELLIS works z-up in a [-0.5, 0.5] cube; the GLB (and the game) is y-up. Same turn as o_voxel's to_glb."""
    return torch.stack([v[:, 0], v[:, 2], -v[:, 1]], dim=1)


class Generator:
    def __init__(self, model_dir: str, pipeline_type: str = "1024_cascade", steps: int = 12, faces: int = 60000, texture: int = 2048):
        import trellis2.modules.image_feature_extractor as fe

        fe.TimmDinoV3FeatureExtractor = TimmDinoV3FeatureExtractor
        from trellis2.pipelines import Trellis2ImageTo3DPipeline

        self.pipe = Trellis2ImageTo3DPipeline.from_pretrained(model_dir)
        # TRELLIS.2 defaults to moving each model onto the GPU only while it runs. A 48 GB card holds them all, which
        # saves seconds per stage; FORGE3D_LOW_VRAM=1 for small cards (8-24 GB).
        self.pipe.low_vram = os.environ.get("FORGE3D_LOW_VRAM", "0") == "1"
        # ZhengPeng7/BiRefNet loads in fp16, but TRELLIS.2's wrapper feeds it fp32 images.
        if getattr(self.pipe.rembg_model, "model", None) is not None:
            self.pipe.rembg_model.model.float()
        self.pipe.cuda()
        self.settings = {"pipeline": pipeline_type, "steps": steps, "faces": faces, "texture": texture,
                         "remesh": os.environ.get("FORGE3D_REMESH", "1") == "1"}

    def _hooks(self, on_preview):
        """Wraps the pipeline's stages for this run: reports the sparse voxels and the untextured shape as soon as
        they exist, and decodes the shape once (early) instead of again in decode_latent."""
        pipe = self.pipe
        originals = {name: getattr(pipe, name) for name in ("sample_sparse_structure", "sample_shape_slat", "sample_shape_slat_cascade", "decode_shape_slat")}
        early = {}

        def sparse(*args, **kwargs):
            coords = originals["sample_sparse_structure"](*args, **kwargs)
            res = args[1] if len(args) > 1 else kwargs.get("resolution")
            on_preview("voxels", {"coords": coords[:, 1:].to(torch.uint8 if res <= 256 else torch.int16).cpu().numpy(), "resolution": res})
            return coords

        def shape_ready(slat, res):
            meshes, subs = originals["decode_shape_slat"](slat, res)
            early["key"], early["value"] = id(slat), (meshes, subs)
            try:
                from trellis2.representations import Mesh

                m = meshes[0]
                small = Mesh(m.vertices.clone(), m.faces.clone())
                small.simplify(int(os.environ.get("FORGE3D_PREVIEW_FACES", 12000)))
                on_preview("shape", {"vertices": _to_y_up(small.vertices.float()).cpu().numpy(), "faces": small.faces.int().cpu().numpy()})
            except Exception as err:  # noqa: BLE001  (a preview never breaks the model)
                print("shape preview failed:", err, flush=True)

        def shape(*args, **kwargs):
            slat = originals["sample_shape_slat"](*args, **kwargs)
            flow = args[1] if len(args) > 1 else kwargs.get("flow_model")
            shape_ready(slat, 1024 if flow is pipe.models.get("shape_slat_flow_model_1024") else 512)
            return slat

        def cascade(*args, **kwargs):
            slat, res = originals["sample_shape_slat_cascade"](*args, **kwargs)
            shape_ready(slat, res)
            return slat, res

        def decode_shape(slat, resolution):
            if early.get("key") == id(slat):
                return early.pop("value")
            return originals["decode_shape_slat"](slat, resolution)

        for name, fn in (("sample_sparse_structure", sparse), ("sample_shape_slat", shape), ("sample_shape_slat_cascade", cascade), ("decode_shape_slat", decode_shape)):
            setattr(pipe, name, fn)
        return lambda: [delattr(pipe, name) for name in originals if name in pipe.__dict__]

    @torch.inference_mode()
    def __call__(self, image: Image.Image, out_path: str, seed: int = 42, on_preview=None, **overrides) -> dict:
        """Sheet -> textured GLB at out_path. `on_preview(kind, data)` gets "voxels" and "shape" as they appear.
        `overrides` (pipeline, steps, faces, texture, remesh) change one run, for experiments."""
        import o_voxel

        s = {**self.settings, **{k: v for k, v in overrides.items() if v is not None}}
        timings = {}
        t = time.time()
        sampler = {"steps": int(s["steps"])}
        restore = self._hooks(on_preview) if on_preview else (lambda: None)
        try:
            mesh = self.pipe.run(
                image,
                seed=seed,
                pipeline_type=s["pipeline"],
                sparse_structure_sampler_params=sampler,
                shape_slat_sampler_params=sampler,
                tex_slat_sampler_params=sampler,
            )[0]
        finally:
            restore()
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
            decimation_target=int(s["faces"]),
            texture_size=int(s["texture"]),
            remesh=bool(s["remesh"]),
            remesh_band=1,
            remesh_project=0,
        )
        torch.cuda.synchronize()
        timings["bake"] = round(time.time() - t, 2)
        t = time.time()
        glb.export(out_path, extension_webp=False)
        timings["export"] = round(time.time() - t, 2)
        del mesh
        torch.cuda.empty_cache()
        return timings
