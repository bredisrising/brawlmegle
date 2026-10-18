"""sync.py game.mp4 pipcrop(w:h:x:y) source.webm srccrop(w:h:x:y) [from_s to_s]
Finds where the camera file was when the game showed each moment: source_time = (game_time + offset) mod L.
Matches motion energy of the in-game camera picture (PiP) against the source video's."""
import subprocess, sys
import numpy as np
game, pip, src, scrop = sys.argv[1:5]
g0 = float(sys.argv[5]) if len(sys.argv) > 5 else 0
g1 = float(sys.argv[6]) if len(sys.argv) > 6 else 1e9
FPS = 30
W, H = 64, 48

def frames(path, crop, ss=0, t=None):
    cmd = ['ffmpeg', '-v', 'error', '-ss', str(ss)] + (['-t', str(t)] if t else []) + ['-i', path, '-vf', f'crop={crop},fps={FPS},scale={W}:{H},format=gray', '-f', 'rawvideo', '-']
    raw = subprocess.run(cmd, capture_output=True).stdout
    return np.frombuffer(raw, np.uint8).reshape(-1, H, W).astype(np.float32)

def energy(fr):
    d = np.abs(np.diff(fr, axis=0)).mean((1, 2))
    return (d - d.mean()) / (d.std() + 1e-6)

gf = frames(game, pip, g0, None if g1 > 1e8 else g1 - g0)
sf = frames(src, scrop)
eg, es = energy(gf), energy(sf)
L = len(es)
best = []
for off in range(L):
    idx = (np.arange(len(eg)) + off) % L
    best.append((float((eg * es[idx]).mean()), off))
best.sort(reverse=True)
print('source length', L / FPS, 's; game window', g0, len(eg) / FPS)
for score, off in best[:5]:
    print(f'offset {off / FPS - g0:.3f} s (source = game + offset, mod {L / FPS:.2f}) score {score:.3f}')
