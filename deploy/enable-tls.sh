#!/usr/bin/env bash
# Issue the Let's Encrypt certificate once DNS points at this server.
# Requires an A record: endowment.itzcaesar.space -> 43.157.202.206
set -euo pipefail
DOMAIN=endowment.itzcaesar.space

until getent hosts "$DOMAIN" >/dev/null 2>&1; do
  echo "Waiting for DNS record for $DOMAIN ..."
  sleep 10
done

sudo certbot --nginx -d "$DOMAIN" \
  --non-interactive --agree-tos --register-unsafely-without-email --redirect
sudo nginx -t
sudo systemctl reload nginx
echo "TLS enabled: https://$DOMAIN"
