#!/usr/bin/env bash
# Runs the forge on the matchmaker box as a service, behind nginx at /api/ (see matchmaker/deploy/setup.sh).
# Secrets go in /etc/brawlegle/forge.env (root-only), written separately: OPENAI_API_KEY, ELEVENLABS_API_KEY,
# FORGE_ACCESS_KEY, FORGE_3D_KEY, FORGE_GPU_WAKER_KEY. Safe to re-run.
# Usage, from a copy of the forge folder on the server: sudo deploy/setup-forge.sh
set -euo pipefail
SRC="$(cd "$(dirname "$0")/.." && pwd)"
APP=/opt/brawlegle/forge
[ -s /etc/brawlegle/forge.env ] || { echo "missing /etc/brawlegle/forge.env"; exit 1; }
install -d "$APP"
# Every top-level module and data file the server imports (a new module missed here crash-loops the service), and the
# admin scripts (delete-fighter.mjs).
cp "$SRC"/*.js "$SRC"/*.mjs "$SRC"/*.json "$APP/"
rm -rf "$APP/public" && cp -r "$SRC/public" "$APP/public"
# The fighter optimizer's packages (gltf-transform, meshoptimizer, sharp with its prebuilt arm64 libvips).
(cd "$APP" && npm ci --omit=dev --no-audit --no-fund --silent)

cat > /etc/systemd/system/brawlegle-forge.service <<'UNIT'
[Unit]
Description=Brawlegle forge (scan -> fighter)
After=network-online.target
Wants=network-online.target

[Service]
User=brawlegle
Group=brawlegle
WorkingDirectory=/opt/brawlegle/forge
EnvironmentFile=/etc/brawlegle/forge.env
Environment=FORGE_BIND=127.0.0.1 FORGE_PORT=8787 FORGE_DATA=/var/lib/brawlegle/forge FORGE_PUBLIC_URL=https://54-149-60-196.sslip.io
ExecStart=/usr/bin/node server.js
Restart=always
RestartSec=2
# A fighter optimization (optimize.js, one at a time) peaks at ~200 MB on top of the server.
MemoryMax=600M
NoNewPrivileges=true
ProtectSystem=strict
ProtectHome=true
PrivateTmp=true
StateDirectory=brawlegle

[Install]
WantedBy=multi-user.target
UNIT
systemctl daemon-reload
systemctl enable -q brawlegle-forge
systemctl restart brawlegle-forge
sleep 1
systemctl is-active brawlegle-forge
curl -fsS http://127.0.0.1:8787/health && echo
