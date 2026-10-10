#!/usr/bin/env bash
# Installs a release and switches the live server to it, safely.
#
#   deploy.sh release/v0.20     install and switch to that branch (or tag, or commit)
#   deploy.sh --rollback        switch back to the release that ran before
#   deploy.sh --list            show installed releases
#
# Run as the app user (ordering). Layout under $APP_HOME (default: ~):
#   repo/                git clone, only used to fetch releases
#   releases/<name>/     one folder per installed release (code + node_modules)
#   current -> releases/<name>   what pm2 runs
#   shared/.env, shared/data/, shared/backups/, shared/logs/
#
# Steps: fetch -> unpack into a new folder -> npm ci -> run the test suite ->
# back up the database -> switch the `current` symlink -> reload pm2 -> wait
# for /healthz to report the new version. If the new release doesn't come up
# healthy within 40 s, it switches back to the previous one by itself.
set -euo pipefail

APP_HOME="${APP_HOME:-$HOME}"
PM2="${PM2:-pm2}"
NPM_CI="${NPM_CI:-npm ci --omit=dev --no-audit --no-fund}"
RUN_TESTS="${RUN_TESTS:-1}"
KEEP="${KEEP:-5}"

REPO="$APP_HOME/repo"
RELEASES="$APP_HOME/releases"
CURRENT="$APP_HOME/current"
SHARED="$APP_HOME/shared"
LOG="$SHARED/deploys.log"

say() { echo "[deploy] $*"; }
die() { echo "[deploy] ERROR: $*" >&2; exit 1; }
logline() { echo "$(date '+%F %T') $*" >> "$LOG"; }

env_value() { grep -E "^$1=" "$SHARED/.env" 2>/dev/null | tail -1 | cut -d= -f2- | tr -d '"'"'" || true; }
PORT="$(env_value PORT)"; PORT="${PORT:-3000}"

health_version() { curl -fsS --max-time 3 "http://127.0.0.1:$PORT/healthz" 2>/dev/null | sed -n 's/.*"version":"\([^"]*\)".*/\1/p'; }

# Point `current` at a release folder (atomic rename) and reload the app.
activate() {
  ln -sfn "$1" "$CURRENT.tmp" && mv -Tf "$CURRENT.tmp" "$CURRENT"
  $PM2 startOrReload "$1/deploy/ecosystem.config.js" --update-env >/dev/null
}

# Wait until /healthz answers with this release's version.
wait_healthy() {
  local want; want="$(cat "$1/VERSION")"
  for _ in $(seq 1 40); do
    [ "$(health_version)" = "$want" ] && return 0
    sleep 1
  done
  return 1
}

backup_db() {
  local db; db="$(env_value DB_PATH)"; db="${db:-$SHARED/data/ordering.db}"
  [ -f "$db" ] || return 0
  mkdir -p "$SHARED/backups"
  local file stamp
  stamp="$(date +%F-%H%M%S)"
  file="$SHARED/backups/before-$1-$stamp.db"
  command -v sqlite3 >/dev/null || die "sqlite3 is not installed (apt install sqlite3); not switching without a backup"
  sqlite3 "$db" ".backup '$file'" || die "database backup failed; nothing changed"
  gzip -f "$file" || die "could not compress $file; nothing changed"
  say "database backed up to $file.gz"
}

previous_release() {
  # The release that was live before the current one, from the deploy log.
  local now; now="$(basename "$(readlink -f "$CURRENT")")"
  grep -E ' (live|rolled-back-to) ' "$LOG" 2>/dev/null | awk '{print $4}' | grep -vx "$now" | tail -1
}

case "${1:-}" in
  --list)
    now="$(basename "$(readlink -f "$CURRENT" 2>/dev/null)" 2>/dev/null || true)"
    for path in "$RELEASES"/*/; do
      [ -f "$path/VERSION" ] || continue
      d="$(basename "$path")"
      printf '%s %s  %s\n' "$([ "$d" = "$now" ] && echo '*' || echo ' ')" "$d" "$(cat "$path/VERSION")"
    done
    exit 0 ;;
  --rollback)
    prev="${2:-$(previous_release)}"
    [ -n "$prev" ] && [ -d "$RELEASES/$prev" ] || die "no earlier release to go back to (see: deploy.sh --list)"
    say "rolling back to $prev"
    activate "$RELEASES/$prev"
    wait_healthy "$RELEASES/$prev" || die "$prev did not come up healthy either; check: pm2 logs ordering"
    logline "rolled-back-to $prev"
    say "live: $(cat "$RELEASES/$prev/VERSION")"
    exit 0 ;;
  ''|-h|--help)
    sed -n '2,9p' "$0"; exit 1 ;;
esac

REF="$1"
[ -d "$REPO/.git" ] || die "$REPO is not a git clone (run setup.sh first)"
mkdir -p "$RELEASES" "$SHARED/logs"

# ---- Fetch and unpack ------------------------------------------------------
say "fetching $REF"
git -C "$REPO" fetch --quiet --prune origin '+refs/heads/*:refs/remotes/origin/*' '+refs/tags/*:refs/tags/*'
SHA="$(git -C "$REPO" rev-parse --verify --quiet "origin/$REF^{commit}" || git -C "$REPO" rev-parse --verify --quiet "$REF^{commit}")" \
  || die "no branch, tag or commit called $REF"
if echo "$REF" | grep -qE '^[0-9a-f]{7,40}$'; then NAME="commit-$(echo "$SHA" | cut -c1-7)"
else NAME="$(echo "$REF" | tr '/:' '--' | tr -cd 'A-Za-z0-9._-')-$(echo "$SHA" | cut -c1-7)"; fi
DIR="$RELEASES/$NAME"

if [ "$(readlink -f "$CURRENT" 2>/dev/null)" = "$DIR" ]; then say "$NAME is already live"; exit 0; fi

if [ ! -f "$DIR/VERSION" ]; then
  rm -rf "$DIR.partial"; mkdir -p "$DIR.partial"
  git -C "$REPO" archive "$SHA" | tar -x -C "$DIR.partial"
  echo "$REF $(echo "$SHA" | cut -c1-7)" > "$DIR.partial/VERSION"
  say "installing packages"
  (cd "$DIR.partial" && $NPM_CI >/dev/null)
  if [ "$RUN_TESTS" = 1 ]; then
    say "running tests"
    # Before .env is linked in: tests must never see live keys (WhatsApp,
    # Supabase) or the live database.
    # shellcheck disable=SC2209
    (cd "$DIR.partial" && NODE_ENV=test npm test >"$SHARED/logs/test-$NAME.log" 2>&1) \
      || { rm -rf "$DIR.partial"; die "tests failed, nothing changed (see $SHARED/logs/test-$NAME.log)"; }
  fi
  ln -sfn "$SHARED/.env" "$DIR.partial/.env"
  mv "$DIR.partial" "$DIR"
fi

# ---- Switch ------------------------------------------------------------------
PREV="$(readlink -f "$CURRENT" 2>/dev/null || true)"
backup_db "$NAME"
say "switching to $NAME"
activate "$DIR"

if wait_healthy "$DIR"; then
  logline "live $NAME"
  say "live: $(cat "$DIR/VERSION")"
else
  if [ -n "$PREV" ] && [ -d "$PREV" ]; then
    say "new release is not healthy; switching back to $(basename "$PREV")"
    activate "$PREV"
    wait_healthy "$PREV" || die "previous release did not come back either; check: pm2 logs ordering"
    logline "failed $NAME"
    logline "rolled-back-to $(basename "$PREV")"
    die "$NAME failed its health check; still running $(cat "$PREV/VERSION"). See: pm2 logs ordering"
  fi
  logline "failed $NAME"
  die "$NAME did not start; see: pm2 logs ordering"
fi

# ---- Tidy up: keep the newest $KEEP releases (never the live one) ---------
live="$(readlink -f "$CURRENT")"
ls -1dt "$RELEASES"/*/ 2>/dev/null | sed 's#/$##' | tail -n +"$((KEEP + 1))" | while read -r old; do
  [ "$old" = "$live" ] || rm -rf "$old"
done
