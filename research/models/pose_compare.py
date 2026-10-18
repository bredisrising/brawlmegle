"""Q3: other pose models vs MediaPipe Pose full on the stock clips: jitter at rest, wrist loss during fast
punches, and inference cost. Offline, Python (accuracy), one model per process.

  run:     python -I pose_compare.py run MODEL CLIPS_DIR OUT_DIR WEIGHTS_DIR 40256 36564 49576
           MODEL in mp_full, mp_heavy, rtmpose_s, rtmpose_m, rtmo_s, yolo26n, yolo26s, movenet_thunder, movenet_lightning
  analyze: python -I pose_compare.py analyze CLIPS_DIR OUT_DIR LABELS_DIR SHEETS_DIR
"""
import json
import os
import sys
import time

import numpy as np

# COCO-17 order; the matching MediaPipe landmark for each.
COCO_FROM_MP = [0, 2, 5, 7, 8, 11, 12, 13, 14, 15, 16, 23, 24, 25, 26, 27, 28]
LSH, RSH, LEL, REL, LWR, RWR = 5, 6, 7, 8, 9, 10


def frames(clips_dir, clip):
    import cv2
    cap = cv2.VideoCapture(os.path.join(clips_dir, f'{clip}.mp4'))
    while True:
        ok, f = cap.read()
        if not ok:
            return
        yield f


def reference(clips_dir, clip):
    """The game's own MediaPipe full output (browser, from test/pose/extract.mjs) as COCO-17."""
    lines = open(os.path.join(clips_dir, f'{clip}.full.jsonl')).read().splitlines()[1:]
    kp = np.full((len(lines), 17, 2), np.nan)
    sc = np.zeros((len(lines), 17))
    for i, l in enumerate(lines):
        f = json.loads(l)
        if 'image' not in f:
            continue
        for j, m in enumerate(COCO_FROM_MP):
            kp[i, j] = (f['image'][m]['x'], f['image'][m]['y'])
            sc[i, j] = f['image'][m]['visibility']
    return kp, sc


def pick(cands, ref_center, prev_center):
    """Among (kp[17,2] normalized, score[17]) candidates, the person nearest the reference (or previous) shoulders."""
    if not cands:
        return None
    target = ref_center if ref_center is not None and not np.isnan(ref_center).any() else prev_center
    if target is None:
        return max(cands, key=lambda c: np.nanmax(c[0][:, 1]) - np.nanmin(c[0][:, 1]))
    return min(cands, key=lambda c: np.hypot(*(c[0][[LSH, RSH]].mean(0) - target)))


def run(model, clips_dir, out_dir, weights, clips):
    import cv2
    os.makedirs(out_dir, exist_ok=True)
    infer = make_model(model, weights)
    for clip in clips:
        ref, _ = reference(clips_dir, clip)
        kps, scs, mss = [], [], []
        prev = None
        for i, f in enumerate(frames(clips_dir, clip)):
            if i >= len(ref):
                break
            h, w = f.shape[:2]
            t0 = time.perf_counter()
            cands = infer(f, i, clip)
            ms = (time.perf_counter() - t0) * 1000
            rc = ref[i][[LSH, RSH]].mean(0)
            c = pick(cands, rc, prev)
            if c is None:
                kps.append(np.full((17, 2), np.nan))
                scs.append(np.zeros(17))
            else:
                kps.append(c[0])
                scs.append(c[1])
                prev = c[0][[LSH, RSH]].mean(0)
            mss.append(ms)
        np.savez(os.path.join(out_dir, f'{model}-{clip}.npz'), kp=np.array(kps), sc=np.array(scs), ms=np.array(mss))
        print(f'{model} {clip}: {len(kps)} frames, median {np.median(mss[5:]):.1f} ms/frame')


def make_model(model, weights):
    import cv2
    if model.startswith('mp_'):
        import mediapipe as mp
        from mediapipe.tasks.python import BaseOptions, vision
        path = os.path.join(weights, 'mp', f'pose_landmarker_{model[3:]}.task')
        state = {}

        def infer(f, i, clip):
            if state.get('clip') != clip:
                opts = vision.PoseLandmarkerOptions(base_options=BaseOptions(model_asset_path=path, delegate=BaseOptions.Delegate.CPU),
                                                    running_mode=vision.RunningMode.VIDEO, num_poses=2)
                state['lm'] = vision.PoseLandmarker.create_from_options(opts)
                state['clip'] = clip
                state['fps'] = 24 if clip == '40256' else 25
            img = mp.Image(image_format=mp.ImageFormat.SRGB, data=cv2.cvtColor(f, cv2.COLOR_BGR2RGB))
            res = state['lm'].detect_for_video(img, int(i * 1000 / state['fps']))
            out = []
            for pose in res.pose_landmarks:
                kp = np.array([[pose[m].x, pose[m].y] for m in COCO_FROM_MP])
                sc = np.array([pose[m].visibility for m in COCO_FROM_MP])
                out.append((kp, sc))
            return out
        return infer
    if model.startswith('rtm'):
        os.environ['TORCH_HOME'] = os.path.join(weights, 'rtmlib')
        from rtmlib import Body
        if model == 'rtmo_s':
            body = Body(pose='rtmo', mode='lightweight', backend='onnxruntime', device='cuda')
        else:
            body = Body(mode='lightweight' if model == 'rtmpose_s' else 'balanced', backend='onnxruntime', device='cuda')

        def infer(f, i, clip):
            h, w = f.shape[:2]
            kp, sc = body(f)
            return [(kp[n] / [w, h], sc[n]) for n in range(len(kp))]
        return infer
    if model.startswith('yolo'):
        os.chdir(os.path.join(weights, 'yolo'))
        from ultralytics import YOLO
        net = YOLO(f'{model}-pose.pt')

        def infer(f, i, clip):
            r = net.predict(f, imgsz=640, device=0, half=True, verbose=False)[0]
            if r.keypoints is None or len(r.keypoints) == 0:
                return []
            xyn = r.keypoints.xyn.cpu().numpy()
            conf = r.keypoints.conf.cpu().numpy() if r.keypoints.conf is not None else np.ones(xyn.shape[:2])
            return [(xyn[n], conf[n]) for n in range(len(xyn))]
        return infer
    if model.startswith('movenet'):
        from ai_edge_litert.interpreter import Interpreter
        it = Interpreter(model_path=os.path.join(weights, 'movenet', model.split('_')[1] + '.tflite'), num_threads=4)
        it.allocate_tensors()
        inp = it.get_input_details()[0]
        size = inp['shape'][1]
        state = {'crop': None, 'clip': None}

        def infer(f, i, clip):
            h, w = f.shape[:2]
            if state['clip'] != clip:
                state['crop'], state['clip'] = None, clip
            # Square crop: around last frame's keypoints (the official demo's idea), else the whole frame padded.
            if state['crop'] is None:
                side = max(w, h)
                cx, cy = w / 2, h / 2
            else:
                cx, cy, side = state['crop']
            x0, y0 = int(round(cx - side / 2)), int(round(cy - side / 2))
            side_i = int(round(side))
            canvas = np.zeros((side_i, side_i, 3), np.uint8)
            sx0, sy0 = max(0, x0), max(0, y0)
            sx1, sy1 = min(w, x0 + side_i), min(h, y0 + side_i)
            canvas[sy0 - y0:sy1 - y0, sx0 - x0:sx1 - x0] = f[sy0:sy1, sx0:sx1]
            img = cv2.resize(cv2.cvtColor(canvas, cv2.COLOR_BGR2RGB), (size, size))
            it.set_tensor(inp['index'], img[None].astype(inp['dtype']))
            it.invoke()
            out = it.get_tensor(it.get_output_details()[0]['index'])[0, 0]  # (17, 3) y, x, score
            kp = np.stack([(x0 + out[:, 1] * side) / w, (y0 + out[:, 0] * side) / h], axis=1)
            sc = out[:, 2]
            good = sc > 0.2
            if good.sum() >= 5:
                px, py = kp[good, 0] * w, kp[good, 1] * h
                span = max(px.max() - px.min(), py.max() - py.min()) * 1.6
                state['crop'] = ((px.max() + px.min()) / 2, (py.max() + py.min()) / 2, max(span, 0.3 * max(w, h)))
            else:
                state['crop'] = None
            return [(kp, sc)]
        return infer
    raise ValueError(model)


# ------------------------------------------------------------------------------------------------ analysis

ASPECT = 16 / 9
MODELS = ['mp_full_browser', 'mp_full', 'mp_heavy', 'rtmpose_s', 'rtmpose_m', 'rtmo_s', 'yolo26n', 'yolo26s', 'movenet_thunder', 'movenet_lightning']
# Below this score a model's wrist counts as lost (each model's own scale; MediaPipe reports visibility).
LOST = {'mp_full_browser': 0.5, 'mp_full': 0.5, 'mp_heavy': 0.5}


def load(out_dir, clips_dir, model, clip):
    if model == 'mp_full_browser':
        kp, sc = reference(clips_dir, clip)
        return kp, sc, None
    p = os.path.join(out_dir, f'{model}-{clip}.npz')
    if not os.path.exists(p):
        return None
    z = np.load(p)
    return z['kp'], z['sc'], z['ms']


def px(kp):
    """Normalized -> height units (x stretched by the aspect)."""
    return kp * [ASPECT, 1]


def analyze(clips_dir, out_dir, labels_dir, sheets_dir):
    have = [m for m in MODELS if load(out_dir, clips_dir, m, '40256') is not None]
    print('models:', have)
    data = {m: {c: load(out_dir, clips_dir, m, c) for c in ('40256', '36564', '49576')} for m in have}

    # Consensus wrist (median over models) per frame, for agreement.
    def consensus(clip, j):
        stack = np.stack([px(data[m][clip][0][:, j]) for m in have])
        return np.nanmedian(stack, axis=0)

    print('\n== jitter at rest: 49576 (slow form facing the camera, 36 s). Second difference |p[t] - (p[t-1]+p[t+1])/2|, '
          'in % of shoulder width, wrists+elbows, frames where the consensus wrist moves < 0.5 shoulder widths/s')
    rows = {}
    for m in have:
        kp = px(data[m]['49576'][0])
        sw = np.hypot(*(kp[:, LSH] - kp[:, RSH]).T)
        swm = np.nanmedian(sw)
        res = []
        for j in (LEL, REL, LWR, RWR):
            p = kp[:, j]
            r = np.hypot(*(p[1:-1] - (p[:-2] + p[2:]) / 2).T) / swm
            res.append(r)
        res = np.array(res)
        rows[m] = (res, swm)
    cons_speed = np.nanmax([np.hypot(*np.gradient(consensus('49576', j), axis=0).T) for j in (LWR, RWR)], axis=0) * 25 / np.nanmedian([rows[m][1] for m in have])
    slow = cons_speed[1:-1] < 0.5
    print(f'   slow frames: {slow.sum()} of {len(slow)}')
    for m in have:
        res = rows[m][0][:, slow]
        print(f'   {m:18s} median {100 * np.nanmedian(res):5.2f}%  p90 {100 * np.nanpercentile(res, 90):5.2f}%   (all frames median {100 * np.nanmedian(rows[m][0]):5.2f}%)')

    print('\n== fast punches: labeled arm strikes in 40256 (boxer at the camera, blur) and 36564 (side/back, full body)')
    for clip in ('40256', '36564'):
        lab = json.load(open(os.path.join(labels_dir, f'{clip}.json')))
        fps = lab['fps']
        idx = sorted({int(round(k)) for l in lab['labels'] if l['kind'] == 'strike' and l['limb'].startswith('arm')
                      for k in np.arange(l['start'] * fps / 1000, l['end'] * fps / 1000 + 1)})
        idx = [k for k in idx if k < len(data[have[0]][clip][0])]
        cw = {j: consensus(clip, j) for j in (LWR, RWR)}
        print(f'  {clip}: {len(idx)} frames inside arm strikes')
        for m in have:
            kp, sc, ms = data[m][clip]
            P = px(kp)
            sw = np.nanmedian(np.hypot(*(P[:, LSH] - P[:, RSH]).T))
            low = np.mean([sc[k, j] < LOST.get(m, 0.3) for k in idx for j in (LWR, RWR)])
            missing = np.mean([np.isnan(kp[k, LWR, 0]) for k in idx])
            # Teleports: the wrist jumps > 0.75 shoulder widths in one frame and comes back next frame.
            tele = 0
            for j in (LWR, RWR):
                for k in idx:
                    if 1 <= k < len(P) - 1:
                        a = np.hypot(*(P[k, j] - P[k - 1, j]))
                        b = np.hypot(*(P[k + 1, j] - P[k, j]))
                        c = np.hypot(*(P[k + 1, j] - P[k - 1, j]))
                        tele += a > 0.75 * sw and b > 0.75 * sw and c < 0.5 * min(a, b)
            off = np.mean([np.hypot(*(P[k, j] - cw[j][k])) > 0.5 * sw for k in idx for j in (LWR, RWR) if not np.isnan(cw[j][k]).any()])
            print(f'   {m:18s} wrist score low {100 * low:4.0f}%  no person {100 * missing:3.0f}%  one-frame teleports {tele:3d}  '
                  f'> 0.5 shoulder widths from the consensus {100 * off:4.0f}%')

    print('\n== cost: median ms per frame in this run (Python, RTX 4070 laptop / CPU as noted)')
    for m in have:
        ms = data[m]['49576'][2]
        if ms is not None:
            print(f'   {m:18s} {np.median(ms[5:]):6.1f} ms')

    if sheets_dir:
        sheets(clips_dir, data, have, labels_dir, sheets_dir)


def sheets(clips_dir, data, have, labels_dir, out):
    """One contact sheet per model: the frame in the middle of each labeled arm strike, both wrists marked
    (L = cyan circle, R = magenta square), for judging by eye whether the wrist is on the fist."""
    import cv2
    os.makedirs(out, exist_ok=True)
    picks = []
    for clip in ('40256', '36564'):
        lab = json.load(open(os.path.join(labels_dir, f'{clip}.json')))
        for l in lab['labels']:
            if l['kind'] == 'strike' and l['limb'].startswith('arm'):
                picks.append((clip, int(round((l['start'] + 0.45 * (l['end'] - l['start'])) * lab['fps'] / 1000)), l['name']))
    vids = {c: list(frames(clips_dir, c)) for c in ('40256', '36564')}
    for m in have:
        tiles = []
        for n, (clip, k, name) in enumerate(picks):
            f = vids[clip][k].copy()
            h, w = f.shape[:2]
            kp = data[m][clip][0][k]
            ref = data['mp_full_browser'][clip][0][k]
            for j, color, shape in ((LWR, (255, 255, 0), 'c'), (RWR, (255, 0, 255), 's')):
                if np.isnan(kp[j]).any():
                    continue
                x, y = int(kp[j, 0] * w), int(kp[j, 1] * h)
                if shape == 'c':
                    cv2.circle(f, (x, y), 14, color, 4)
                else:
                    cv2.rectangle(f, (x - 13, y - 13), (x + 13, y + 13), color, 4)
            # Crop: the whole frame for the close-up, around the person for the full-body clip.
            if clip == '36564':
                c = np.nanmean(ref[[LSH, RSH]], axis=0) * [w, h]
                half = 260
                x0, y0 = int(np.clip(c[0] - half, 0, w - 2 * half)), int(np.clip(c[1] - half * 0.7, 0, h - 2 * half))
                f = f[y0:y0 + 2 * half, x0:x0 + 2 * half]
            tile = cv2.resize(f, (320, 180) if clip == '40256' else (240, 240))
            tile = cv2.copyMakeBorder(tile, 0, 240 - tile.shape[0], 0, 320 - tile.shape[1], cv2.BORDER_CONSTANT)
            cv2.putText(tile, f'{n}:{clip[-3:]} {name}', (4, 232), cv2.FONT_HERSHEY_SIMPLEX, 0.5, (255, 255, 255), 1)
            tiles.append(tile)
        cols = 6
        while len(tiles) % cols:
            tiles.append(np.zeros_like(tiles[0]))
        grid = np.vstack([np.hstack(tiles[r * cols:(r + 1) * cols]) for r in range(len(tiles) // cols)])
        cv2.putText(grid, m, (8, 24), cv2.FONT_HERSHEY_SIMPLEX, 0.8, (0, 255, 255), 2)
        cv2.imwrite(os.path.join(out, f'{m}.jpg'), grid, [cv2.IMWRITE_JPEG_QUALITY, 80])
    print(f'sheets in {out}: {len(picks)} strike frames per model')


if __name__ == '__main__':
    if sys.argv[1] == 'run':
        run(sys.argv[2], sys.argv[3], sys.argv[4], sys.argv[5], sys.argv[6:])
    else:
        analyze(sys.argv[2], sys.argv[3], sys.argv[4], sys.argv[5] if len(sys.argv) > 5 else None)
