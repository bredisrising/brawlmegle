"""
Sharper faces: paints the model sheet's own front view onto the front of a fighter's base-color texture.

    python face_project.py in.glb sheet.png out.glb [--face-model face_landmarker.task] [--body 0..1] [--debug DIR]

TRELLIS.2's texture is soft at face scale (its detail is capped by its voxel attributes, not the bake size), while the
sheet it was made from has a crisp, straight-on front view. The sheet is close to an orthographic front view of the
model, so its pixels can go straight onto the texels that face the camera:

1. The model's rest pose is drawn orthographically from the front (the side its face is on: checked, not assumed)
   into the sheet's pixel frame: first by matching the two bounding boxes, then the silhouettes (ECC, affine).
2. The face: MediaPipe's face landmarks on the sheet and on that drawing of the model (TRELLIS's soft face sits on
   its own geometry) give a local warp, so the sheet's eyes and mouth land where the model's are.
3. Every texel of the front-facing triangles gets its 3D point, is projected into the sheet, and takes the sheet's
   color with a weight: how squarely it faces the camera (so sides and back keep TRELLIS's texture), whether it's
   the visible surface there (a depth test), how far inside the sheet's silhouette it lands, and the region (the
   head first; the rest of the front with `--body`, only where the sheet's colors agree with the model's).
4. The result goes back into the GLB's own base-color image (upscaled when the face has fewer texels than the sheet
   has pixels for it), so UVs, the rig and the skin are untouched. Every other byte of the GLB is kept.

Pure numpy + OpenCV + Pillow (+ MediaPipe for the face landmarks; without them the head keeps the silhouette
alignment). Prints a FACE_RESULT JSON line: what it did, the alignment's numbers and the time.
"""
import io
import json
import math
import os
import struct
import sys
import time

import cv2
import numpy as np
from PIL import Image

# --- GLB in and out ----------------------------------------------------------------------------------------------

DTYPES = {5120: np.int8, 5121: np.uint8, 5122: np.int16, 5123: np.uint16, 5125: np.uint32, 5126: np.float32}
WIDTH = {"SCALAR": 1, "VEC2": 2, "VEC3": 3, "VEC4": 4, "MAT4": 16}


def read_glb(data: bytes):
    magic, _version, length = struct.unpack_from("<III", data, 0)
    if magic != 0x46546C67:
        raise ValueError("not a GLB")
    off, gltf, binary = 12, None, b""
    while off < length:
        size, kind = struct.unpack_from("<II", data, off)
        chunk = data[off + 8 : off + 8 + size]
        if kind == 0x4E4F534A:
            gltf = json.loads(chunk)
        elif kind == 0x004E4942:
            binary = bytes(chunk)
        off += 8 + size
    return gltf, binary


def write_glb(gltf, binary: bytes) -> bytes:
    js = json.dumps(gltf, separators=(",", ":")).encode()
    js += b" " * (-len(js) % 4)
    binary += b"\0" * (-len(binary) % 4)
    total = 12 + 8 + len(js) + 8 + len(binary)
    return b"".join([struct.pack("<III", 0x46546C67, 2, total), struct.pack("<II", len(js), 0x4E4F534A), js,
                     struct.pack("<II", len(binary), 0x004E4942), binary])


def accessor(gltf, binary, index):
    a = gltf["accessors"][index]
    if "sparse" in a or "bufferView" not in a:
        raise ValueError("sparse accessors aren't supported")
    view = gltf["bufferViews"][a["bufferView"]]
    dt = np.dtype(DTYPES[a["componentType"]])
    n = WIDTH[a["type"]]
    stride = view.get("byteStride") or dt.itemsize * n
    start = view.get("byteOffset", 0) + a.get("byteOffset", 0)
    arr = np.ndarray((a["count"], n), dtype=dt, buffer=binary, offset=start, strides=(stride, dt.itemsize)).copy()
    if a.get("normalized") and dt.kind in "iu":
        arr = arr.astype(np.float32) / np.iinfo(dt).max
    return arr


def replace_view(gltf, binary, view_index, data: bytes) -> bytes:
    """The binary chunk with one buffer view's bytes swapped for `data`; every view is re-laid out 4-byte aligned."""
    views = gltf["bufferViews"]
    order = sorted(range(len(views)), key=lambda i: views[i].get("byteOffset", 0))
    out = bytearray()
    for i in order:
        v = views[i]
        if v.get("buffer", 0) != 0:
            raise ValueError("only single-buffer GLBs are supported")
        chunk = data if i == view_index else binary[v.get("byteOffset", 0) : v.get("byteOffset", 0) + v["byteLength"]]
        out += b"\0" * (-len(out) % 4)
        v["byteOffset"] = len(out)
        v["byteLength"] = len(chunk)
        out += chunk
    out += b"\0" * (-len(out) % 4)
    gltf["buffers"][0]["byteLength"] = len(out)
    return bytes(out)


def node_worlds(gltf):
    """World matrices of every node (rest pose)."""
    nodes = gltf.get("nodes", [])
    local = []
    for n in nodes:
        if "matrix" in n:
            local.append(np.array(n["matrix"], dtype=np.float64).reshape(4, 4).T)
            continue
        t = np.array(n.get("translation", [0, 0, 0]), dtype=np.float64)
        x, y, z, w = n.get("rotation", [0, 0, 0, 1])
        s = np.array(n.get("scale", [1, 1, 1]), dtype=np.float64)
        r = np.array([[1 - 2 * (y * y + z * z), 2 * (x * y - z * w), 2 * (x * z + y * w)],
                      [2 * (x * y + z * w), 1 - 2 * (x * x + z * z), 2 * (y * z - x * w)],
                      [2 * (x * z - y * w), 2 * (y * z + x * w), 1 - 2 * (x * x + y * y)]])
        m = np.eye(4)
        m[:3, :3] = r * s
        m[:3, 3] = t
        local.append(m)
    parent = {c: i for i, n in enumerate(nodes) for c in n.get("children", [])}
    world = [None] * len(nodes)

    def get(i):
        if world[i] is None:
            world[i] = local[i] if i not in parent else get(parent[i]) @ local[i]
        return world[i]

    return [get(i) for i in range(len(nodes))]


def load_model(gltf, binary):
    """Rest-pose positions, normals, UVs and triangles of every primitive that uses the first base-color texture,
    plus that texture's image index."""
    image = None
    for mat in gltf.get("materials", []):
        info = mat.get("pbrMetallicRoughness", {}).get("baseColorTexture")
        if info is not None:
            tex = gltf["textures"][info["index"]]
            image = tex.get("source", (tex.get("extensions", {}).get("EXT_texture_webp") or {}).get("source"))
            if info.get("texCoord", 0) != 0:
                raise ValueError("base color uses a second UV set")
            break
    if image is None or "bufferView" not in gltf["images"][image]:
        raise ValueError("no embedded base-color texture")
    worlds = node_worlds(gltf)
    P, N, UV, F = [], [], [], []
    base = 0
    for ni, node in enumerate(gltf.get("nodes", [])):
        if "mesh" not in node:
            continue
        for prim in gltf["meshes"][node["mesh"]]["primitives"]:
            if prim.get("mode", 4) != 4 or prim.get("material") is None:
                continue
            mat = gltf["materials"][prim["material"]]
            info = mat.get("pbrMetallicRoughness", {}).get("baseColorTexture")
            if info is None:
                continue
            tex = gltf["textures"][info["index"]]
            if tex.get("source", (tex.get("extensions", {}).get("EXT_texture_webp") or {}).get("source")) != image:
                continue
            attrs = prim["attributes"]
            pos = accessor(gltf, binary, attrs["POSITION"]).astype(np.float64)
            nrm = accessor(gltf, binary, attrs["NORMAL"]).astype(np.float64) if "NORMAL" in attrs else None
            uv = accessor(gltf, binary, attrs["TEXCOORD_0"]).astype(np.float64)
            idx = accessor(gltf, binary, prim["indices"]).reshape(-1, 3).astype(np.int64) if "indices" in prim else np.arange(len(pos)).reshape(-1, 3)
            # Where the vertices are drawn at rest: a skinned mesh by its joints (world x inverse bind), else its node.
            if "skin" in node and "JOINTS_0" in attrs:
                skin = gltf["skins"][node["skin"]]
                joints = skin["joints"]
                ibm = accessor(gltf, binary, skin["inverseBindMatrices"]).reshape(-1, 4, 4).transpose(0, 2, 1) if "inverseBindMatrices" in skin else np.tile(np.eye(4), (len(joints), 1, 1))
                jm = np.stack([worlds[j] @ ibm[k] for k, j in enumerate(joints)])
                J = accessor(gltf, binary, attrs["JOINTS_0"]).astype(np.int64)
                W = accessor(gltf, binary, attrs["WEIGHTS_0"]).astype(np.float64)
                W = W / np.maximum(W.sum(1, keepdims=True), 1e-9)
                M = np.einsum("vk,vkij->vij", W, jm[J])
            else:
                M = np.broadcast_to(worlds[ni], (len(pos), 4, 4))
            p = np.einsum("vij,vj->vi", M[:, :3, :3], pos) + M[:, :3, 3]
            if nrm is None:
                nrm = vertex_normals(p, idx)
            else:
                nrm = np.einsum("vij,vj->vi", M[:, :3, :3], nrm)
                nrm /= np.maximum(np.linalg.norm(nrm, axis=1, keepdims=True), 1e-9)
            P.append(p)
            N.append(nrm)
            UV.append(uv)
            F.append(idx + base)
            base += len(p)
    if not P:
        raise ValueError("no textured triangles")
    return np.concatenate(P), np.concatenate(N), np.concatenate(UV), np.concatenate(F), image


def vertex_normals(p, f):
    fn = np.cross(p[f[:, 1]] - p[f[:, 0]], p[f[:, 2]] - p[f[:, 0]])
    n = np.zeros_like(p)
    for k in range(3):
        np.add.at(n, f[:, k], fn)
    return n / np.maximum(np.linalg.norm(n, axis=1, keepdims=True), 1e-9)


# --- A small rasterizer (numpy) ---------------------------------------------------------------------------------


def raster(xy, tris, W, H, depth=None, budget=3_000_000):
    """Triangles in pixel coordinates (x right, y down; pixel (i, j) is centered at (i + .5, j + .5)).
    Returns per pixel the triangle (-1: none), barycentrics (l1, l2) and, with `depth`, the nearest (largest) depth.
    Without depth, later triangles win (UV charts don't overlap)."""
    T = xy[tris]
    ix0 = np.clip(np.ceil(T[..., 0].min(1) - 0.5), 0, W).astype(np.int64)
    ix1 = np.clip(np.floor(T[..., 0].max(1) - 0.5), -1, W - 1).astype(np.int64)
    iy0 = np.clip(np.ceil(T[..., 1].min(1) - 0.5), 0, H).astype(np.int64)
    iy1 = np.clip(np.floor(T[..., 1].max(1) - 0.5), -1, H - 1).astype(np.int64)
    w = ix1 - ix0 + 1
    h = iy1 - iy0 + 1
    cnt = np.where((w > 0) & (h > 0), w * h, 0)
    ax, ay = T[:, 0, 0], T[:, 0, 1]
    e1 = T[:, 1] - T[:, 0]
    e2 = T[:, 2] - T[:, 0]
    den = e1[:, 0] * e2[:, 1] - e2[:, 0] * e1[:, 1]
    ok = (cnt > 0) & (np.abs(den) > 1e-12)
    ids = np.flatnonzero(ok)
    inv = np.zeros_like(den)
    inv[ok] = 1.0 / den[ok]
    tri_out = np.full(H * W, -1, np.int32)
    bary = np.zeros((H * W, 2), np.float32)
    zbuf = np.full(H * W, -np.inf, np.float32) if depth is not None else None
    zt = depth[tris] if depth is not None else None
    csum = np.cumsum(cnt[ids])
    lo = 0
    pieces = []
    while lo < len(ids):
        hi = int(np.searchsorted(csum, (csum[lo - 1] if lo else 0) + budget, side="right"))
        hi = max(hi, lo + 1)
        sel = ids[lo:hi]
        c = cnt[sel]
        t = np.repeat(sel, c)
        local = np.arange(c.sum()) - np.repeat(np.cumsum(c) - c, c)
        px = ix0[t] + local % w[t]
        py = iy0[t] + local // w[t]
        dx = px + 0.5 - ax[t]
        dy = py + 0.5 - ay[t]
        l1 = (dx * e2[t, 1] - e2[t, 0] * dy) * inv[t]
        l2 = (e1[t, 0] * dy - dx * e1[t, 1]) * inv[t]
        inside = (l1 >= -1e-5) & (l2 >= -1e-5) & (l1 + l2 <= 1 + 1e-5)
        t, px, py, l1, l2 = t[inside], px[inside], py[inside], l1[inside], l2[inside]
        pix = py * W + px
        if depth is None:
            tri_out[pix] = t
            bary[pix, 0] = l1
            bary[pix, 1] = l2
        else:
            z = zt[t, 0] + l1 * (zt[t, 1] - zt[t, 0]) + l2 * (zt[t, 2] - zt[t, 0])
            pieces.append((pix, z, t, l1, l2))
        lo = hi
    if depth is not None and pieces:
        pix, z, t, l1, l2 = (np.concatenate(a) for a in zip(*pieces))
        order = np.lexsort((-z, pix))
        ps = pix[order]
        first = order[np.r_[True, ps[1:] != ps[:-1]]]
        tri_out[pix[first]] = t[first]
        bary[pix[first], 0] = l1[first]
        bary[pix[first], 1] = l2[first]
        zbuf[pix[first]] = z[first]
    out = (tri_out.reshape(H, W), bary.reshape(H, W, 2))
    return out + ((zbuf.reshape(H, W),) if depth is not None else ())


def interp(values, tris, tri, bary):
    """Per-pixel interpolation of per-vertex `values` from raster() output (pixels with no triangle get 0)."""
    m = tri >= 0
    t = tris[tri[m]]
    l1, l2 = bary[m, 0:1], bary[m, 1:2]
    v = values[t[:, 0]] * (1 - l1 - l2) + values[t[:, 1]] * l1 + values[t[:, 2]] * l2
    out = np.zeros(tri.shape + values.shape[1:], np.float32)
    out[m] = v
    return out


def sample(image, x, y, mode=cv2.INTER_LINEAR):
    """Bilinear lookup of image at float pixel coordinates (centers at .5)."""
    n = np.size(x)
    pad = -n % 1024  # remap wants both map sides under 32767
    mx = np.r_[np.asarray(x, np.float32).ravel() - 0.5, np.zeros(pad, np.float32)].reshape(-1, 1024)
    my = np.r_[np.asarray(y, np.float32).ravel() - 0.5, np.zeros(pad, np.float32)].reshape(-1, 1024)
    out = cv2.remap(image, mx, my, mode, borderMode=cv2.BORDER_REPLICATE)
    return out.reshape((-1,) + image.shape[2:])[:n]


def smoothstep(a, b, x):
    t = np.clip((x - a) / (b - a), 0, 1)
    return t * t * (3 - 2 * t)


# --- The sheet ---------------------------------------------------------------------------------------------------


def sheet_mask(sheet: Image.Image):
    """Foreground of the sheet: its alpha, else anything clearly unlike the border color (landmarks.py's rule)."""
    rgb = np.asarray(sheet.convert("RGB"))
    if sheet.mode == "RGBA":
        a = np.asarray(sheet.getchannel("A"))
        if (a < 128).mean() > 0.05:
            return rgb, a >= 128
    border = np.concatenate([rgb[:8].reshape(-1, 3), rgb[-8:].reshape(-1, 3), rgb[:, :8].reshape(-1, 3), rgb[:, -8:].reshape(-1, 3)])
    bg = np.median(border, axis=0)
    m = np.abs(rgb.astype(np.int16) - bg.astype(np.int16)).max(axis=2) > 24
    # Holes the background color shows through (between the legs, under the arms) stay out; specks don't count.
    n, lab, stats, _ = cv2.connectedComponentsWithStats(m.astype(np.uint8), connectivity=8)
    if n > 1:
        keep = np.zeros(n, bool)
        big = stats[1:, cv2.CC_STAT_AREA].max()
        keep[1:] = stats[1:, cv2.CC_STAT_AREA] >= max(200, 0.02 * big)
        m = keep[lab]
    return rgb, m


def bbox_of(mask):
    rows = np.flatnonzero(mask.any(1))
    cols = np.flatnonzero(mask.any(0))
    return np.array([cols[0], rows[0], cols[-1] + 1, rows[-1] + 1], np.float64)


# --- Face landmarks ----------------------------------------------------------------------------------------------

# MediaPipe face mesh points used for the warp: eye corners and lids, irises, brows, nose, mouth, chin, jaw, cheeks.
FACE_POINTS = [33, 133, 159, 145, 362, 263, 386, 374, 468, 473, 70, 105, 107, 336, 334, 300, 1, 2, 98, 327, 168, 6,
               61, 291, 0, 17, 13, 14, 152, 148, 377, 234, 454, 93, 323, 132, 361, 58, 288, 172, 397, 150, 379, 10, 109, 338]
OVAL = [10, 338, 297, 332, 284, 251, 389, 356, 454, 323, 361, 288, 397, 365, 379, 378, 400, 377, 152, 148, 176, 149,
        150, 136, 172, 58, 132, 93, 234, 127, 162, 21, 54, 103, 67, 109]


class FaceFinder:
    def __init__(self, model_path):
        from mediapipe.tasks.python import BaseOptions, vision

        self.det = vision.FaceLandmarker.create_from_options(vision.FaceLandmarkerOptions(
            base_options=BaseOptions(model_asset_path=model_path), num_faces=1,
            min_face_detection_confidence=0.2, min_face_presence_confidence=0.2))

    def __call__(self, rgb, box, size=512):
        """478 landmarks (pixel coordinates of `rgb`) of the face inside `box` (x0, y0, x1, y1), or None."""
        import mediapipe as mp

        x0, y0, x1, y1 = box
        s = size / max(x1 - x0, y1 - y0)
        M = np.array([[s, 0, -x0 * s], [0, s, -y0 * s]], np.float32)
        crop = cv2.warpAffine(np.ascontiguousarray(rgb[..., :3]), M, (size, size), flags=cv2.INTER_CUBIC, borderMode=cv2.BORDER_REPLICATE)
        res = self.det.detect(mp.Image(image_format=mp.ImageFormat.SRGB, data=np.ascontiguousarray(crop)))
        if not res.face_landmarks:
            return None
        pts = np.array([[p.x * size, p.y * size] for p in res.face_landmarks[0]], np.float64)
        return pts / s + [x0, y0]


def fit_affine(src, dst, w=None):
    """Least-squares 2x3 affine src -> dst."""
    A = np.c_[src, np.ones(len(src))]
    if w is not None:
        A, dst = A * w[:, None], dst * w[:, None]
    X, *_ = np.linalg.lstsq(A, dst, rcond=None)
    return X.T


def apply_affine(M, p):
    return p @ M[:, :2].T + M[:, 2]


def tps_fit(src, dst, reg):
    """Thin-plate spline src -> dst (2D), with smoothing `reg` (pixels^2 scale)."""
    n = len(src)
    d = np.linalg.norm(src[:, None] - src[None], axis=2)
    K = np.where(d > 0, d * d * np.log(np.maximum(d, 1e-9)), 0) + reg * np.eye(n)
    P = np.c_[np.ones(n), src]
    L = np.zeros((n + 3, n + 3))
    L[:n, :n], L[:n, n:], L[n:, :n] = K, P, P.T
    rhs = np.zeros((n + 3, 2))
    rhs[:n] = dst
    return src, np.linalg.solve(L, rhs)


def tps_apply(model, p):
    src, coef = model
    d2 = (p[:, None, 0] - src[None, :, 0]) ** 2 + (p[:, None, 1] - src[None, :, 1]) ** 2
    U = 0.5 * d2 * np.log(np.maximum(d2, 1e-18))  # r^2 log r
    n = len(src)
    return U @ coef[:n] + coef[n] + p[:, 0:1] * coef[n + 1] + p[:, 1:2] * coef[n + 2]


# --- The projection ----------------------------------------------------------------------------------------------


class View:
    """An orthographic front view: s (screen right), t (up), d (toward the viewer)."""

    def __init__(self, front):
        self.front = front  # "+x" or "-x" (forged fighters face +x, glTF y up)

    def __call__(self, p):
        if self.front == "+x":
            return np.stack([-p[:, 2], p[:, 1], p[:, 0]], 1)
        return np.stack([p[:, 2], p[:, 1], -p[:, 0]], 1)

    def dir(self, n):
        return n[:, 0] if self.front == "+x" else -n[:, 0]


def masked_blur(img, m, sigma):
    m = m.astype(np.float32)
    num = cv2.GaussianBlur(img * m[..., None], (0, 0), sigma)
    den = cv2.GaussianBlur(m, (0, 0), sigma)
    return num / np.maximum(den, 1e-3)[..., None]


HALF = 0.5  # the model's sheet-frame drawings are made at half the sheet's resolution


def run(glb: bytes, sheet: Image.Image, face=None, body=0.0, debug=None, max_texture=2048):
    """Returns (new GLB bytes or None when nothing was painted, report). `face`: a FaceFinder or a path to
    face_landmarker.task (None: no face warp, so the head isn't painted). `body`: 0..1, how much of the rest of the
    front gets the sheet's detail."""
    t0 = time.perf_counter()
    marks = {}
    info = {"ok": False}

    def mark(name):
        marks[name] = round(time.perf_counter() - t0, 3)

    gltf, binary = read_glb(glb)
    P, Nrm, UV, F, image_index = load_model(gltf, binary)
    img_meta = gltf["images"][image_index]
    view_ix = img_meta["bufferView"]
    bv = gltf["bufferViews"][view_ix]
    tex_img = Image.open(io.BytesIO(binary[bv.get("byteOffset", 0) : bv.get("byteOffset", 0) + bv["byteLength"]]))
    tex_mode = tex_img.mode
    tex = np.asarray(tex_img.convert("RGBA"))
    TH, TW = tex.shape[:2]
    mark("load")

    rgb, fg = sheet_mask(sheet)
    SH, SW = fg.shape
    sbox = bbox_of(fg)
    height = sbox[3] - sbox[1]
    hw, hh = int(SW * HALF), int(SH * HALF)
    fg_h = cv2.resize(fg.astype(np.float32), (hw, hh), interpolation=cv2.INTER_AREA)
    rgb_h = cv2.resize(rgb, (hw, hh), interpolation=cv2.INTER_AREA).astype(np.float32)
    mark("sheet")

    def draw(V, M, tris, scale, W, H):
        """The model's front view, model (s, t) -> sheet pixels by M, drawn at `scale` x the sheet into W x H."""
        xy = apply_affine(M * scale, V[:, :2])
        tri, bary, zbuf = raster(xy, tris, W, H, depth=V[:, 2])
        mask = tri >= 0
        uv = interp(UV, tris, tri, bary)
        img = np.zeros((H, W, 3), np.float32)
        img[mask] = sample(tex, uv[mask][:, 0] * TW, uv[mask][:, 1] * TH)[:, :3]
        return mask, zbuf, img

    # 1. Which side faces the sheet (the colors of the head and shoulders decide), and the box match:
    # model (s, t) -> sheet pixels.
    top = np.zeros((hh, hw), bool)
    top[int(sbox[1] * HALF) : int((sbox[1] + 0.35 * height) * HALF)] = True
    low_sheet3 = cv2.GaussianBlur(rgb_h, (0, 0), 2)
    best = None
    for front in ("+x", "-x"):
        view = View(front)
        V = view(P)
        nd = view.dir(Nrm)
        facing = F[nd[F].mean(1) > -0.05]  # back faces can't be the nearest surface
        lo, hi = V.min(0), V.max(0)
        a = height / (hi[1] - lo[1])
        M = np.array([[a, 0, (sbox[0] + sbox[2]) / 2 - a * (lo[0] + hi[0]) / 2], [0, -a, sbox[3] + a * lo[1]]])
        upper = facing[(V[facing, 1] > hi[1] - 0.4 * (hi[1] - lo[1])).any(1)]
        m_up, _, r_up = draw(V, M, upper, HALF, hw, hh)
        both = m_up & (fg_h > 0.5) & top
        score = -float(np.abs(cv2.GaussianBlur(r_up, (0, 0), 2)[both] - low_sheet3[both]).mean()) if both.any() else -999
        info.setdefault("front_scores", {})[front] = round(score, 2)
        if best is None or score > best[0]:
            best = (score, front, view, V, nd, facing, M)
    _, front, view, V, nd, facing, M = best
    info["front"] = front
    mask, zbuf, render = draw(V, M, facing, HALF, hw, hh)
    mark("front")

    # 2. Silhouettes: an affine that lays the model's silhouette onto the sheet's (ECC on blurred masks, quarter res).
    try:
        q4 = (hw // 2, hh // 2)
        tmpl = cv2.resize(cv2.GaussianBlur(fg_h, (0, 0), 2), q4, interpolation=cv2.INTER_AREA)
        inp = cv2.resize(cv2.GaussianBlur(mask.astype(np.float32), (0, 0), 2), q4, interpolation=cv2.INTER_AREA)
        cc, warp = cv2.findTransformECC(tmpl, inp, np.eye(2, 3, dtype=np.float32), cv2.MOTION_AFFINE,
                                        (cv2.TERM_CRITERIA_EPS | cv2.TERM_CRITERIA_COUNT, 60, 1e-5), None, 5)
        # warp: sheet -> drawing; the model -> sheet map becomes inverse(warp) after M.
        warp = warp.astype(np.float64)
        warp_h = warp.copy()
        warp_h[:, 2] *= 2  # in half-res pixels
        warp[:, 2] *= 2 / HALF  # in sheet pixels
        Minv = np.linalg.inv(np.vstack([warp, [0, 0, 1]]))
        lin = Minv[:2, :2]
        if 0.9 < lin[0, 0] < 1.1 and 0.9 < lin[1, 1] < 1.1 and abs(lin[0, 1]) < 0.08 and abs(lin[1, 0]) < 0.08:
            M = (Minv @ np.vstack([M, [0, 0, 1]]))[:2]
            info["ecc"] = round(float(cc), 4)
            # The drawing moves with it (the warp is in the image plane, so depths stay valid).
            inv = cv2.WARP_INVERSE_MAP
            mask = cv2.warpAffine(mask.astype(np.uint8), warp_h, (hw, hh), flags=cv2.INTER_NEAREST | inv).astype(bool)
            zbuf = cv2.warpAffine(np.where(np.isfinite(zbuf), zbuf, -1e3).astype(np.float32), warp_h, (hw, hh), flags=cv2.INTER_NEAREST | inv, borderValue=-1e3)
            zbuf[~mask] = -np.inf
            render = cv2.warpAffine(render, warp_h, (hw, hh), flags=cv2.INTER_LINEAR | inv)
        else:
            info["ecc"] = f"rejected {np.round(lin, 3).tolist()}"
    except cv2.error as err:
        info["ecc"] = f"failed: {str(err)[:80]}"
    info["iou"] = round(float((mask & (fg_h > 0.5)).sum() / max(1, (mask | (fg_h > 0.5)).sum())), 4)
    mark("silhouette")

    # 3. The face: landmarks on the sheet and on the model's own drawing (at 4x, around the head), in the sheet frame.
    xy = apply_affine(M, V[:, :2])
    top_band = V[:, 1] > V[:, 1].max() - 0.13 * (V[:, 1].max() - V[:, 1].min())
    hx = float(np.median(xy[top_band, 0]))
    head_box = np.array([hx - 0.11 * height, sbox[1] - 0.02 * height, hx + 0.11 * height, sbox[1] + 0.2 * height])
    face_sheet = face_model = None
    face_warp = None
    if isinstance(face, str):
        face = FaceFinder(face) if os.path.exists(face) else None
    if face is not None:
        face_sheet = face(rgb, head_box)
        x0, y0 = head_box[:2]
        k = min(4.0, 640 / max(head_box[2] - x0, head_box[3] - y0))  # the landmarker looks at 512 px anyway
        Wc, Hc = int((head_box[2] - x0) * k), int((head_box[3] - y0) * k)
        Mk = np.array([[1, 0, -x0], [0, 1, -y0]]) @ np.vstack([M, [0, 0, 1]])
        xyk = apply_affine(Mk * k, V[:, :2])
        near = facing[((xyk[facing, 0] > -20) & (xyk[facing, 0] < Wc + 20) & (xyk[facing, 1] > -20) & (xyk[facing, 1] < Hc + 20)).any(1)]
        mk, _, crop = draw(V, Mk, near, k, Wc, Hc)
        crop[~mk] = 128
        crop = np.clip(crop, 0, 255).astype(np.uint8)
        pts = face(crop, (0, 0, Wc, Hc))
        if pts is not None:
            face_model = pts / k + [x0, y0]
        if debug:
            cv2.imwrite(os.path.join(debug, "model_head.png"), cv2.cvtColor(crop, cv2.COLOR_RGB2BGR))
        info["face"] = {"sheet": face_sheet is not None, "model": face_model is not None}
        if face_sheet is not None and face_model is not None:
            src, dst = face_model[FACE_POINTS], face_sheet[FACE_POINTS]
            A = fit_affine(src, dst)
            res = np.linalg.norm(apply_affine(A, src) - dst, axis=1)
            fw = float(np.ptp(face_sheet[OVAL, 0]))
            sv = np.linalg.svd(A[:, :2], compute_uv=False)
            shift = dst.mean(0) - src.mean(0)
            info["face"].update(width=round(fw, 1), shift=np.round(shift, 1).tolist(), scale=np.round(sv, 3).tolist(),
                                residual=round(float(np.median(res)), 2))
            # A sane match: no big turn or squash, a modest shift, and the features agree once it's applied.
            if sv.max() < 1.3 and sv.min() > 0.77 and np.median(res) < 0.06 * fw and np.linalg.norm(shift) < 0.3 * fw:
                face_warp = (tps_fit(src, dst, reg=fw * 0.5), face_sheet[OVAL].mean(0), fw)
        info["face"]["used"] = face_warp is not None
    mark("face")
    if debug:
        ov = cv2.addWeighted(rgb, 0.5, np.clip(cv2.resize(render, (SW, SH)), 0, 255).astype(np.uint8), 0.5, 0)
        x0, y0, x1, y1 = head_box.astype(int)
        cv2.rectangle(ov, (x0, y0), (x1, y1), (255, 0, 0), 1)
        for pts, c in ((face_sheet, (0, 255, 0)), (face_model, (255, 0, 255))):
            if pts is not None:
                for x, y in pts[FACE_POINTS]:
                    cv2.circle(ov, (int(round(x)), int(round(y))), 1, c, -1)
        cv2.imwrite(os.path.join(debug, "overlay.png"), cv2.cvtColor(ov, cv2.COLOR_RGB2BGR))
    if face_warp is None and body <= 0:
        info.update(skipped="no reliable face match", timings=marks, seconds=round(time.perf_counter() - t0, 2))
        return None, info

    if face_sheet is not None:
        fc = face_sheet[OVAL].mean(0)
        face_r = 0.5 * float(np.ptp(face_sheet[OVAL, 0]))
    else:
        fc = np.array([hx, sbox[1] + 0.09 * height])
        face_r = 0.05 * height

    # 4. Texture budget: the face's texels vs the sheet's pixels for it. Upscale when the sheet has more.
    front_tris = np.flatnonzero((nd[F] > 0.15).any(1))
    if body <= 0:  # only the head gets painted: only its triangles
        front_tris = front_tris[(np.linalg.norm((xy[F[front_tris]] - fc) * [1, 0.85], axis=2) < 2.0 * face_r).any(1)]
    ft = front_tris[np.linalg.norm(xy[F[front_tris]].mean(1) - fc, axis=1) < face_r]
    up = 1
    if len(ft):
        cross = lambda a, b: a[:, 0] * b[:, 1] - a[:, 1] * b[:, 0]  # noqa: E731
        uvp = UV * [TW, TH]
        e = lambda a, i: a[F[ft, i]] - a[F[ft, 0]]  # noqa: E731
        texels = np.abs(cross(e(uvp, 1), e(uvp, 2))).sum() / 2
        pixels = np.abs(cross(e(xy, 1), e(xy, 2))).sum() / 2
        info["face_texels"], info["face_sheet_px"] = int(texels), int(pixels)
        while pixels / (texels * up * up) > 1.5 and TW * up * 2 <= max_texture:
            up *= 2
    if up > 1:
        tex = cv2.resize(tex, (TW * up, TH * up), interpolation=cv2.INTER_CUBIC)
        TH, TW = tex.shape[:2]
    info["texture"] = [int(TW), int(TH)]

    # 5. Every texel of the front-facing triangles: its 3D point, and where it lands on the sheet.
    ttri, tbary = raster(UV * [TW, TH], F[front_tris], TW, TH)
    tm = ttri >= 0
    tv = F[front_tris[ttri[tm]]]
    l1, l2 = tbary[tm, 0:1].astype(np.float64), tbary[tm, 1:2].astype(np.float64)
    l0 = 1 - l1 - l2
    Vt = V[tv[:, 0]] * l0 + V[tv[:, 1]] * l1 + V[tv[:, 2]] * l2
    Nt = nd[tv[:, 0]] * l0[:, 0] + nd[tv[:, 1]] * l1[:, 0] + nd[tv[:, 2]] * l2[:, 0]
    p = apply_affine(M, Vt[:, :2])
    q = p.copy()
    if face_warp:
        # The face warp, evaluated on a 2 px grid around the face and faded out over another face width.
        tps, center, fw = face_warp
        x0, y0 = np.floor(center - 1.6 * fw).astype(int)
        n = int(3.2 * fw / 2) + 2
        gx, gy = np.meshgrid(x0 + 2.0 * np.arange(n), y0 + 2.0 * np.arange(n))
        grid = np.c_[gx.ravel(), gy.ravel()]
        g = 1 - smoothstep(0.75 * fw, 1.5 * fw, np.linalg.norm(grid - center, axis=1))
        disp = ((tps_apply(tps, grid) - grid) * g[:, None]).reshape(n, n, 2).astype(np.float32)
        inside = (p[:, 0] > x0) & (p[:, 1] > y0) & (p[:, 0] < x0 + 2 * (n - 1)) & (p[:, 1] < y0 + 2 * (n - 1))
        q[inside] += sample(disp, (p[inside, 0] - x0) / 2 + 0.5, (p[inside, 1] - y0) / 2 + 0.5)
    mark("texels")

    # 6. Weights: facing the camera squarely (sides and back keep TRELLIS), the visible surface there, well inside
    # the sheet's silhouette, and the region (the head; the rest of the front by `body`).
    w_face = smoothstep(0.2, 0.55, Nt)
    zb = sample(zbuf, p[:, 0] * HALF, p[:, 1] * HALF, cv2.INTER_NEAREST)
    gap = np.where(np.isfinite(zb), zb - Vt[:, 2], 0)
    w_vis = 1 - smoothstep(0.004, 0.012, gap)
    dist_in = cv2.distanceTransform(fg.astype(np.uint8), cv2.DIST_L2, 5)
    w_edge = smoothstep(1.0, 5.0, sample(dist_in, q[:, 0], q[:, 1]))
    r_face = np.linalg.norm((p - fc) * [1, 0.85], axis=1)
    head = (1 - smoothstep(1.15 * face_r, 1.9 * face_r, r_face)) if face_warp else np.zeros(len(p))
    w = w_face * w_vis * w_edge * np.maximum(head, body)

    # Colors: the sheet's own inside the face; around it the sheet's detail on TRELLIS's tone (low frequencies), so
    # hair, ears and neck blend into the unpainted texture without a step.
    sig = max(2.0, 0.1 * face_r) * HALF
    low_sheet = masked_blur(rgb_h, fg_h > 0.5, sig)
    low_model = masked_blur(render, mask, sig)
    lm_p = sample(low_model, p[:, 0] * HALF, p[:, 1] * HALF)
    ls_q = sample(low_sheet, q[:, 0] * HALF, q[:, 1] * HALF)
    core = (1 - smoothstep(0.8 * face_r, 1.25 * face_r, r_face)) if face_warp else np.zeros(len(p))
    new = sample(rgb.astype(np.float32), q[:, 0], q[:, 1]) + (1 - core)[:, None] * (lm_p - ls_q)
    if body > 0:
        # Off the head, only where the sheet and the model agree (a few pixels off is fine; another part is not).
        gate = 1 - smoothstep(20, 45, np.abs(lm_p - ls_q).mean(1))
        w = np.where(head > 0.99, w, w * np.maximum(gate, head))
    old = tex[tm][:, :3].astype(np.float32)
    out = old + w[:, None] * (new - old)
    info["texels"], info["painted"] = int(tm.sum()), int((w > 0.5).sum())
    mark("weights")

    # Write back, and carry the change 3 texels into the gutter (mipmaps and bilinear edges read it): each gutter texel
    # near a painted one takes the mean change of the covered texels around it.
    delta = np.zeros((TH, TW, 3), np.float32)
    flat = np.flatnonzero(tm)
    sel = w > 1e-3
    delta.reshape(-1, 3)[flat[sel]] = (out - old)[sel]
    painted = np.zeros(TH * TW, np.uint8)
    painted[flat[sel]] = 1
    near = cv2.dilate(painted.reshape(TH, TW), np.ones((7, 7), np.uint8)).astype(bool)
    fill = near & ~tm
    acc = cv2.boxFilter(delta, -1, (7, 7), normalize=False)
    wacc = cv2.boxFilter(tm.astype(np.float32), -1, (7, 7), normalize=False)
    fill &= wacc > 0
    delta[fill] = acc[fill] / wacc[fill, None]
    changed = np.flatnonzero(painted.astype(bool) | fill.ravel())
    newtex = tex.copy()
    flat_tex = newtex.reshape(-1, newtex.shape[2])
    flat_tex[changed, :3] = np.clip(flat_tex[changed, :3] + delta.reshape(-1, 3)[changed] + 0.5, 0, 255).astype(np.uint8)
    mark("paint")

    if debug:
        wimg = np.zeros((TH, TW), np.float32)
        wimg[tm] = w
        cv2.imwrite(os.path.join(debug, "weights.png"), (wimg * 255).astype(np.uint8))

    # Encode like the input (PNG, fast: the forge's optimizer re-encodes it as WebP) and splice it into the GLB.
    mime = img_meta.get("mimeType", "image/png")
    # An opaque material ignores alpha (the rigger makes every fighter opaque): drop it, it's only the gutter's zeros.
    blended = any(m.get("alphaMode", "OPAQUE") != "OPAQUE" for m in gltf.get("materials", []))
    keep_alpha = tex_mode in ("RGBA", "LA", "P") and blended
    pixels = newtex if keep_alpha else np.ascontiguousarray(newtex[..., :3])
    if mime == "image/webp":
        buf = io.BytesIO()
        Image.fromarray(pixels).save(buf, "WEBP", quality=95, method=2)
        data = buf.getvalue()
    elif mime == "image/jpeg":
        data = cv2.imencode(".jpg", cv2.cvtColor(newtex[..., :3], cv2.COLOR_RGB2BGR), [cv2.IMWRITE_JPEG_QUALITY, 95])[1].tobytes()
    else:
        bgr = cv2.cvtColor(pixels, cv2.COLOR_RGBA2BGRA if keep_alpha else cv2.COLOR_RGB2BGR)
        params = [cv2.IMWRITE_PNG_COMPRESSION, 1, cv2.IMWRITE_PNG_STRATEGY, cv2.IMWRITE_PNG_STRATEGY_HUFFMAN_ONLY]
        data = cv2.imencode(".png", bgr, params)[1].tobytes()
        mime = "image/png"
    binary = replace_view(gltf, binary, view_ix, data)
    img_meta["mimeType"] = mime
    result = write_glb(gltf, binary)
    mark("write")
    info.update(ok=True, timings=marks, seconds=round(time.perf_counter() - t0, 2))
    return result, info


def main(argv):
    args, opts, i = [], {}, 0
    while i < len(argv):
        if argv[i].startswith("--"):
            opts[argv[i]] = argv[i + 1]
            i += 2
        else:
            args.append(argv[i])
            i += 1
    src, sheet_path, dst = args[:3]
    face_model = opts.get("--face-model", os.environ.get("FORGE3D_FACE_MODEL"))
    debug = opts.get("--debug")
    if debug:
        os.makedirs(debug, exist_ok=True)
    body = float(opts.get("--body", 0))
    with open(src, "rb") as f:
        glb = f.read()
    out, info = run(glb, Image.open(sheet_path), face=face_model, body=body, debug=debug)
    with open(dst + ".tmp", "wb") as f:
        f.write(out or glb)  # nothing painted: the model as it was
    os.replace(dst + ".tmp", dst)
    print("FACE_RESULT " + json.dumps(info))


if __name__ == "__main__":
    main(sys.argv[1:])
