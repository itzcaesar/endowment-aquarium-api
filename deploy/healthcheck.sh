#!/usr/bin/env bash
# Watchdog (cron, every 5 min). systemd's Restart=always already handles crashes; this catches
# a process that is alive but not answering. Two consecutive local failures => restart.
# The public HTTPS check only logs, since nginx/TLS/DNS problems are not fixed by a restart.
set -uo pipefail

LOCAL_URL="${LOCAL_HEALTH_URL:-http://127.0.0.1:3100/api/v1/health}"
PUBLIC_URL="${PUBLIC_HEALTH_URL:-https://endowment.itzcaesar.space/api/v1/health}"
SERVICE="${HEALTH_SERVICE:-endowment-aquarium-api}"
STATE="${HEALTH_STATE_FILE:-$HOME/.cache/endowment-healthcheck.failures}"
mkdir -p "$(dirname "$STATE")"
log() { logger -t endowment-health "$*"; }

if curl -fsS --max-time 10 "$LOCAL_URL" >/dev/null 2>&1; then
  if [[ -s "$STATE" ]]; then log "OK: $SERVICE recovered"; fi
  : > "$STATE"
else
  failures=$(( $(cat "$STATE" 2>/dev/null || echo 0) + 1 ))
  echo "$failures" > "$STATE"
  log "WARN: $LOCAL_URL failed ($failures in a row)"
  if (( failures >= 2 )); then
    log "ERROR: restarting $SERVICE after $failures failed checks"
    sudo -n systemctl restart "$SERVICE" && : > "$STATE"
  fi
fi

if ! curl -fsS --max-time 15 "$PUBLIC_URL" >/dev/null 2>&1; then
  log "ERROR: public endpoint $PUBLIC_URL is failing (check nginx, TLS, DNS)"
fi
