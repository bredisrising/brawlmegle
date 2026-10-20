#!/bin/bash
# The GPU box's waker, on bingus (where the AWS CLI and its key live; the game server never gets an AWS key). The box
# powers itself off after FORGE3D_IDLE_STOP_MIN idle minutes (server.py); this starts it again when the game server
# says a forge wants it (GET /api/gpu/wanted: someone opened the scan in the last 10 min, or a forge is waiting on it).
#   install: bash waker.sh install   (a user service, brawlegle-gpu-waker; needs ~/.config/brawlegle/waker-key, the
#            game server's FORGE_GPU_WAKER_KEY)        logs: journalctl --user -u brawlegle-gpu-waker -f
set -u
AWS=${AWS:-$HOME/.local/bin/aws}
REGION=${FORGE3D_REGION:-us-east-1}
INSTANCE=${FORGE3D_INSTANCE:-i-02b680f2662c0b82f}
URL=${WAKER_URL:-https://brawlmegle.vip/api/gpu/wanted}
KEY_FILE=$HOME/.config/brawlegle/waker-key

if [ "${1:-}" = install ]; then
  mkdir -p ~/.config/systemd/user ~/.local/bin
  cp "$0" ~/.local/bin/brawlegle-gpu-waker.sh
  cat >~/.config/systemd/user/brawlegle-gpu-waker.service <<UNIT
[Unit]
Description=Brawlmegle GPU box waker

[Service]
ExecStart=/bin/bash %h/.local/bin/brawlegle-gpu-waker.sh
Restart=always
RestartSec=10

[Install]
WantedBy=default.target
UNIT
  systemctl --user daemon-reload
  systemctl --user enable --now brawlegle-gpu-waker
  exit 0
fi

KEY=$(cat "$KEY_FILE")
last=0
while true; do
  if curl -fsS -m 5 -H "x-waker-key: $KEY" "$URL" 2>/dev/null | grep -q '"wanted":true'; then
    state=$($AWS ec2 describe-instances --region "$REGION" --instance-ids "$INSTANCE" --query 'Reservations[0].Instances[0].State.Name' --output text 2>/dev/null)
    # Stopping (it just powered itself off): next round, once it's stopped.
    if [ "$state" = stopped ] && [ $(($(date +%s) - last)) -ge 30 ]; then
      last=$(date +%s)
      echo "wanted and $state: starting $INSTANCE"
      $AWS ec2 start-instances --region "$REGION" --instance-ids "$INSTANCE" --query 'StartingInstances[0].CurrentState.Name' --output text
    fi
  fi
  sleep 5
done
