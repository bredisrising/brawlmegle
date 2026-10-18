#!/bin/bash
# Screenshots of "Find a fight" (two strangers, the opponent camera, votes) in two Windows Edges on the real GPU.
#   scripts/matchmaking-shots.sh <clip A .y4m> <clip B .y4m> <out dir> [width height]
# Starts a local matchmaker and the dev server (mock forge), two headless Edges with their own profiles ("brawlmm-a",
# "brawlmm-b": never your own Edge) whose fake cameras play the clips, runs matchmaking-shots.mjs on Windows' node,
# then stops only those Edges and the servers.
set -u
CLIP_A=$1; CLIP_B=$2; OUT=$3; W=${4:-1366}; H=${5:-657}
HERE=$(cd "$(dirname "$0")" && pwd)
ROOT=$(cd "$HERE/.." && pwd)
EDGE="/mnt/c/Program Files (x86)/Microsoft/Edge/Application/msedge.exe"
NODE=${WIN_NODE:-"/mnt/c/Users/ankit/Desktop/dev/C++Tools/emsdk/node/20.18.0_64bit/bin/node.exe"}
WINTMP='C:\Users\ankit\AppData\Local\Temp\brawlmm'
LINTMP=/mnt/c/Users/ankit/AppData/Local/Temp/brawlmm
mkdir -p "$LINTMP" "$OUT"
cp -n "$CLIP_A" "$LINTMP/a.y4m"; cp -n "$CLIP_B" "$LINTMP/b.y4m"
MM_PORT=${MM_PORT:-3199}; WEB_PORT=${WEB_PORT:-5199}

(cd "$ROOT/matchmaker" && BIND=0.0.0.0 PORT=$MM_PORT exec node server.js) & MM=$!
(cd "$ROOT" && VITE_SIGNAL_URL="ws://localhost:$MM_PORT/ws" VITE_FORGE_API= exec npx vite --port $WEB_PORT --strictPort) & WEB=$!
sleep 6

kill_edges() {
  powershell.exe -NoProfile -Command "Get-CimInstance Win32_Process -Filter \"Name='msedge.exe'\" | Where-Object { \$_.CommandLine -like '*brawlmm-*' } | ForEach-Object { Stop-Process -Id \$_.ProcessId -Force -ErrorAction SilentlyContinue }" >/dev/null 2>&1
}
for who in a b; do
  port=$([ $who = a ] && echo 9351 || echo 9352)
  "$EDGE" --user-data-dir="$WINTMP\\brawlmm-$who" --remote-debugging-port=$port --headless=new \
    --no-first-run --no-default-browser-check --disable-features=msEdgeSignin,EdgeCollections \
    --autoplay-policy=no-user-gesture-required --disable-renderer-backgrounding --disable-background-timer-throttling \
    --disable-backgrounding-occluded-windows --use-fake-ui-for-media-stream --use-fake-device-for-media-stream \
    --use-file-for-fake-video-capture="$WINTMP\\$who.y4m" about:blank >/dev/null 2>&1 &
done
sleep 4
timeout 900 "$NODE" "$(wslpath -w "$HERE/matchmaking-shots.mjs")" --base "http://localhost:$WEB_PORT/" --a 9351 --b 9352 \
  --out "$WINTMP\\shots" --width "$W" --height "$H"
cp "$LINTMP"/shots/*.png "$OUT"/ 2>/dev/null
kill_edges
kill $WEB $MM 2>/dev/null
pkill -f "vite --port $WEB_PORT" 2>/dev/null
echo "shots: $OUT"
