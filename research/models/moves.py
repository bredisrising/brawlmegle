"""Shared loading for the move-research experiments (research/move-research.md).

Reads the dumps written by test/research/dump.test.ts: per clip a JSON (labels, the reader's intents from the
default and a sensitive config) and an f32 matrix of preprocessed body rows (body units, see KEEP below).

Builds two datasets:
  * events: one row per arm strike the reader emitted, with ground truth straight / hook / upper / none
  * windows: per frame and arm, the last 0.5 s of mirrored, shoulder-relative keypoints resampled to 30 Hz
"""
import glob
import json
import os

import numpy as np

CLASSES = ['none', 'straight', 'hook', 'upper']
CI = {c: i for i, c in enumerate(CLASSES)}
# Kept MediaPipe landmarks, in dump order.
KEEP = [0, 7, 8, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 23, 24]
K = {lm: i for i, lm in enumerate(KEEP)}
PER_POINT = 8
# Arm -> (shoulder, elbow, wrist, pinky, index, other wrist, other shoulder) landmark ids, and the mirror sign
# (the person's left shows on the image right: outward for the left arm is +x).
ARMS = {
    'armL': dict(sh=11, el=13, wr=15, pk=17, ix=19, ow=16, osh=12, m=1.0, side='L'),
    'armR': dict(sh=12, el=14, wr=16, pk=18, ix=20, ow=15, osh=11, m=-1.0, side='R'),
}
MATCH_SLACK_MS = 250


class Clip:
    def __init__(self, base):
        meta = json.load(open(base + '.json'))
        self.name = meta['name']
        self.source = meta['source']
        self.meta = meta
        self.labels = meta.get('labels', [])
        self.intents = meta['intents']
        self.sensitive = meta['sensitive']
        rows = np.fromfile(base + '.f32', dtype=np.float32).reshape(-1, meta['stride'])
        until = meta.get('until')
        if until:
            rows = rows[rows[:, 0] <= until]
            self.intents = [i for i in self.intents if i['t'] <= until]
            self.sensitive = [i for i in self.sensitive if i['t'] <= until]
        self.rows = rows.astype(np.float64)
        self.t = self.rows[:, 0]
        n = len(KEEP)
        pts = self.rows[:, 1:1 + n * PER_POINT].reshape(-1, n, PER_POINT)
        self.p = pts[:, :, 0:3]
        self.vf = pts[:, :, 3:6]
        self.vis = pts[:, :, 6]
        self.ok = pts[:, :, 7]
        ex = self.rows[:, 1 + n * PER_POINT:]
        self.elbow = {'L': ex[:, 0], 'R': ex[:, 1]}
        self.scale = ex[:, 4]

    def P(self, lm):
        return self.p[:, K[lm]]

    def V(self, lm):
        return self.vf[:, K[lm]]

    def session(self):
        """Grouping key for leave-one-session-out: synthetic seeds are one group per seed."""
        if self.source == 'synth':
            return 'synth-seed%d' % (self.meta['seed'] % 1000)
        return self.name


def load_all(dump_dir):
    clips = []
    for j in sorted(glob.glob(os.path.join(dump_dir, '*.json'))):
        clips.append(Clip(j[:-5]))
    return clips


# ---------------------------------------------------------------- ground truth for reader strike events

def label_events(clip, intents):
    """Ground truth for each arm strike intent: 'straight'/'hook'/'upper'/'none', or None (unknown, skip)."""
    strikes = [i for i in intents if i['kind'] == 'strike' and i['limb'].startswith('arm')]
    gt = {}
    if clip.source == 'guided':
        for s in strikes:
            win = [l for l in clip.labels if l['start'] <= s['t'] <= l['end']]
            if not win:
                gt[id(s)] = None
                continue
            l = win[0]
            e = l['expect']
            if e['kind'] == 'strike':
                gt[id(s)] = e['style'] if e.get('limb') == s['limb'] else 'none'
            else:
                gt[id(s)] = 'none'
        return strikes, gt
    # Labeled clips (synthetic, stock): match like test/intent/eval.ts.
    labels = sorted(clip.labels, key=lambda l: l['start'])
    used = set()
    for n, l in enumerate(labels):
        if l['kind'] != 'strike' or not l.get('limb', '').startswith('arm'):
            continue
        nxt = next((x for x in labels[n + 1:] if x.get('limb') == l['limb']), None)
        for s in strikes:
            if id(s) in used or s['limb'] != l['limb']:
                continue
            if l['start'] <= s['t'] <= l['end'] + MATCH_SLACK_MS and (nxt is None or s['onsetT'] < nxt['start'] + 40):
                used.add(id(s))
                gt[id(s)] = l['style']
                break
    for s in strikes:
        if id(s) not in used:
            gt[id(s)] = 'none'
    return strikes, gt


# ---------------------------------------------------------------- per-event window features

def _rel(clip, arm, lm, idx):
    a = ARMS[arm]
    d = clip.P(lm)[idx] - clip.P(a['sh'])[idx]
    return np.array([d[..., 0] * a['m'], d[..., 1], d[..., 2]]).T if np.ndim(idx) else np.array([d[0] * a['m'], d[1], d[2]])


def event_features(clip, s, pre_ms=100):
    """Hand-made features of a strike from its onset (minus pre_ms) to its confirmation: causal, only what the
    reader had when it fired. Mirrored so left and right arms compare."""
    arm = s['limb']
    a = ARMS[arm]
    t = clip.t
    i1 = int(np.searchsorted(t, s['t'], side='right') - 1)
    i0 = int(np.searchsorted(t, s['onsetT'] - pre_ms))
    i1 = max(i1, 0)
    i0 = min(max(i0, 0), i1)
    idx = np.arange(i0, i1 + 1)
    wr = _rel(clip, arm, a['wr'], idx)
    el = _rel(clip, arm, a['el'], idx)
    hand = (_rel(clip, arm, a['pk'], idx) + _rel(clip, arm, a['ix'], idx)) / 2
    ow = _rel(clip, arm, a['ow'], idx)
    nose = _rel(clip, arm, 0, idx)
    sw = np.abs(clip.P(11)[idx, 0] - clip.P(12)[idx, 0])
    eang = clip.elbow[a['side']][idx] / 180.0
    dw = wr[-1] - wr[0]
    de = el[-1] - el[0]
    dh = hand[-1] - hand[0]
    dow = ow[-1] - ow[0]
    dn = nose[-1] - nose[0]
    steps = np.diff(wr[:, :2], axis=0)
    path = float(np.sum(np.hypot(steps[:, 0], steps[:, 1]))) if len(steps) else 0.0
    net = float(np.hypot(dw[0], dw[1]))
    disp = np.hypot(wr[:, 0] - wr[0, 0], wr[:, 1] - wr[0, 1])
    k = int(np.argmax(disp))
    # Signed area swept by the hand path (hooks curve, straights don't).
    if len(wr) >= 3:
        x, y = wr[:, 0] - wr[0, 0], wr[:, 1] - wr[0, 1]
        area = float(0.5 * np.sum(x[:-1] * y[1:] - x[1:] * y[:-1]))
    else:
        area = 0.0
    vw = clip.V(a['wr'])[idx] - clip.V(a['sh'])[idx]
    ve = clip.V(a['el'])[idx] - clip.V(a['sh'])[idx]
    sp_w = np.hypot(vw[:, 0], vw[:, 1])
    sp_e = np.hypot(ve[:, 0], ve[:, 1])
    vo = clip.V(a['ow'])[idx] - clip.V(a['osh'])[idx]
    sp_o = np.hypot(vo[:, 0], vo[:, 1])
    cosmove = float((dw[0] * dow[0] + dw[1] * dow[1]) / (np.hypot(*dw[:2]) * np.hypot(*dow[:2]) + 1e-6))
    vis_w = clip.vis[idx, K[a['wr']]]
    vis_e = clip.vis[idx, K[a['el']]]
    mine = [
        dw[0], dw[1], dw[2], de[0], de[1], de[2], dh[0], dh[1],
        wr[0, 0], wr[0, 1], wr[-1, 0], wr[-1, 1], el[-1, 0], el[-1, 1], wr[k, 0], wr[k, 1],
        eang[0], eang[-1], eang.max() - eang[0],
        path, net, path / (net + 1e-3), area,
        sp_w.max(), sp_e.max(), sp_o.max(), cosmove, np.hypot(*dow[:2]),
        dn[0], dn[1], sw[-1] / (sw[0] + 1e-6), (s['t'] - s['onsetT']) / 1000.0,
        vis_w.min(), vis_e.min(), np.hypot(nose[-1, 0] - wr[-1, 0], nose[-1, 1] - wr[-1, 1]),
    ]
    reader = list(s.get('features') or [0.0] * 12)
    reader += [s['reach'], s['rawSpeed'], s['dir']['out'], s['dir']['up'], s['dir']['fwd'], 1.0 if s['height'] == 'high' else 0.0]
    return np.array(reader + mine, dtype=np.float64)


READER_FEATURES = 18


def events_table(clips, which='intents'):
    """Rows: (clip, strike, gt, rule style, features) for every arm strike with a known ground truth."""
    out = []
    for c in clips:
        strikes, gt = label_events(c, getattr(c, which))
        for s in strikes:
            g = gt[id(s)]
            if g is None:
                continue
            out.append(dict(clip=c.name, session=c.session(), source=c.source, s=s, gt=g, rule=s['style'], x=event_features(c, s)))
    return out


# ---------------------------------------------------------------- temporal windows

STEPS = 15  # 0.5 s at 30 Hz
DT = 1000.0 / 30


def arm_channels(clip, arm):
    """Per frame channels for one arm, mirrored, shoulder-relative (body units)."""
    a = ARMS[arm]
    n = len(clip.t)
    idx = np.arange(n)
    wr = _rel(clip, arm, a['wr'], idx)
    el = _rel(clip, arm, a['el'], idx)
    hand = (_rel(clip, arm, a['pk'], idx) + _rel(clip, arm, a['ix'], idx)) / 2
    ow = _rel(clip, arm, a['ow'], idx)
    sc = (clip.P(11) + clip.P(12)) / 2
    nose = clip.P(0) - sc
    sw = np.abs(clip.P(11)[:, 0] - clip.P(12)[:, 0])
    tilt = (clip.P(11)[:, 1] - clip.P(12)[:, 1]) * a['m']
    ch = np.stack([
        wr[:, 0], wr[:, 1], el[:, 0], el[:, 1], hand[:, 0], hand[:, 1], wr[:, 2] - el[:, 2],
        clip.elbow[a['side']] / 180.0,
        clip.vis[:, K[a['wr']]], clip.vis[:, K[a['el']]],
        ow[:, 0], ow[:, 1], nose[:, 0] * a['m'], nose[:, 1], sw, tilt,
    ], axis=1)
    return ch


POS_CH = [0, 1, 2, 3, 4, 5, 10, 11, 12, 13]  # channels also given relative to the window start


def windows_at(clip, arm, times, ch=None):
    """Input windows ending at each time: (len(times), STEPS, C)."""
    if ch is None:
        ch = arm_channels(clip, arm)
    t = clip.t
    grid = np.asarray(times)[:, None] - DT * np.arange(STEPS - 1, -1, -1)[None, :]
    grid = np.clip(grid, t[0], t[-1])
    out = np.empty(grid.shape + (ch.shape[1],))
    for c in range(ch.shape[1]):
        out[:, :, c] = np.interp(grid, t, ch[:, c])
    rel = out[:, :, POS_CH] - out[:, :1, POS_CH]
    return np.concatenate([out, rel], axis=2).astype(np.float32)


def frame_targets(clip, arm, which_events='sensitive'):
    """Per frame class for one arm (index into CLASSES), or -1 = ignore."""
    t = clip.t
    y = np.zeros(len(t), dtype=np.int64)
    if clip.source == 'guided':
        y[:] = -1
        for l in clip.labels:
            m = (t >= l['start']) & (t <= l['end'])
            e = l['expect']
            if e['kind'] == 'strike':
                if e.get('limb') != arm:
                    y[m] = -1  # the other arm may move a bit; don't teach either way
                    continue
                y[m] = -1
                # Positives: the asked-for arm's strikes found by a sensitive reader inside the prompt.
                for s in getattr(clip, which_events):
                    if s['kind'] == 'strike' and s['limb'] == arm and l['start'] <= s['t'] <= l['end']:
                        y[(t >= s['onsetT'] + 40) & (t <= s['t'] + 150)] = CI[e['style']]
            else:
                y[m] = 0
        return y
    for l in clip.labels:
        if l['kind'] == 'strike' and l.get('limb') == arm and l.get('style') in CI:
            dur = l['end'] - l['start']
            m_ign = (t >= l['start']) & (t <= l['end'] + 150)
            y[m_ign] = -1
            m_pos = (t >= l['start'] + 0.2 * dur) & (t <= l['start'] + 0.65 * dur)
            y[m_pos] = CI[l['style']]
        elif l['kind'] == 'strike' and l.get('limb', '').startswith('leg'):
            pass  # legs: arms usually swing a bit; still "none" for the arms
    return y
