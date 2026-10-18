"""Q1b: a tiny causal 1D-CNN over the last 0.5 s of one arm's keypoints (mirrored, shoulder-relative, 30 Hz),
per frame: none / straight / hook / upper. Trained on synthetic clips (+ a real guided session), tested on the
reader's strike events in real clips (re-judge: style and reject) and as a stand-alone per-frame detector.

python -I research/models/temporal.py DUMP_DIR OUT_DIR [--extra-train guided-guided-233104] [--tag name]
"""
import json
import os
import sys
import time

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import numpy as np
import torch
import torch.nn as nn
from sklearn.metrics import roc_auc_score

from moves import ARMS, CLASSES, CI, STEPS, arm_channels, events_table, frame_targets, load_all, windows_at
from style_events import REAL, decide, fmt, summary, conf, print_conf

torch.set_num_threads(4)
torch.manual_seed(0)
np.random.seed(0)


class Net(nn.Module):
    def __init__(self, c_in, h=32):
        super().__init__()
        self.c1 = nn.Conv1d(c_in, h, 3)
        self.c2 = nn.Conv1d(h, h, 3, dilation=2)
        self.c3 = nn.Conv1d(h, h, 3, dilation=4)
        self.out = nn.Linear(2 * h, 4)

    def forward(self, x):  # x: (B, T, C)
        z = x.transpose(1, 2)
        z = torch.relu(self.c1(z))
        z = torch.relu(self.c2(z))
        z = torch.relu(self.c3(z))
        return self.out(torch.cat([z[:, :, -1], z.max(dim=2).values], dim=1))


def build(clips, none_keep=0.12, rng=np.random.default_rng(0)):
    X, Y = [], []
    for c in clips:
        for arm in ARMS:
            y = frame_targets(c, arm)
            ch = arm_channels(c, arm)
            keep = (y > 0) | ((y == 0) & (rng.random(len(y)) < none_keep))
            if c.source != 'synth':
                keep = y >= 0
            if keep.sum() == 0:
                continue
            X.append(windows_at(c, arm, c.t[keep], ch))
            Y.append(y[keep])
    return np.concatenate(X), np.concatenate(Y)


def train(X, Y, w_real=None, epochs=12, seed=0):
    torch.manual_seed(seed)
    mu, sd = X.reshape(-1, X.shape[2]).mean(0), X.reshape(-1, X.shape[2]).std(0) + 1e-3
    net = Net(X.shape[2])
    opt = torch.optim.AdamW(net.parameters(), lr=3e-3, weight_decay=1e-3)
    counts = np.bincount(Y, minlength=4).astype(float)
    cw = torch.tensor((counts.sum() / (4 * np.maximum(counts, 1))) ** 0.5, dtype=torch.float32)
    lossf = nn.CrossEntropyLoss(weight=cw, reduction='none')
    Xt = torch.tensor((X - mu) / sd, dtype=torch.float32)
    Yt = torch.tensor(Y)
    Wt = torch.tensor(w_real if w_real is not None else np.ones(len(Y)), dtype=torch.float32)
    n = len(Y)
    for ep in range(epochs):
        perm = torch.randperm(n)
        tot = 0.0
        for i in range(0, n, 512):
            b = perm[i:i + 512]
            xb = Xt[b]
            # Augment: small scale and offset changes (bodies and framings differ), Gaussian jitter.
            xb = xb * (1 + 0.1 * torch.randn(len(b), 1, 1)) + 0.1 * torch.randn(len(b), 1, xb.shape[2]) + 0.05 * torch.randn_like(xb)
            loss = (lossf(net(xb), Yt[b]) * Wt[b]).mean()
            opt.zero_grad()
            loss.backward()
            opt.step()
            tot += loss.item() * len(b)
        for g in opt.param_groups:
            g['lr'] *= 0.8
    net.eval()
    return net, mu, sd


def predict(net, mu, sd, X):
    with torch.no_grad():
        return torch.softmax(net(torch.tensor((X - mu) / sd, dtype=torch.float32)), dim=1).numpy()


def detect(net, mu, sd, clip, thr=0.6, refractory=350):
    """Stand-alone detector: per arm, an event when P(strike) first crosses thr (then wait out the refractory)."""
    events = []
    for arm in ARMS:
        P = predict(net, mu, sd, windows_at(clip, arm, clip.t))
        ps = 1 - P[:, 0]
        last = -1e9
        above = False
        for i, t in enumerate(clip.t):
            if ps[i] >= thr and not above and t - last > refractory:
                events.append(dict(kind='strike', limb=arm, t=float(t), style=CLASSES[1 + int(np.argmax(P[i, 1:]))]))
                last = t
            above = ps[i] >= thr
    return sorted(events, key=lambda e: e['t'])


def score_guided(clip, events):
    """Like test/intent/real.ts scoreGuided, strikes only."""
    s = dict(strikes=0, caught=0, styled=0, fakes=0)
    for l in clip.labels:
        during = [e for e in events if l['start'] <= e['t'] <= l['end']]
        x = l['expect']
        if x['kind'] == 'strike':
            s['strikes'] += 1
            mine = [e for e in during if e['limb'] == x['limb']]
            s['caught'] += bool(mine)
            s['styled'] += bool(mine) and mine[0]['style'] == x['style']
            s['fakes'] += len(during) - len(mine)
        else:
            s['fakes'] += len(during)
    return s


def main():
    dump, out = sys.argv[1], sys.argv[2]
    extra = sys.argv[sys.argv.index('--extra-train') + 1].split(',') if '--extra-train' in sys.argv else []
    tag = sys.argv[sys.argv.index('--tag') + 1] if '--tag' in sys.argv else 'run'
    holdout = '--synth-holdout' in sys.argv
    os.makedirs(out, exist_ok=True)
    clips = load_all(dump)
    synth = [c for c in clips if c.source == 'synth']
    train_clips = [c for c in synth if not (holdout and c.session() == 'synth-seed5')] + [c for c in clips if c.name in extra]
    t0 = time.time()
    X, Y = build(train_clips)
    print(f'[{tag}] train windows {len(Y)} (classes {np.bincount(Y, minlength=4).tolist()}), built in {time.time() - t0:.0f}s')
    if extra:
        Xr, Yr = build([c for c in clips if c.name in extra])
        X = np.concatenate([X, Xr, Xr, Xr, Xr])  # real windows counted 5x (they are also inside X once)
        Y = np.concatenate([Y, Yr, Yr, Yr, Yr])
        print(f'[{tag}] + real windows {len(Yr)} (classes {np.bincount(Yr, minlength=4).tolist()}) x5')
    t0 = time.time()
    net, mu, sd = train(X, Y)
    nparams = sum(p.numel() for p in net.parameters())
    print(f'[{tag}] trained {nparams} params in {time.time() - t0:.0f}s')

    # Re-judge the reader's strikes.
    ev = events_table(clips)
    tests = [e for e in ev if (e['clip'] in REAL and e['clip'] not in extra) or (holdout and e['session'] == 'synth-seed5')]
    by_clip = {c.name: c for c in clips}
    for lag in (0, 100):
        rows = {}
        for e in tests:
            c = by_clip[e['clip']]
            P = predict(net, mu, sd, windows_at(c, e['s']['limb'], np.array([e['s']['t'] + lag])))[0]
            rows.setdefault('synth seed 5' if e['source'] == 'synth' else 'real (held out)', []).append((e, P))
        for name, rr in rows.items():
            gts = [e['gt'] for e, _ in rr]
            P = np.array([p for _, p in rr])
            rule = [e['rule'] for e, _ in rr]
            g = np.array(gts)
            auc = roc_auc_score(g == 'none', P[:, 0]) if (g == 'none').any() and (g != 'none').any() else float('nan')
            print(f'[{tag}] at confirm+{lag}ms, {name}: AUC(fake) {auc:.2f}')
            print(f'    rules       {fmt(summary(gts, rule))}')
            for mode in ('full', 'style', 'gate'):
                print(f'    cnn {mode:5s}   {fmt(summary(gts, decide(P, rule, mode)))}')
            if name.startswith('real') and lag == 0:
                print_conf(conf(gts, decide(P, rule, 'full')), f'{tag} cnn full')

    # Stand-alone detection on the guided sessions not trained on.
    for c in clips:
        if c.source != 'guided' or c.name in extra:
            continue
        rules = score_guided(c, [i for i in c.intents if i['kind'] == 'strike' and i['limb'].startswith('arm')])
        print(f'[{tag}] {c.name} rules: {rules}')
        for thr in (0.5, 0.7, 0.85):
            print(f'[{tag}] {c.name} cnn detector thr {thr}: {score_guided(c, detect(net, mu, sd, c, thr))}')
    for c in clips:
        if c.name in ('stock-49576', 'extra-47758.full'):
            mins = (c.t[-1] - c.t[0]) / 60000
            n_rules = sum(1 for i in c.intents if i['kind'] == 'strike' and i['limb'].startswith('arm'))
            print(f'[{tag}] {c.name}: arm strikes per minute, rules {n_rules / mins:.1f}, cnn@0.7 {len(detect(net, mu, sd, c, 0.7)) / mins:.1f}, cnn@0.85 {len(detect(net, mu, sd, c, 0.85)) / mins:.1f}')

    # Export (plain JSON weights) and time a per-frame forward pass in numpy (stand-in for plain TS).
    state = {k: v.detach().numpy().round(5).tolist() for k, v in net.state_dict().items()}
    with open(os.path.join(out, f'{tag}.json'), 'w') as f:
        json.dump({'classes': CLASSES, 'steps': STEPS, 'mu': mu.tolist(), 'sd': sd.tolist(), 'state': state}, f)
    xw = torch.tensor(np.random.randn(1, STEPS, X.shape[2]), dtype=torch.float32)
    with torch.no_grad():
        for _ in range(50):
            net(xw)
        t1 = time.perf_counter()
        for _ in range(500):
            net(xw)
    print(f'[{tag}] torch CPU per-window forward: {(time.perf_counter() - t1) / 500 * 1000:.3f} ms; json {os.path.getsize(os.path.join(out, tag + ".json")) / 1024:.0f} KB')


if __name__ == '__main__':
    main()
