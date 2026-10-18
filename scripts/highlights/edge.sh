#!/bin/bash
# Headless Windows Edge (RTX 4070) for highlight work, from WSL, with its own profile and debugging port.
#   scripts/highlights/edge.sh start [port]   |   scripts/highlights/edge.sh stop
# Then run a script with the Windows node (see shots.mjs / seed.mjs). Only ever kills Edge processes started with
# the brawlhl profile, never your own Edge or another run's.
set -u
CMD=${1:-start}; PORT=${2:-9444}
EDGE="/mnt/c/Program Files (x86)/Microsoft/Edge/Application/msedge.exe"
WINTMP='C:\Users\ankit\AppData\Local\Temp\brawlhl'
mkdir -p /mnt/c/Users/ankit/AppData/Local/Temp/brawlhl
if [ "$CMD" = stop ]; then
  powershell.exe -NoProfile -Command "Get-CimInstance Win32_Process -Filter \"Name='msedge.exe'\" | Where-Object { \$_.CommandLine -like '*brawlhl*' } | ForEach-Object { Stop-Process -Id \$_.ProcessId -Force -ErrorAction SilentlyContinue }" >/dev/null 2>&1
  exit 0
fi
# --disable-web-security: a dev server on a port the shared forge doesn't list can still load its fighters.
"$EDGE" --user-data-dir="$WINTMP\\profile-brawlhl" --remote-debugging-port="$PORT" --headless=new \
  --no-first-run --no-default-browser-check --disable-features=msEdgeSignin,EdgeCollections \
  --autoplay-policy=no-user-gesture-required --disable-renderer-backgrounding --disable-background-timer-throttling \
  --disable-backgrounding-occluded-windows --disable-web-security about:blank >/dev/null 2>&1 &
sleep 3
echo "edge (brawlhl) on $PORT"
