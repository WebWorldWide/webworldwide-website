#!/usr/bin/env bash
#
# maintenance-monthly.sh — deeper upkeep that's too heavy for daily.
#
#   1. VACUUM the CMS auth.db (reclaim free pages + defragment). VACUUM
#      needs exclusive access, so we briefly stop cms — same safe pattern
#      the nightly backup uses — and ALWAYS restart it via the trap.
#   2. apt autoremove (kernels/orphans accumulate over a month).
#
# Safe to run by hand. Idempotent. No args.
set -uo pipefail

APP_DIR="${WWWIDE_APP_DIR:-/opt/web-world-wide}"
DOCKER_DIR="$APP_DIR/docker"
SCRIPT_DIR="$APP_DIR/scripts"
log() { echo "$(date '+%Y-%m-%dT%H:%M:%S%z') [maint-monthly] $*"; }
log "starting"

cd "$DOCKER_DIR" || { log "no docker dir at $DOCKER_DIR"; exit 1; }

# VACUUM stops the CMS, so wait for other stateful operations to finish.
# shellcheck source=scripts/_operation-lock.sh
. "$SCRIPT_DIR/_operation-lock.sh"
acquire_wwwide_operation_lock "$APP_DIR" wait 300

# Whatever happens, never leave cms stopped.
CMS_STOPPED=0
restart_cms() {
  if [ "$CMS_STOPPED" = 1 ]; then
    docker compose start cms >/dev/null 2>&1 || true
  fi
}
trap restart_cms EXIT

if docker inspect -f '{{.State.Status}}' cms 2>/dev/null | grep -q running; then
  log "VACUUMing CMS auth.db (brief cms stop)…"
  docker compose stop cms >/dev/null 2>&1 && CMS_STOPPED=1
  # Run VACUUM with a one-shot container sharing the cms image + volume so
  # we don't depend on sqlite3 being on the host.
  docker compose run --rm --no-deps -T cms node -e '
    try {
      const db = require("better-sqlite3")("data/auth.db");
      db.pragma("wal_checkpoint(TRUNCATE)");
      db.exec("VACUUM");
      db.pragma("optimize");
      db.close();
      console.log("[maint-monthly] VACUUM ok");
    } catch (e) { console.warn("[maint-monthly] VACUUM failed:", e.message); process.exit(0); }
  ' || log "VACUUM step failed (continuing)"
  docker compose start cms >/dev/null 2>&1 && CMS_STOPPED=0
  log "cms restarted"
else
  log "cms not running — skipping VACUUM"
fi

log "apt autoremove…"
sudo apt-get autoremove -y >/dev/null 2>&1 || log "apt autoremove failed (continuing)"

log "complete"
