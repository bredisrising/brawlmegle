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
        return {"size": [w, h], "bbox": bbox(foreground(rgb), alpha), "points": points}


if __name__ == "__main__":
    out = Landmarker(sys.argv[1])(Image.open(sys.argv[2]))
    text = json.dumps(out)
    if len(sys.argv) > 3:
        open(sys.argv[3], "w").write(text)
    else:
        print(text)
