#!/usr/bin/env bash
#
# maintenance-yearly.sh — deep integrity + freshness audit. Reports only;
# it never mutates data, so it's safe to run any time.
#
#   1. SQLite integrity_check on the CMS auth.db (catch silent corruption).
#   2. Confirm the off-site backup repo committed recently (≤ 48h).
#   3. Dependency vulnerability snapshot (npm audit, report-only).
#
# Anything alarming is sent to HEALTHCHECK_WEBHOOK_URL if configured.
set -uo pipefail

APP_DIR="${WWWIDE_APP_DIR:-/opt/web-world-wide}"
BACKUP_REPO_DIR="${WWWIDE_BACKUP_DIR:-/opt/www-blog-backups}"
ENV_FILE="$APP_DIR/docker/.env"
log() { echo "$(date '+%Y-%m-%dT%H:%M:%S%z') [maint-yearly] $*"; }
WEBHOOK="$(grep -m1 '^HEALTHCHECK_WEBHOOK_URL=' "$ENV_FILE" 2>/dev/null | cut -d= -f2- || true)"
alert() {
  log "ALERT: $*"
  [ -n "${WEBHOOK:-}" ] || return 0
  curl -fsS -m 10 -X POST -H 'Content-Type: application/json' \
    -d "{\"text\":\"[WWWide yearly] $*\"}" "$WEBHOOK" >/dev/null 2>&1 || true
}
log "starting"

# 1. DB integrity.
if docker inspect -f '{{.State.Status}}' cms 2>/dev/null | grep -q running; then
  result=$(docker exec cms node -e '
    try { const db=require("better-sqlite3")("data/auth.db");
      const r=db.pragma("integrity_check", {simple:true}); db.close();
      console.log(r);
    } catch(e){ console.log("ERROR:"+e.message); }' 2>/dev/null || echo "ERROR:exec failed")
  if [ "$result" = "ok" ]; then
    log "auth.db integrity_check: ok"
  else
    alert "auth.db integrity_check returned: $result"
  fi
fi

# 2. Backup freshness.
if [ -d "$BACKUP_REPO_DIR/.git" ]; then
  last=$(git -C "$BACKUP_REPO_DIR" log -1 --format=%ct 2>/dev/null || echo 0)
  age=$(( ( $(date +%s) - last ) / 3600 ))
  if [ "$age" -le 48 ]; then
    log "backup repo last commit ${age}h ago — fresh"
  else
    alert "backup repo last commit ${age}h ago — backups may be STALE"
  fi
else
  alert "backup repo not found at $BACKUP_REPO_DIR"
fi

# 3. Dependency audit (report-only; high/critical count).
if [ -d "$APP_DIR/admin" ]; then
  hi=$(cd "$APP_DIR/admin" && npm audit --omit=dev --json 2>/dev/null \
    | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{const j=JSON.parse(s);const v=j.metadata?.vulnerabilities||{};console.log((v.high||0)+(v.critical||0));}catch{console.log("?")}})' || echo "?")
  log "admin high+critical vulnerabilities: $hi"
  [ "$hi" != "0" ] && [ "$hi" != "?" ] && alert "admin has $hi high/critical npm vulnerabilities"
fi

log "complete"
