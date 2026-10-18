#!/bin/bash
# A recorded camera video -> a y4m Edge can use as its webcam (edge.sh start <port> <file.y4m>).
#   scripts/trailer/make-cam.sh in.webm out.y4m [crop=w:h:x:y] [slow=3] [start=0] [length=40]
# slow: each frame is held `slow` times as long (the header rate drops), for a capture run with --warp 1/slow:
# the game, running slow, then sees the person move at their real speed. Crop keeps bystanders out of frame.
set -eu
IN=$1; OUT=$2; CROP=${3:-iw:ih:0:0}; SLOW=${4:-1}; START=${5:-0}; LEN=${6:-40}
RATE=$(python3 -c "print(30/$SLOW)")
ffmpeg -v error -y -ss "$START" -t "$LEN" -i "$IN" \
  -vf "crop=$CROP,scale=trunc(iw/2)*2:trunc(ih/2)*2,fps=30,setpts=$SLOW*PTS" -r "$RATE" -pix_fmt yuv420p "$OUT"
head -c 80 "$OUT" | head -1
