#!/usr/bin/env bash
# The game site follows main: GitHub Actions tests and builds every push to main and publishes green builds to the
# `site` branch (.github/workflows/site.yml). This puts a new one live, checked every 30 s by a systemd timer (a check
# that finds nothing new is one small request to GitHub for the branch's latest commit).
#   sudo bash site-sync.sh install    # once: clone the site branch, install the timer
#   sudo bash site-sync.sh            # one check (what the timer runs)
#   sudo bash site-sync.sh rollback   # back to the previous build; that build stays off until a newer one arrives
# Logs: journalctl -u brawlegle-site-sync
set -euo pipefail
REPO=https://github.com/bredisrising/brawlmegle.git
SRC=/var/lib/brawlegle/site
WWW=/var/www/brawlegle
LIVE=/var/lib/brawlegle/site.live   # the site-branch commit that's live
SKIP=/var/lib/brawlegle/site.skip   # a build rolled back: not again

case "${1:-sync}" in
  install)
    [ -d "$SRC/.git" ] || git clone -q --depth 1 --branch site "$REPO" "$SRC"
    install -m 755 "$0" /usr/local/bin/brawlegle-site-sync
    cat > /etc/systemd/system/brawlegle-site-sync.service <<EOF
[Unit]
Description=Brawlmegle: put the latest green main build live

[Service]
Type=oneshot
ExecStart=/usr/local/bin/brawlegle-site-sync
EOF
    cat > /etc/systemd/system/brawlegle-site-sync.timer <<EOF
[Unit]
Description=Brawlmegle: look for a new main build every 30 s

[Timer]
OnBootSec=30s
OnUnitActiveSec=30s
# systemd would otherwise fire up to a minute late to batch wakeups.
AccuracySec=1s

[Install]
WantedBy=timers.target
EOF
    systemctl daemon-reload
    systemctl enable --now brawlegle-site-sync.timer
    echo "installed: $(systemctl is-active brawlegle-site-sync.timer)"
    ;;

  rollback)
    [ -d "$WWW/game.old" ] || { echo "no previous build to go back to"; exit 1; }
    cat "$LIVE" > "$SKIP" 2>/dev/null || true
    mv "$WWW/game" "$WWW/game.rolled-back"
    mv "$WWW/game.old" "$WWW/game"
    rm -rf "$WWW/game.rolled-back"
    echo "rolled back; build $(cat "$SKIP" 2>/dev/null) stays off until a newer one"
    ;;

  sync)
    # One check at a time (the timer, or someone running it by hand).
    exec 9>/run/brawlegle-site-sync.lock
    flock -n 9 || exit 0
    # Just the branch's latest commit first; the build itself only downloads when it's new.
    new=$(git ls-remote "$REPO" refs/heads/site | cut -f1)
    [ -n "$new" ] || exit 0
    [ "$new" = "$(cat "$LIVE" 2>/dev/null || true)" ] && exit 0
    [ "$new" = "$(cat "$SKIP" 2>/dev/null || true)" ] && exit 0
    git -C "$SRC" fetch -q --depth 1 origin site
    git -C "$SRC" reset -q --hard FETCH_HEAD
    rm -rf "$WWW/game.new"
    mkdir -p "$WWW/game.new"
    tar -C "$SRC" --exclude=.git -cf - . | tar -C "$WWW/game.new" -xf -
    # A build whose page names a bundle it doesn't have would be a blank page: keep the live one.
    bundle=$(grep -o 'assets/index-[A-Za-z0-9_-]*\.js' "$WWW/game.new/index.html" | head -1 || true)
    if [ -z "$bundle" ] || [ ! -f "$WWW/game.new/$bundle" ]; then
      echo "site: build $new is missing its bundle, not deploying"
      rm -rf "$WWW/game.new"
      exit 1
    fi
    rm -rf "$WWW/game.old"
    [ -d "$WWW/game" ] && mv "$WWW/game" "$WWW/game.old"
    mv "$WWW/game.new" "$WWW/game"
    echo "$new" > "$LIVE"
    echo "site: live $(git -C "$SRC" log -1 --format=%s) ($bundle)"
    ;;

  *)
    echo "usage: site-sync.sh [install|rollback]"
    exit 1
    ;;
esac
