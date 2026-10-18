"""Q1a: re-judge the reader's arm strikes with a small learned model (style + reject), vs the rules.

python -I research/models/style_events.py DUMP_DIR [--sensitive]
"""
import os
import sys
from collections import Counter

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import numpy as np
from sklearn.ensemble import HistGradientBoostingClassifier
from sklearn.linear_model import LogisticRegression
from sklearn.neighbors import KNeighborsClassifier
from sklearn.neural_network import MLPClassifier
from sklearn.pipeline import make_pipeline
from sklearn.preprocessing import StandardScaler

from moves import CLASSES, CI, READER_FEATURES, events_table, load_all

REAL = ['guided-guided-233104', 'guided-guided-233624', 'stock-36564', 'stock-40256', 'stock-49576']
FRIEND, USER = 'guided-guided-233104', 'guided-guided-233624'


def models():
    return {
        'gbt': lambda: HistGradientBoostingClassifier(max_iter=250, learning_rate=0.08, max_leaf_nodes=15, l2_regularization=1.0, random_state=0),
        'mlp': lambda: make_pipeline(StandardScaler(), MLPClassifier(hidden_layer_sizes=(32, 16), alpha=1e-3, max_iter=600, early_stopping=True, random_state=0)),
        'knn': lambda: make_pipeline(StandardScaler(), KNeighborsClassifier(n_neighbors=7, weights='distance')),
        'logreg': lambda: make_pipeline(StandardScaler(), LogisticRegression(max_iter=2000, C=1.0)),
    }


def conf(gt, pred):
    m = np.zeros((4, 4), dtype=int)
    for g, p in zip(gt, pred):
        m[CI[g], CI[p]] += 1
    return m


def summary(gt, pred):
    gt, pred = np.array(gt), np.array(pred)
    real = gt != 'none'
    fake = ~real
    return dict(
        n=len(gt), strikes=int(real.sum()), fakes=int(fake.sum()),
        style_ok=int(((pred == gt) & real).sum()),
        kept=int(((pred != 'none') & real).sum()),
        fakes_left=int(((pred != 'none') & fake).sum()),
    )


def fmt(s):
    st = s['strikes'] or 1
    return (f"n={s['n']:4d}  true strikes {s['strikes']:4d}: right style {s['style_ok']:4d} ({100 * s['style_ok'] / st:3.0f}%), kept {s['kept']:4d} ({100 * s['kept'] / st:3.0f}%)  "
            f"| fakes {s['fakes']:4d}: still emitted {s['fakes_left']:4d}")


def print_conf(m, title):
    print(f'    {title}: rows = truth, cols = predicted ' + ' '.join(f'{c:>8s}' for c in CLASSES))
    for i, c in enumerate(CLASSES):
        print(f'    {"":{len(title) + 2}s}{c:>36s} ' + ' '.join(f'{v:8d}' for v in m[i]))


def fit_predict(make, train, test, cols, real_weight):
    X = np.array([e['x'][cols] for e in train])
    y = np.array([CI[e['gt']] for e in train])
    w = np.array([real_weight if e['source'] != 'synth' else 1.0 for e in train])
    # Balance classes a bit: fakes are plentiful in synthetic data.
    cnt = Counter(y.tolist())
    w = w * np.array([len(y) / (4 * cnt[v]) for v in y]) ** 0.5
    clf = make()
    try:
        clf.fit(X, y, sample_weight=w) if not hasattr(clf, 'steps') else clf.fit(X, y, **{clf.steps[-1][0] + '__sample_weight': w})
    except TypeError:
        clf.fit(X, y)
    if len(test) == 0:
        return clf, []
    P = clf.predict_proba(np.array([e['x'][cols] for e in test]))
    full = np.zeros((len(test), 4))
    full[:, clf.classes_] = P
    return clf, full


def decide(P, rule, mode, reject_at=0.5):
    """mode: 'full' = model picks style and may reject; 'style' = style only; 'gate' = rules' style, model may reject."""
    out = []
    for p, r in zip(P, rule):
        if mode in ('full', 'gate') and p[0] >= reject_at:
            out.append('none')
            continue
        if mode == 'gate':
            out.append(r)
            continue
        out.append(CLASSES[1 + int(np.argmax(p[1:]))])
    return out


def main():
    dump = sys.argv[1]
    which = 'sensitive' if '--sensitive' in sys.argv else 'intents'
    clips = load_all(dump)
    ev = events_table(clips, which)
    print(f'{len(ev)} arm strike events from the {"sensitive" if which == "sensitive" else "default"} reader')
    by = Counter((e['source'] if e['source'] == 'synth' else e['clip'], e['gt']) for e in ev)
    for k in sorted(by):
        print('   ', k, by[k])
    nfeat = len(ev[0]['x'])
    feats = {'reader': np.arange(READER_FEATURES), 'all': np.arange(nfeat)}

    synth = [e for e in ev if e['source'] == 'synth']
    real = {r: [e for e in ev if e['clip'] == r] for r in REAL}

    # --- rules on each set
    print('\n== rules (current reader), on the same events')
    for name, sub in [('synth (all)', synth)] + list(real.items()):
        s = summary([e['gt'] for e in sub], [e['rule'] for e in sub])
        print(f'  {name:24s} {fmt(s)}')
    for name in [USER, 'stock-40256']:
        print_conf(conf([e['gt'] for e in real[name]], [e['rule'] for e in real[name]]), f'rules {name}')
    real_all = [e for r in REAL for e in real[r]]
    print_conf(conf([e['gt'] for e in real_all], [e['rule'] for e in real_all]), 'rules all real')

    # --- in-domain check: synthetic seeds 1-4 -> seed 5
    print('\n== synthetic, train seeds 1-4, test seed 5')
    tr = [e for e in synth if e['session'] != 'synth-seed5']
    te = [e for e in synth if e['session'] == 'synth-seed5']
    s = summary([e['gt'] for e in te], [e['rule'] for e in te])
    print(f'  rules        {fmt(s)}')
    for mname, make in models().items():
        for fname, cols in feats.items():
            _, P = fit_predict(make, tr, te, cols, 1.0)
            s = summary([e['gt'] for e in te], decide(P, [e['rule'] for e in te], 'full'))
            print(f'  {mname:6s} {fname:6s} {fmt(s)}')

    # --- synthetic (+ friend's guided) -> user's guided and the stock clips
    for rw in (1.0, 20.0):
        print(f'\n== train synthetic + friend guided (real weight {rw:g}), test the other real sessions')
        tr = synth + real[FRIEND]
        for mname, make in models().items():
            for fname, cols in feats.items():
                for name in [USER, 'stock-36564', 'stock-40256', 'stock-49576']:
                    te = real[name]
                    _, P = fit_predict(make, tr, te, cols, rw)
                    for mode in ('full', 'style', 'gate'):
                        s = summary([e['gt'] for e in te], decide(P, [e['rule'] for e in te], mode))
                        if mode == 'full' or mname == 'gbt':
                            print(f'  {mname:6s} {fname:6s} {mode:5s} {name:22s} {fmt(s)}')

    # --- leave one real session out (train: synthetic + the other real sessions)
    print('\n== leave-one-session-out over the real sessions (train synthetic + the other 4)')
    for rw in (1.0, 20.0):
        for mname, make in models().items():
            for fname, cols in feats.items():
                gts, preds, rules, gate, sty = [], [], [], [], []
                for name in REAL:
                    tr = synth + [e for r in REAL if r != name for e in real[r]]
                    te = real[name]
                    _, P = fit_predict(make, tr, te, cols, rw)
                    gts += [e['gt'] for e in te]
                    rules += [e['rule'] for e in te]
                    preds += decide(P, [e['rule'] for e in te], 'full')
                    gate += decide(P, [e['rule'] for e in te], 'gate')
                    sty += decide(P, [e['rule'] for e in te], 'style')
                print(f'  w{rw:<3g} {mname:6s} {fname:6s} full  {fmt(summary(gts, preds))}')
                print(f'  w{rw:<3g} {mname:6s} {fname:6s} style {fmt(summary(gts, sty))}')
                print(f'  w{rw:<3g} {mname:6s} {fname:6s} gate  {fmt(summary(gts, gate))}')
                if mname == 'gbt' and fname == 'all' and rw == 20.0:
                    print_conf(conf(gts, preds), 'LOSO gbt all w20')
    print(f'  rules                     {fmt(summary(gts, rules))}')


if __name__ == '__main__':
    main()
