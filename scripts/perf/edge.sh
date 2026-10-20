#!/bin/bash
# Runtime perf run in Windows Edge from WSL, on a real GPU (see research/perf-runtime.md).
#   scripts/perf/edge.sh <label> [nvidia|amd] [run.mjs args...]
# Serves nothing itself: start `npx vite preview --port 4173 --strictPort` (or the dev server) first.
# Runs one headless Edge with its own profile (never touches a running Edge), then closes it.
set -u
LABEL=$1; GPU=${2:-nvidia}; shift 2
HERE=$(cd "$(dirname "$0")" && pwd)
EDGE="/mnt/c/Program Files (x86)/Microsoft/Edge/Application/msedge.exe"
NODE=${WIN_NODE:-"/mnt/c/Users/ankit/Desktop/dev/C++Tools/emsdk/node/20.18.0_64bit/bin/node.exe"}
# PERF_TAG / PERF_PORT: a profile name and debugging port of your own, so parallel runs never touch each other's Edge.
TAG=${PERF_TAG:-brawlperf}; PORT=${PERF_PORT:-9222}
WINTMP="C:\\Users\\ankit\\AppData\\Local\\Temp\\$TAG"
LINTMP=/mnt/c/Users/ankit/AppData/Local/Temp/$TAG
CLIP=${CLIP:-$HOME/dev/brawlegle-data/clips/40256_360.y4m}
OUTDIR=${OUTDIR:-$HERE/results}
mkdir -p "$LINTMP" "$OUTDIR"
CLIPNAME=${CLIPNAME:-clip.y4m}
[ -f "$LINTMP/$CLIPNAME" ] || cp "$CLIP" "$LINTMP/$CLIPNAME"
ADAPTER=()
# The registry makes Edge use the RTX 4070; this LUID is the Radeon 780M iGPU (an average laptop's GPU).
[ "$GPU" = amd ] && ADAPTER=(--use-adapter-luid=0,81299)
"$EDGE" --user-data-dir="$WINTMP\\profile-$GPU" --remote-debugging-port=$PORT --headless=new \
  --no-first-run --no-default-browser-check --disable-features=msEdgeSignin,EdgeCollections \
  --autoplay-policy=no-user-gesture-required --disable-renderer-backgrounding --disable-background-timer-throttling \
  --disable-backgrounding-occluded-windows --use-fake-ui-for-media-stream --use-fake-device-for-media-stream \
  --use-file-for-fake-video-capture="$WINTMP\\$CLIPNAME" "${ADAPTER[@]}" about:blank >/dev/null 2>&1 &
sleep 3
OUT_WIN="$WINTMP\\$LABEL.json"
timeout 900 "$NODE" "$(wslpath -w "$HERE/run.mjs")" --label "$LABEL" --out "$OUT_WIN" --port "$PORT" "$@"
cp "$LINTMP/$LABEL.json" "$OUTDIR/$LABEL.json" 2>/dev/null
[ -f "$LINTMP/$LABEL.error.png" ] && cp "$LINTMP/$LABEL.error.png" "$OUTDIR/"
sleep 1
"$HERE/edge-kill.sh" "$TAG"
echo "result: $OUTDIR/$LABEL.json"
