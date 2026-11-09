#!/bin/bash
# Sunfall one-shot server setup (Ubuntu 22.04/24.04). Paste as the server's startup script, or run as root.
# One line on a fresh Ubuntu server, as root:
#   curl -fsSL https://raw.githubusercontent.com/devved2/sunfall/main/sunfall/deploy/setup.sh | bash
set -e
export DEBIAN_FRONTEND=noninteractive
REPO=https://github.com/devved2/sunfall
apt-get update -y
apt-get install -y git curl ca-certificates gnupg openssl debian-keyring debian-archive-keyring apt-transport-https
# Node 22
curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
apt-get install -y nodejs
# Caddy (automatic HTTPS)
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' -o /etc/apt/sources.list.d/caddy-stable.list
apt-get update -y && apt-get install -y caddy
# App
id sunfall >/dev/null 2>&1 || useradd -r -m -d /opt/sunfall -s /usr/sbin/nologin sunfall
rm -rf /opt/sunfall/repo && git clone --depth 1 "$REPO" /opt/sunfall/repo
mkdir -p /var/lib/sunfall && chown -R sunfall:sunfall /opt/sunfall /var/lib/sunfall
[ -f /root/sunfall-admin-key ] || openssl rand -hex 24 > /root/sunfall-admin-key
ADMIN=$(cat /root/sunfall-admin-key)
IP=$(curl -4 -fsS https://api.ipify.org)
HOST="${IP//./-}.sslip.io"
cat > /etc/systemd/system/sunfall.service <<UNIT
[Unit]
Description=Sunfall city
After=network-online.target
[Service]
User=sunfall
WorkingDirectory=/opt/sunfall/repo/sunfall
Environment=PORT=8787 DATA_DIR=/var/lib/sunfall ADMIN_KEY=$ADMIN PUBLIC_URL=https://$HOST
ExecStart=/usr/bin/node src/server.js
Restart=always
RestartSec=3
[Install]
WantedBy=multi-user.target
UNIT
cat > /etc/caddy/Caddyfile <<CADDY
$HOST {
  encode gzip
  reverse_proxy 127.0.0.1:8787
}
http://$IP {
  reverse_proxy 127.0.0.1:8787
}
CADDY
cat > /usr/local/bin/sunfall-update <<'UPD'
#!/bin/bash
set -e
cd /opt/sunfall/repo && sudo -u sunfall git pull --ff-only && systemctl restart sunfall && echo "updated"
UPD
chmod +x /usr/local/bin/sunfall-update
command -v ufw >/dev/null && ufw allow 22 && ufw allow 80 && ufw allow 443 || true
systemctl daemon-reload
systemctl enable --now sunfall
systemctl restart caddy
echo "Sunfall is up: https://$HOST  (admin key in /root/sunfall-admin-key)" | tee /root/sunfall-ready.txt
