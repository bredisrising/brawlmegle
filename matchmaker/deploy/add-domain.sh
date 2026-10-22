#!/usr/bin/env bash
# Serves the whole site (game, forge, matchmaker) under another domain too, next to the one setup.sh set up.
# Point the domain's A records at this box first. Safe to re-run.
#   sudo deploy/add-domain.sh brawlmegle.vip www.brawlmegle.vip
# The first name is the certificate's name. The game and the forge use whichever name a page was loaded from
# (src/config.ts PUBLIC_HOSTS, forge FORGE_PUBLIC_HOSTS), so add a new name there too.
set -euo pipefail
[ $# -ge 1 ] || { echo "usage: add-domain.sh domain [more names...]"; exit 1; }
NAME="${1//./-}"
args=()
for d in "$@"; do args+=(-d "$d"); done

# HTTP-01 through the port-80 server setup.sh made (it serves /.well-known/acme-challenge from /var/www/acme).
certbot certonly --webroot -w /var/www/acme --cert-name "$NAME" "${args[@]}" \
  --agree-tos --register-unsafely-without-email --non-interactive --keep-until-expiring --quiet

# Same site as the main server block, with this name and certificate. nginx picks it by the TLS name (SNI).
# The full site (the old sslip.io name now only redirects to brawlmegle.com, so it's no template).
SRC=/etc/nginx/sites-available/brawlmegle-com-https.conf
DST=/etc/nginx/sites-available/$NAME-https.conf
sed -E -e "s#^(\s*server_name ).*;#\1$*;#" -e "s#/etc/letsencrypt/live/[^/]+/#/etc/letsencrypt/live/$NAME/#g" "$SRC" > "$DST"
ln -sf "$DST" "/etc/nginx/sites-enabled/$NAME-https.conf"
nginx -t -q && systemctl reload nginx
echo "serving: $*"
