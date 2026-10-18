#!/usr/bin/env bash
# Sets up the matchmaker box (Ubuntu 24.04): Node app, coturn, nginx and a Let's Encrypt cert.
# Port 443 is split by hostname: DOMAIN goes to the matchmaker, TURN_DOMAIN goes to coturn (TURN over TLS),
# so both get through networks that only allow HTTPS. Safe to re-run, e.g. after a code change or a new domain.
#
# Usage, from a copy of the matchmaker folder on the server:
#   sudo DOMAIN=match.example.com TURN_DOMAIN=turn.example.com deploy/setup.sh
set -euo pipefail
: "${DOMAIN:?set DOMAIN}"
: "${TURN_DOMAIN:?set TURN_DOMAIN}"

SRC="$(cd "$(dirname "$0")/.." && pwd)"
APP=/opt/brawlegle/matchmaker
CERT=/etc/letsencrypt/live/brawlegle
export DEBIAN_FRONTEND=noninteractive

token=$(curl -fsS -X PUT http://169.254.169.254/latest/api/token -H "X-aws-ec2-metadata-token-ttl-seconds: 60")
metadata() { curl -fsS -H "X-aws-ec2-metadata-token: $token" "http://169.254.169.254/latest/meta-data/$1"; }
PUBLIC_IP=$(metadata public-ipv4)
PRIVATE_IP=$(metadata local-ipv4)

echo "== packages"
if ! node --version 2>/dev/null | grep -q '^v22'; then
  curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
fi
# Keep coturn from starting with its default (open) config before ours is written.
printf '#!/bin/sh\nexit 101\n' > /usr/sbin/policy-rc.d && chmod 755 /usr/sbin/policy-rc.d
trap 'rm -f /usr/sbin/policy-rc.d' EXIT
apt-get update -q
apt-get install -yq nodejs nginx libnginx-mod-stream certbot coturn
rm -f /usr/sbin/policy-rc.d

echo "== app"
id brawlegle >/dev/null 2>&1 || useradd --system --home-dir /opt/brawlegle --shell /usr/sbin/nologin brawlegle
install -d "$APP"
cp "$SRC/package.json" "$SRC/package-lock.json" "$SRC/server.js" "$APP/"
rm -rf "$APP/public" && cp -r "$SRC/public" "$APP/public"
(cd "$APP" && npm ci --omit=dev --no-audit --no-fund --silent)

# The TURN secret is generated once on the server and never leaves it.
install -d -m 700 /etc/brawlegle
[ -s /etc/brawlegle/turn-secret ] || (umask 077 && openssl rand -hex 32 > /etc/brawlegle/turn-secret)
SECRET=$(cat /etc/brawlegle/turn-secret)
(umask 077 && cat > /etc/brawlegle/matchmaker.env <<EOF
PORT=3000
BIND=127.0.0.1
SAMPLES_DIR=/var/lib/brawlegle/samples
TURN_HOST=$TURN_DOMAIN
TURN_SECRET=$SECRET
EOF
)

cat > /etc/systemd/system/brawlegle-matchmaker.service <<'EOF'
[Unit]
Description=Brawlegle matchmaker
After=network-online.target
Wants=network-online.target

[Service]
User=brawlegle
Group=brawlegle
WorkingDirectory=/opt/brawlegle/matchmaker
EnvironmentFile=/etc/brawlegle/matchmaker.env
ExecStart=/usr/bin/node server.js
Restart=always
RestartSec=2
MemoryMax=300M
NoNewPrivileges=true
ProtectSystem=strict
ProtectHome=true
PrivateTmp=true
PrivateDevices=true
ProtectKernelTunables=true
ProtectControlGroups=true
RestrictAddressFamilies=AF_INET AF_INET6 AF_UNIX
# Writable: /var/lib/brawlegle (training samples from the tuner's guided test).
StateDirectory=brawlegle

[Install]
WantedBy=multi-user.target
EOF
systemctl daemon-reload
systemctl enable -q brawlegle-matchmaker
systemctl restart brawlegle-matchmaker

echo "== nginx (port 80) and certificate"
rm -f /etc/nginx/sites-enabled/default
install -d /var/www/acme
cat > /etc/nginx/sites-available/brawlegle-http.conf <<'EOF'
server {
  listen 80 default_server;
  server_name _;
  location /.well-known/acme-challenge/ { root /var/www/acme; }
  location / { return 301 https://$host$request_uri; }
}
EOF
ln -sf /etc/nginx/sites-available/brawlegle-http.conf /etc/nginx/sites-enabled/brawlegle-http.conf
nginx -t -q && systemctl restart nginx

certbot certonly --webroot -w /var/www/acme --cert-name brawlegle -d "$DOMAIN" -d "$TURN_DOMAIN" \
  --agree-tos --register-unsafely-without-email --non-interactive --keep-until-expiring --quiet

# coturn can't read certbot's files, so copy them to it on every issue and renewal.
cat > /etc/letsencrypt/renewal-hooks/deploy/brawlegle.sh <<EOF
#!/bin/sh
install -d -m 750 -o root -g turnserver /etc/coturn/certs
install -m 640 -o root -g turnserver $CERT/fullchain.pem /etc/coturn/certs/fullchain.pem
install -m 640 -o root -g turnserver $CERT/privkey.pem /etc/coturn/certs/privkey.pem
systemctl restart coturn || true
systemctl reload nginx || true
EOF
chmod 755 /etc/letsencrypt/renewal-hooks/deploy/brawlegle.sh

echo "== coturn"
cat > /etc/turnserver.conf <<EOF
# Written by brawlegle deploy/setup.sh
listening-port=3478
tls-listening-port=5349
# Always relay from the private IP (which maps to the public one). Without this, players coming in
# through nginx on port 443 arrive over loopback and get useless 127.0.0.1 relay addresses.
relay-ip=$PRIVATE_IP
external-ip=$PUBLIC_IP/$PRIVATE_IP
min-port=49152
max-port=49999
realm=$TURN_DOMAIN
use-auth-secret
static-auth-secret=$SECRET
fingerprint
cert=/etc/coturn/certs/fullchain.pem
pkey=/etc/coturn/certs/privkey.pem
no-tlsv1
no-tlsv1_1
no-cli
no-multicast-peers
no-tcp-relay
stale-nonce=600
syslog
# Bandwidth caps in bytes per second: about 1 Mbps per session and 10 Mbps total, so abuse can't run up a bill.
max-bps=125000
bps-capacity=1250000
user-quota=12
total-quota=400
# Never relay into private networks or the EC2 metadata service. Our own private IP stays allowed so
# two players relaying through this same server can reach each other.
allowed-peer-ip=$PRIVATE_IP
denied-peer-ip=0.0.0.0-0.255.255.255
denied-peer-ip=10.0.0.0-10.255.255.255
denied-peer-ip=100.64.0.0-100.127.255.255
denied-peer-ip=127.0.0.0-127.255.255.255
denied-peer-ip=169.254.0.0-169.254.255.255
denied-peer-ip=172.16.0.0-172.31.255.255
denied-peer-ip=192.0.0.0-192.0.0.255
denied-peer-ip=192.168.0.0-192.168.255.255
denied-peer-ip=198.18.0.0-198.19.255.255
denied-peer-ip=::1
denied-peer-ip=fc00::-fdff:ffff:ffff:ffff:ffff:ffff:ffff:ffff
denied-peer-ip=fe80::-febf:ffff:ffff:ffff:ffff:ffff:ffff:ffff
EOF
chown root:turnserver /etc/turnserver.conf
chmod 640 /etc/turnserver.conf
[ -f /etc/default/coturn ] && sed -i 's/^#\?TURNSERVER_ENABLED=.*/TURNSERVER_ENABLED=1/' /etc/default/coturn
systemctl enable -q coturn
systemctl enable -q --now certbot.timer   # renewals; install skipped starting it
/etc/letsencrypt/renewal-hooks/deploy/brawlegle.sh   # copies certs, restarts coturn

echo "== nginx (port 443)"
cat > /etc/nginx/sites-available/brawlegle-https.conf <<EOF
server {
  listen 127.0.0.1:8443 ssl;
  server_name $DOMAIN;
  ssl_certificate $CERT/fullchain.pem;
  ssl_certificate_key $CERT/privkey.pem;
  client_max_body_size 12m;
  location /ws {
    proxy_pass http://127.0.0.1:3000;
    proxy_http_version 1.1;
    proxy_set_header Upgrade \$http_upgrade;
    proxy_set_header Connection "upgrade";
    proxy_set_header Host \$host;
    proxy_read_timeout 120s;
  }
  # The forge (scan -> fighter), running as brawlegle-forge (forge/deploy/setup-forge.sh). 502 until it's installed.
  location /api/ {
    proxy_pass http://127.0.0.1:8787;
    proxy_set_header Host \$host;
    proxy_read_timeout 120s;
    client_max_body_size 25m;
  }
  # Static dev tools (intent tuner, depth test, scan test), each copied to /var/www/brawlegle/<name>/.
  location ~ ^/(tuner|depth|scan)/ {
    root /var/www/brawlegle;
    try_files \$uri \$uri/ /\$1/index.html;
  }
  # Matchmaker extras (health, training-sample uploads, its WebRTC test page at /mm-test).
  location = /health { proxy_pass http://127.0.0.1:3000; }
  location = /samples { proxy_pass http://127.0.0.1:3000; }
  location = /mm-test { proxy_pass http://127.0.0.1:3000/; }
  # Everything else is the game itself (a static build in /var/www/brawlegle/game), one site for everyone.
  # index.html is always revalidated, so a laptop never runs a stale page that points at deleted bundles.
  location / {
    root /var/www/brawlegle/game;
    try_files \$uri \$uri/ /index.html;
    add_header Cache-Control "no-cache";
  }
  # Hashed bundles never change. A missing one is a 404, not index.html served as JavaScript (a blank page).
  location /assets/ {
    root /var/www/brawlegle/game;
    try_files \$uri =404;
    add_header Cache-Control "public, max-age=31536000, immutable";
  }
}
EOF
install -d /var/www/brawlegle
ln -sf /etc/nginx/sites-available/brawlegle-https.conf /etc/nginx/sites-enabled/brawlegle-https.conf
install -d /etc/nginx/stream.d
grep -q 'stream.d' /etc/nginx/nginx.conf || printf '\nstream { include /etc/nginx/stream.d/*.conf; }\n' >> /etc/nginx/nginx.conf
cat > /etc/nginx/stream.d/brawlegle.conf <<EOF
# Route port 443 by the hostname in the TLS handshake, without decrypting.
map \$ssl_preread_server_name \$brawlegle_backend {
  $TURN_DOMAIN 127.0.0.1:5349;
  default 127.0.0.1:8443;
}
server {
  listen 443;
  ssl_preread on;
  proxy_pass \$brawlegle_backend;
  proxy_timeout 1h;
}
EOF
nginx -t -q && systemctl reload nginx

echo "== checks"
sleep 1
systemctl is-active brawlegle-matchmaker coturn nginx
curl -fsS http://127.0.0.1:3000/health && echo
echo "matchmaker: wss://$DOMAIN/ws   test page: https://$DOMAIN/"
