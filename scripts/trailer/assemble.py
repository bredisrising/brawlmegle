"""Screencast frames (capture.mjs) -> constant-rate video, each frame held until the next one's timestamp.
   python3 assemble.py <frames dir> <out.mp4> [fps=60] [crf=14]
Also prints frame-interval stats (stutter check) and writes marks.json: each mark's time in the output video."""
import json, os, statistics, subprocess, sys

src, out = sys.argv[1], sys.argv[2]
fps = int(sys.argv[3]) if len(sys.argv) > 3 else 60
crf = sys.argv[4] if len(sys.argv) > 4 else "14"
rows = [l.split() for l in open(os.path.join(src, "frames.txt")) if l.strip()]
# A warped capture (capture.mjs --warp k): wall time -> game time.
wpath = os.path.join(src, "warp.json")
warp = json.load(open(wpath)) if os.path.exists(wpath) else {"K": 1, "W0": None}
K, W0 = warp["K"], warp["W0"]
game = (lambda t: (t - W0) * K) if W0 else (lambda t: t)
frames = [(f"f{int(i):06d}.jpg", game(float(t))) for i, t in rows]
frames = [f for f in frames if os.path.exists(os.path.join(src, f[0]))]
t0 = frames[0][1]
gaps = [b[1] - a[1] for a, b in zip(frames, frames[1:])]
print(f"{len(frames)} frames, {frames[-1][1] - t0:.1f} s, interval median {statistics.median(gaps) * 1000:.1f} ms,"
      f" p95 {sorted(gaps)[int(len(gaps) * 0.95)] * 1000:.1f} ms, max {max(gaps) * 1000:.0f} ms, >60ms: {sum(g > 0.06 for g in gaps)}")
lst = os.path.join(src, "concat.txt")
with open(lst, "w") as f:
    for (name, t), g in zip(frames, gaps + [1 / 30]):
        f.write(f"file '{name}'\nduration {g:.6f}\n")
    f.write(f"file '{frames[-1][0]}'\n")
marks = {}
mpath = os.path.join(src, "marks.txt")
if os.path.exists(mpath):
    for l in open(mpath):
        if l.strip():
            k, v = l.split()
            marks[k] = round(game(float(v)) - t0, 3)
json.dump({"t0": t0, "K": K, "W0": W0, "marks": marks, "duration": frames[-1][1] - t0}, open(os.path.join(src, "marks.json"), "w"), indent=1)
print("marks", marks)
subprocess.run(["ffmpeg", "-v", "error", "-y", "-f", "concat", "-safe", "0", "-i", lst, "-vf", f"fps={fps},format=yuv420p",
                "-c:v", "libx264", "-preset", "medium", "-crf", crf, out], check=True)
print("wrote", out)
