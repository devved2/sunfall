#!/bin/bash
# Serve Sunfall on your own domain as well as the sslip.io address. Run as root on the server:
#   curl -fsSL https://raw.githubusercontent.com/devved2/sunfall/main/sunfall/deploy/add-domain.sh | bash -s sunfall.world
# Point the domain's A record (and www) at this server first; Caddy then gets the HTTPS certificate by itself.
set -e
DOMAIN="${1:?usage: add-domain.sh example.com}"
CF=/etc/caddy/Caddyfile
cp "$CF" "$CF.bak.$(date +%s)"
if ! grep -q "^$DOMAIN {" "$CF"; then
  cat >> "$CF" <<CADDY

$DOMAIN {
  encode gzip
  reverse_proxy 127.0.0.1:8787
}
www.$DOMAIN {
  redir https://$DOMAIN{uri} permanent
}
CADDY
fi
caddy validate --config "$CF" --adapter caddyfile
systemctl reload caddy
# Share cards and links in the API use the new address from now on; the sslip.io address keeps working.
sed -i "s#PUBLIC_URL=[^ ]*#PUBLIC_URL=https://$DOMAIN#" /etc/systemd/system/sunfall.service
systemctl daemon-reload
systemctl restart sunfall
echo "Sunfall is now on https://$DOMAIN (certificate can take a minute on first visit)"
