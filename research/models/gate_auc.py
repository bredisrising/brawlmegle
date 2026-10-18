"""Q1a, part 2: how well can anything tell the reader's real strikes from its fakes on REAL clips?
AUC of P(not a strike) under leave-one-session-out, for models trained on synthetic (+ other real sessions),
on real sessions only, and for single hand-picked features. Also style accuracy with real-only training.

python -I research/models/gate_auc.py DUMP_DIR
"""
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import numpy as np
from sklearn.metrics import roc_auc_score

from moves import CI, CLASSES, READER_FEATURES, events_table, load_all
from style_events import REAL, fit_predict, models, summary, fmt, decide

NAMES = ['side', 'peak.x', 'peak.y', 'peak.z', 'midOut', 'midRise', 'ext', 'elbow', 'anchor.x', 'anchor.y', 'end.x', 'end.y',
         'reach', 'rawSpeed', 'dir.out', 'dir.up', 'dir.fwd', 'high',
         'dw.x', 'dw.y', 'dw.z', 'de.x', 'de.y', 'de.z', 'dh.x', 'dh.y', 'wr0.x', 'wr0.y', 'wr1.x', 'wr1.y', 'el1.x', 'el1.y', 'wrk.x', 'wrk.y',
         'eang0', 'eang1', 'eangOpen', 'path', 'net', 'path/net', 'area', 'spW', 'spE', 'spOther', 'cosOther', 'dOther', 'dNose.x', 'dNose.y',
         'swRatio', 'dur', 'visW', 'visE', 'wristToNose']


def main():
    ev = events_table(load_all(sys.argv[1]))
    synth = [e for e in ev if e['source'] == 'synth']
    real = {r: [e for e in ev if e['clip'] == r] for r in REAL}
    allreal = [e for r in REAL for e in real[r]]
    y_fake = np.array([e['gt'] == 'none' for e in allreal])
    X = np.array([e['x'] for e in allreal])
    assert len(NAMES) == X.shape[1], (len(NAMES), X.shape[1])

    print(f'real events {len(allreal)}: {y_fake.sum()} fakes, {(~y_fake).sum()} real strikes')
    print('\n== single features, AUC for "fake" (0.5 = useless; <0.5 means low values are fakes)')
    aucs = [(abs(roc_auc_score(y_fake, X[:, j]) - 0.5), roc_auc_score(y_fake, X[:, j]), NAMES[j]) for j in range(X.shape[1])]
    for _, a, n in sorted(aucs, reverse=True)[:10]:
        print(f'  {n:12s} {a:.2f}')
    # Synthetic, same features: is the same feature informative there?
    ys = np.array([e['gt'] == 'none' for e in synth])
    Xs = np.array([e['x'] for e in synth])
    print('  (same features on synthetic: ' + ', '.join(f'{n} {roc_auc_score(ys, Xs[:, NAMES.index(n)]):.2f}' for _, _, n in sorted(aucs, reverse=True)[:6]) + ')')

    feats = {'reader': np.arange(READER_FEATURES), 'all': np.arange(X.shape[1])}
    for train_on in ('synth+real', 'real only'):
        print(f'\n== leave-one-session-out, train on {train_on}: AUC of P(none) for fakes, and the style picked on real strikes')
        for mname, make in models().items():
            for fname, cols in feats.items():
                p_none, gts, sty, rules = [], [], [], []
                for name in REAL:
                    tr = ([] if train_on == 'real only' else synth) + [e for r in REAL if r != name for e in real[r]]
                    te = real[name]
                    _, P = fit_predict(make, tr, te, cols, 1.0 if train_on == 'real only' else 20.0)
                    p_none += list(P[:, 0])
                    gts += [e['gt'] for e in te]
                    sty += decide(P, [e['rule'] for e in te], 'style')
                    rules += [e['rule'] for e in te]
                p_none = np.array(p_none)
                g = np.array(gts)
                auc = roc_auc_score(g == 'none', p_none)
                # Operating point: reject the most fake-looking events until 90% of real strikes survive.
                thr = np.quantile(p_none[g != 'none'], 0.9)
                kept = np.mean(p_none[g != 'none'] < thr)
                fk = np.mean(p_none[g == 'none'] < thr)
                s = summary(gts, sty)
                print(f'  {mname:6s} {fname:6s} AUC {auc:.2f}  at 90% strikes kept: {100 * fk:3.0f}% of fakes still pass | style {s["style_ok"]}/{s["strikes"]} (rules {summary(gts, rules)["style_ok"]})')


if __name__ == '__main__':
    main()
