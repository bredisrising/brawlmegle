"""
Body joints on the model sheet, for the rigger: MediaPipe Pose (heavy) plus the character's bounding box.

    python landmarks.py pose_landmarker_heavy.task sheet.png [out.json]

The sheet is a front A-pose on a plain light background, so the box comes from keying out the border color.
Points are in sheet pixels; "l"/"r" are the character's own left and right (the left side is on the image's right).
"""
import json
import sys

import numpy as np
from PIL import Image

NAMES = {0: "nose", 7: "lEar", 8: "rEar", 11: "lS", 12: "rS", 13: "lE", 14: "rE", 15: "lW", 16: "rW",
         23: "lH", 24: "rH", 25: "lK", 26: "rK", 27: "lA", 28: "rA", 31: "lFI", 32: "rFI"}


def foreground(rgb: np.ndarray) -> np.ndarray:
    """Foreground mask: anything clearly different from the border color."""
    border = np.concatenate([rgb[:8].reshape(-1, 3), rgb[-8:].reshape(-1, 3), rgb[:, :8].reshape(-1, 3), rgb[:, -8:].reshape(-1, 3)])
    bg = np.median(border, axis=0)
    return np.abs(rgb.astype(np.int16) - bg.astype(np.int16)).max(axis=2) > 24


def bbox(mask: np.ndarray, alpha: np.ndarray | None = None) -> list[int]:
    m = alpha > 127 if alpha is not None else mask
    rows = np.where(m.sum(axis=1) > max(2, m.shape[1] // 400))[0]
    cols = np.where(m.sum(axis=0) > max(2, m.shape[0] // 400))[0]
    if len(rows) == 0 or len(cols) == 0:
        h, w = m.shape
        return [0, 0, w, h]
    return [int(cols[0]), int(rows[0]), int(cols[-1] + 1), int(rows[-1] + 1)]


# Average joint positions inside the character's box (0..1, from 5 forged sheets), for when MediaPipe finds no body.
TEMPLATE = {"nose": [0.506, 0.101], "lEar": [0.58, 0.094], "rEar": [0.429, 0.096], "lS": [0.692, 0.223], "rS": [0.318, 0.223],
            "lE": [0.825, 0.361], "rE": [0.183, 0.361], "lW": [0.928, 0.475], "rW": [0.077, 0.478], "lH": [0.613, 0.488],
            "rH": [0.397, 0.486], "lK": [0.665, 0.682], "rK": [0.34, 0.678], "lA": [0.712, 0.898], "rA": [0.29, 0.895],
            "lFI": [0.753, 0.976], "rFI": [0.246, 0.978]}


def template(image: Image.Image) -> dict:
    alpha = np.asarray(image.getchannel("A")) if image.mode == "RGBA" else None
    rgb = np.asarray(image.convert("RGB"))
    x0, y0, x1, y1 = box = bbox(foreground(rgb), alpha)
    points = {k: [x0 + u * (x1 - x0), y0 + v * (y1 - y0), 0.0] for k, (u, v) in TEMPLATE.items()}
    return {"size": [rgb.shape[1], rgb.shape[0]], "bbox": box, "points": points, "template": True}


class Landmarker:
    def __init__(self, model_path: str):
        from mediapipe.tasks.python import BaseOptions, vision

        self._vision = vision
        self.det = vision.PoseLandmarker.create_from_options(
            vision.PoseLandmarkerOptions(base_options=BaseOptions(model_asset_path=model_path), num_poses=1)
        )

    def __call__(self, image: Image.Image) -> dict:
        import mediapipe as mp

        alpha = np.asarray(image.getchannel("A")) if image.mode == "RGBA" else None
        rgb = np.asarray(image.convert("RGB"))
        res = self.det.detect(mp.Image(image_format=mp.ImageFormat.SRGB, data=np.ascontiguousarray(rgb)))
        if not res.pose_landmarks:
            raise ValueError("no body found on the sheet")
        lms = res.pose_landmarks[0]
        h, w = rgb.shape[:2]
        points = {n: [lms[i].x * w, lms[i].y * h, lms[i].visibility] for i, n in NAMES.items()}
        # The sheet faces the camera, so the character's left is on the image's right. If MediaPipe read it as a back
        # view, swap the sides.
        if points["lS"][0] < points["rS"][0] and points["lH"][0] < points["rH"][0]:
            points = {("r" + k[1:] if k[0] == "l" else "l" + k[1:]) if k[0] in "lr" and k[1].isupper() else k: v for k, v in points.items()}
        return {"size": [w, h], "bbox": bbox(foreground(rgb), alpha), "points": points}


if __name__ == "__main__":
    out = Landmarker(sys.argv[1])(Image.open(sys.argv[2]))
    text = json.dumps(out)
    if len(sys.argv) > 3:
        open(sys.argv[3], "w").write(text)
    else:
        print(text)
