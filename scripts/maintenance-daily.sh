#!/usr/bin/env bash
#
# maintenance-daily.sh — light, non-disruptive daily upkeep so the CMS
# stays fast and the disk stays clean. NO container stops (everything here
# is safe against the live DB), so it can run any time.
#
#   1. SQLite checkpoint + optimize on the CMS auth.db — folds the WAL back
#      into the main file (keeps it small AND keeps nightly backups
#      complete) and refreshes the query planner's stats.
#   2. Sweep stale upload-staging temp files.
#   3. Trim our own oversized cron logs.
#
# Safe to run by hand. Idempotent. No args.
set -uo pipefail

log() { echo "$(date '+%Y-%m-%dT%H:%M:%S%z') [maint-daily] $*"; }
log "starting"

# 1. SQLite online maintenance — a second connection; checkpoint(TRUNCATE)
#    + optimize are safe while the app is serving. Never fatal.
if docker inspect -f '{{.State.Status}}' cms 2>/dev/null | grep -q running; then
  docker exec cms node -e '
    try {
      const db = require("better-sqlite3")("data/auth.db");
      const w = db.pragma("wal_checkpoint(TRUNCATE)");
      db.pragma("optimize");
      db.close();
      console.log("[maint-daily] wal_checkpoint", JSON.stringify(w));
    } catch (e) { console.warn("[maint-daily] sqlite maintenance skipped:", e.message); }
  ' || log "cms sqlite maintenance failed (continuing)"
else
  log "cms not running — skipping sqlite maintenance"
fi

# 2. Upload staging: multer stages uploads in the OS tmpdir; a crashed
#    upload can orphan a file. Clear anything older than a day.
if docker inspect -f '{{.State.Status}}' cms 2>/dev/null | grep -q running; then
  docker exec cms sh -c 'find /tmp -maxdepth 1 -name "*.tmp*" -mtime +1 -delete 2>/dev/null' || true
fi

# 3. Trim our own logs if any single one exceeds 50MB (keep the tail).
for lf in /var/log/wwwide-*.log; do
  [ -f "$lf" ] || continue
  size=$(stat -c%s "$lf" 2>/dev/null || echo 0)
  if [ "$size" -gt $((50 * 1024 * 1024)) ]; then
    tail -c $((10 * 1024 * 1024)) "$lf" > "$lf.tmp" && mv "$lf.tmp" "$lf"
    log "trimmed oversized log $lf"
  fi
done

log "complete"
