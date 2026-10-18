#!/bin/bash
# Windows Edge (RTX 4070) for trailer captures, from WSL, with its own profile and debugging port.
#   scripts/trailer/edge.sh start [port] [camera.y4m] [headed]   |   scripts/trailer/edge.sh stop
# camera.y4m (a WSL path) becomes the webcam, so a recorded person drives the game. Only ever kills Edge processes
# started with the brawltrailer profile, never your own Edge or another run's.
set -u
CMD=${1:-start}; PORT=${2:-9555}; CAM=${3:-}; MODE=${4:-headless}
EDGE="/mnt/c/Program Files (x86)/Microsoft/Edge/Application/msedge.exe"
WINTMP='C:\Users\ankit\AppData\Local\Temp\brawltrailer'
LINTMP=/mnt/c/Users/ankit/AppData/Local/Temp/brawltrailer
mkdir -p "$LINTMP"
if [ "$CMD" = stop ]; then
  powershell.exe -NoProfile -Command "Get-CimInstance Win32_Process -Filter \"Name='msedge.exe'\" | Where-Object { \$_.CommandLine -like '*brawltrailer*' } | ForEach-Object { Stop-Process -Id \$_.ProcessId -Force -ErrorAction SilentlyContinue }" >/dev/null 2>&1
  exit 0
fi
FAKE=(--use-fake-ui-for-media-stream --use-fake-device-for-media-stream)
if [ -n "$CAM" ]; then
  cp "$CAM" "$LINTMP/cam-$PORT.y4m"
  FAKE+=(--use-file-for-fake-video-capture="$WINTMP\\cam-$PORT.y4m")
fi
HEAD=(--headless=new)
[ "$MODE" = headed ] && HEAD=(--window-position=0,0 --window-size=1920,1080)
# --disable-web-security: a local build on a port the shared forge doesn't list can still load its fighters.
"$EDGE" --user-data-dir="$WINTMP\\profile-$PORT" --remote-debugging-port="$PORT" "${HEAD[@]}" \
  --no-first-run --no-default-browser-check --disable-features=msEdgeSignin,EdgeCollections \
  --autoplay-policy=no-user-gesture-required --disable-renderer-backgrounding --disable-background-timer-throttling \
  --disable-backgrounding-occluded-windows --disable-web-security "${FAKE[@]}" about:blank >/dev/null 2>&1 &
sleep 3
echo "edge (brawltrailer) on $PORT"
