#!/usr/bin/env bash
# Nightly PostgreSQL backup with verification and rotation.
# Usage: deploy/backup.sh            (reads DATABASE_URL from the repo's .env)
# Env:   BACKUP_DIR (default ~/backups), BACKUP_KEEP_DAYS (default 14)
set -euo pipefail
umask 077

APP_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BACKUP_DIR="${BACKUP_DIR:-$HOME/backups}"
KEEP_DAYS="${BACKUP_KEEP_DAYS:-14}"
log() { logger -t endowment-backup "$*"; echo "$(date -Is) $*"; }

DATABASE_URL="$(grep -E '^DATABASE_URL=' "$APP_DIR/.env" | head -1 | cut -d= -f2-)"
if [[ -z "$DATABASE_URL" ]]; then
  log "ERROR: DATABASE_URL not found in $APP_DIR/.env"
  exit 1
fi

mkdir -p "$BACKUP_DIR"
target="$BACKUP_DIR/endowment_aquarium-$(date +%Y%m%d-%H%M%S).dump"
tmp="$target.partial"

if ! pg_dump "$DATABASE_URL" --format=custom --file="$tmp"; then
  rm -f "$tmp"
  log "ERROR: pg_dump failed"
  exit 1
fi
# A dump that pg_restore cannot list is useless; fail loudly instead of rotating good ones away.
if ! pg_restore --list "$tmp" >/dev/null; then
  rm -f "$tmp"
  log "ERROR: backup verification failed"
  exit 1
fi
mv "$tmp" "$target"

deleted=$(find "$BACKUP_DIR" -maxdepth 1 -name 'endowment_aquarium-*.dump' -mtime +"$KEEP_DAYS" -print -delete | wc -l)
log "OK: $(basename "$target") ($(du -h "$target" | cut -f1)), removed $deleted older than ${KEEP_DAYS}d"
