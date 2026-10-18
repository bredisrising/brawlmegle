"""Q2: depth on demand. Does Depth Anything V2 Small, run only on the frames right after the reader's arm onset,
separate straights at the camera from non-strikes and hooks?

  run:     python -I depth_on_demand.py run CLIPS_DIR OUT_DIR 40256 36564 49576   (GPU; per-frame raw depth stats)
  analyze: python -I depth_on_demand.py analyze OUT_DIR DUMP_DIR LABELS_DIR

The signal is the depth spike's (research/depth-spike.md): toward = (hand - body) / (body - background), where hand
is the 90th percentile within 0.35 shoulder widths of the MediaPipe hand center, body the median of small patches
at the nose and shoulders, background the frame's 10th percentile.
"""
import json
import os
import sys
import time

import numpy as np

ASPECT = 16 / 9
RES = 336


def window(d, x, y, r, q):
    H, W = d.shape
    cx = min(max(x, 0), 1) * (W - 1)
    cy = min(max(y, 0), 1) * (H - 1)
    x0, x1 = int(max(0, round(cx - r))), int(min(W - 1, round(cx + r)))
    y0, y1 = int(max(0, round(cy - r))), int(min(H - 1, round(cy + r)))
    return float(np.percentile(d[y0:y1 + 1, x0:x1 + 1], q))


def stats(d, im):
    """Per arm: hand (fist) depth, body depth, and frame percentiles."""
    H, W = d.shape
    p5, p10, p95 = np.percentile(d, [5, 10, 95])
    sw = np.hypot((im[11][0] - im[12][0]) * ASPECT, im[11][1] - im[12][1])
    small = max(1, 0.012 * W)
    pm = lambda j: window(d, im[j][0], im[j][1], small, 50) if (0 <= im[j][0] <= 1 and 0 <= im[j][1] <= 1) else np.nan
    body = float(np.nanmedian([pm(0), pm(11), pm(12)]))
    out = []
    for w in (15, 16):
        hx = (im[w][0] + im[w + 2][0] + im[w + 4][0]) / 3
        hy = (im[w][1] + im[w + 2][1] + im[w + 4][1]) / 3
        r = max(2, 0.35 * sw * H)
        hand = window(d, hx, hy, r, 90) if (-0.1 <= hx <= 1.1 and -0.1 <= hy <= 1.1) else np.nan
        out.append(hand)
    return [out[0], out[1], body, p5, p10, p95]


def run(clips_dir, out_dir, clips):
    import cv2
    import torch
    from transformers import AutoModelForDepthEstimation
    dev = 'cuda'
    model = AutoModelForDepthEstimation.from_pretrained('depth-anything/Depth-Anything-V2-Small-hf').to(dev).eval()
    mean = np.array([0.485, 0.456, 0.406], np.float32)
    std = np.array([0.229, 0.224, 0.225], np.float32)
    os.makedirs(out_dir, exist_ok=True)

    def size_for(w, h):
        long = round(RES / 14) * 14
        short = max(14, round(long * min(w, h) / max(w, h) / 14) * 14)
        return (long, short) if w >= h else (short, long)

    @torch.inference_mode()
    def infer(x):
        with torch.autocast('cuda', dtype=torch.float16):
            return model(pixel_values=x).predicted_depth.float()

    for clip in clips:
        lm = [json.loads(l) for l in open(os.path.join(clips_dir, f'{clip}.full.jsonl')).read().splitlines()[1:]]
        cap = cv2.VideoCapture(os.path.join(clips_dir, f'{clip}.mp4'))
        rows = []
        i = 0
        t0 = time.time()
        while i < len(lm):
            ok, f = cap.read()
            if not ok:
                break
            h0, w0 = f.shape[:2]
            W, H = size_for(w0, h0)
            if 'image' not in lm[i]:
                rows.append([np.nan] * 6)
                i += 1
                continue
            img = (cv2.resize(f, (W, H), interpolation=cv2.INTER_AREA)[:, :, ::-1].astype(np.float32) / 255 - mean) / std
            d = infer(torch.from_numpy(img.transpose(2, 0, 1).copy())[None].to(dev))[0].cpu().numpy()
            im = [(p['x'], p['y']) for p in lm[i]['image']]
            rows.append(stats(d, im))
            i += 1
        # Batch-1 vs batch-2 timing (on demand: the onset frame and one 2 frames later, in one call).
        x1 = torch.randn(1, 3, H, W, device=dev)
        x2 = torch.randn(2, 3, H, W, device=dev)
        bench = {}
        for name, x in (('b1', x1), ('b2', x2)):
            for _ in range(10):
                infer(x)
            torch.cuda.synchronize()
            s = time.perf_counter()
            for _ in range(50):
                infer(x)
            torch.cuda.synchronize()
            bench[name] = (time.perf_counter() - s) / 50 * 1000
        np.savez(os.path.join(out_dir, f'{clip}.npz'), rows=np.array(rows), t=np.array([l['t'] for l in lm[:len(rows)]]), bench=json.dumps(bench), W=W, H=H)
        print(f'{clip}: {len(rows)} frames in {time.time() - t0:.0f}s at {W}x{H}; torch fp16 batch1 {bench["b1"]:.1f} ms, batch2 {bench["b2"]:.1f} ms')


# ------------------------------------------------------------------------------------------------ analysis

def toward(rows, k, arm, den=None):
    hand, body, p5, p10, p95 = rows[k, arm], rows[k, 2], rows[k, 3], rows[k, 4], rows[k, 5]
    if den is None:
        den = max(body - p10, 0.25 * (p95 - p5))
    return (hand - body) / den


def continuous(rows):
    """The spike's always-on signal: EMA-smoothed denominator."""
    n = len(rows)
    out = np.full((n, 2), np.nan)
    ema = None
    for k in range(n):
        if np.isnan(rows[k, 2]):
            continue
        den = max(rows[k, 2] - rows[k, 4], 0.25 * (rows[k, 5] - rows[k, 3]))
        ema = den if ema is None else ema + 0.3 * (den - ema)
        for a in (0, 1):
            out[k, a] = toward(rows, k, a, ema)
    return out


def analyze(out_dir, dump_dir, labels_dir):
    from sklearn.metrics import roc_auc_score
    results = []
    for clip in ('40256', '36564', '49576'):
        z = np.load(os.path.join(out_dir, f'{clip}.npz'))
        rows, ts = z['rows'], z['t']
        cont = continuous(rows)
        lab = json.load(open(os.path.join(labels_dir, f'{clip}.json')))
        labels = lab['labels']
        until = lab.get('until') or 1e12
        dump = json.load(open(os.path.join(dump_dir, f'stock-{clip}.json')))
        dt = float(np.median(np.diff(ts)))
        seen = set()
        for src in ('intents', 'sensitive'):
            for it in dump[src]:
                if it['kind'] != 'anticipate' or not it['limb'].startswith('arm') or it['t'] > until:
                    continue
                key = (it['limb'], round(it['t']))
                if key in seen:
                    continue
                seen.add(key)
                arm = 0 if it['limb'] == 'armL' else 1
                k0 = int(np.argmin(np.abs(ts - it['t'])))
                if k0 + 2 >= len(rows) or k0 < 1:
                    continue
                # Ground truth: the labeled strike this onset belongs to (same arm, onset inside it), else none.
                g = 'none'
                g_any = 'none'
                for l in labels:
                    if l['kind'] == 'strike' and l.get('limb', '').startswith('arm') and l['start'] - 100 <= it['t'] <= l['end']:
                        g_any = l['style']
                        if l['limb'] == it['limb']:
                            g = l['style']
                # On demand: frames k0 (the onset frame, baseline), k0+1, k0+2; per-frame denominator from the median.
                den = np.nanmedian([max(rows[k, 2] - rows[k, 4], 0.25 * (rows[k, 5] - rows[k, 3])) for k in (k0, k0 + 1, k0 + 2)])
                tw = [toward(rows, k, arm, den) for k in (k0, k0 + 1, k0 + 2)]
                other = [toward(rows, k, 1 - arm, den) for k in (k0, k0 + 1, k0 + 2)]
                base_cont = np.nanmedian(cont[max(0, k0 - 12):k0, arm]) if k0 > 2 else cont[k0, arm]
                results.append(dict(
                    clip=clip, limb=it['limb'], t=it['t'], k0=k0, gt=g, gt_any=g_any, src=src,
                    rise2=np.nanmax(tw[1:]) - tw[0],          # 2 extra inferences (frames +1, +2) + the onset frame
                    rise1=tw[2] - tw[0],                      # batch of 2: onset frame and frame +2
                    level=np.nanmax(tw[1:]),                  # no baseline
                    other_rise=np.nanmax(other[1:]) - other[0],
                    cont_rise=np.nanmax(cont[k0:k0 + 3, arm]) - base_cont,  # always-on depth, for reference
                    dt=dt,
                ))
    res = results
    print(f'{len(res)} arm onsets (default + sensitive reader); by clip and truth:')
    from collections import Counter
    print('  ', dict(Counter((r['clip'], r['gt']) for r in res)))

    def table(sel, pos, name):
        y = np.array([pos(r) for r in sel])
        if y.all() or not y.any():
            return
        print(f'\n== {name}: {y.sum()} positives vs {(~y).sum()} negatives')
        for sig in ('rise2', 'rise1', 'level', 'cont_rise'):
            v = np.array([r[sig] for r in sel])
            ok = ~np.isnan(v)
            auc = roc_auc_score(y[ok], v[ok])
            # bootstrap CI
            rng = np.random.default_rng(0)
            bs = []
            idx = np.arange(ok.sum())
            for _ in range(1000):
                b = rng.choice(idx, len(idx))
                yy, vv = y[ok][b], v[ok][b]
                if yy.all() or not yy.any():
                    continue
                bs.append(roc_auc_score(yy, vv))
            lo, hi = np.percentile(bs, [2.5, 97.5])
            print(f'  {sig:9s} AUC {auc:.2f} (95% CI {lo:.2f}-{hi:.2f})')
            if sig in ('rise2', 'rise1'):
                for thr in (0.1, 0.2, 0.3, 0.45, 0.6):
                    tpr = np.mean(v[ok][y[ok]] > thr)
                    fpr = np.mean(v[ok][~y[ok]] > thr)
                    print(f'      thr {thr:.2f}: straights passing {100 * tpr:3.0f}%  others passing {100 * fpr:3.0f}%')

    b = [r for r in res if r['clip'] == '40256']
    table(b, lambda r: r['gt'] == 'straight', '40256 (at the camera): straight vs everything else (same arm)')
    table([r for r in b if r['gt'] in ('straight', 'none')], lambda r: r['gt'] == 'straight', '40256: straight vs not-a-strike')
    table([r for r in b if r['gt'] in ('straight', 'hook', 'upper')], lambda r: r['gt'] == 'straight', '40256: straight vs hook/upper')
    table(b, lambda r: r['gt_any'] == 'straight', '40256: straight by either arm (hands swap on this clip) vs everything else')
    table(res, lambda r: r['gt'] != 'none', 'all three clips: any real strike vs not-a-strike')
    neg = [r for r in res if r['clip'] == '49576']
    if neg:
        v = np.array([r['rise2'] for r in neg])
        print(f'\n49576 (slow form, facing the camera, no strikes): {len(neg)} onsets, rise2 median {np.nanmedian(v):.2f}, '
              f'> 0.3: {np.mean(v > 0.3) * 100:.0f}%, > 0.45: {np.mean(v > 0.45) * 100:.0f}%')
    print('\nper-onset (40256):')
    for r in sorted(b, key=lambda r: r['t']):
        print(f"  {r['t']:7.0f} {r['limb']} {r['src']:9s} gt={r['gt']:8s} any={r['gt_any']:8s} rise2={r['rise2']:5.2f} rise1={r['rise1']:5.2f} other={r['other_rise']:5.2f} cont={r['cont_rise']:5.2f}")
    for clip in ('40256', '36564', '49576'):
        z = np.load(os.path.join(out_dir, f'{clip}.npz'))
        print(clip, 'bench', z['bench'])


if __name__ == '__main__':
    if sys.argv[1] == 'run':
        run(sys.argv[2], sys.argv[3], sys.argv[4:])
    else:
        analyze(sys.argv[2], sys.argv[3], sys.argv[4])
