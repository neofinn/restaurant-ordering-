#!/usr/bin/env bash
# Nightly database backup (cron, as the app user). Keeps 30 days.
#   15 3 * * * $HOME/current/deploy/backup.sh
set -euo pipefail

APP_HOME="${APP_HOME:-$HOME}"
DB="$(grep -E '^DB_PATH=' "$APP_HOME/shared/.env" | cut -d= -f2- | tr -d '"'"'")"
DB="${DB:-$APP_HOME/shared/data/ordering.db}"
OUT="$APP_HOME/shared/backups"
KEEP_DAYS="${KEEP_DAYS:-30}"

mkdir -p "$OUT"
file="$OUT/ordering-$(date +%F-%H%M).db"
# .backup takes a consistent copy while the app keeps running.
sqlite3 "$DB" ".backup '$file'"
sqlite3 "$file" 'PRAGMA integrity_check;' | grep -qx ok || { echo "backup $file failed its integrity check" >&2; exit 1; }
gzip -f "$file"
find "$OUT" -name 'ordering-*.db.gz' -mtime +"$KEEP_DAYS" -delete
echo "backup: $file.gz ($(du -h "$file.gz" | cut -f1))"
