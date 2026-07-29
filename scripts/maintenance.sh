#!/bin/bash

# ==============================================================================
# Web World Wide Routine Maintenance Script
# Runs via cron to clean up system resources and prevent disk exhaustion
# ==============================================================================

set -uo pipefail

APP_DIR="${WWWIDE_APP_DIR:-/opt/web-world-wide}"
SCRIPT_DIR="$APP_DIR/scripts"

# Pruning and the child publish jobs must not overlap backup/deploy/restore.
# shellcheck source=scripts/_operation-lock.sh
. "$SCRIPT_DIR/_operation-lock.sh"
if ! acquire_wwwide_operation_lock "$APP_DIR" skip; then
  exit 0
fi

echo "Starting system maintenance at $(date)"

# 1. Prune dangling Docker images and build cache.
# Deliberately NOT `-a` (would delete the images a stopped service needs
# to come back) and NOT `--volumes` (would delete data volumes of any
# container that happens to be stopped — this combination deleted the
# remark42 container + nearly its data in June 2026).
echo "[1/3] Pruning Docker..."
docker system prune -f

# 2. Clean apt package manager cache
echo "[2/3] Cleaning apt cache..."
sudo apt-get autoremove -y
sudo apt-get clean

# 3. Trim system journal logs to last 7 days
echo "[3/3] Vacuuming journalctl logs..."
sudo journalctl --vacuum-time=7d

# 4. Promote any scheduled posts whose `publish_at` is past.
# Cron usually invokes scripts/promote-scheduled.sh directly every 5 min
# (see CONTRIBUTING.md), but we also fire here so a daily maintenance
# pass catches any drift if the 5-min cron was off.
SCHED_SCRIPT="$SCRIPT_DIR/promote-scheduled.sh"
if [ -x "$SCHED_SCRIPT" ]; then
  echo "[4/5] Running scheduled-post promoter..."
  "$SCHED_SCRIPT" || echo "scheduler failed (continuing)"
fi

# 5. Dump approved webmentions to site/data/webmentions/.
# Same safety-net rationale as (4) — the 5-min cron is the primary
# trigger; this catches drift if the cron was off.
DUMP_SCRIPT="$SCRIPT_DIR/dump-webmentions.sh"
if [ -x "$DUMP_SCRIPT" ]; then
  echo "[5/6] Running webmention dumper..."
  "$DUMP_SCRIPT" || echo "webmention dump failed (continuing)"
fi

# 6. Email comment-activity digest (Phase 8.5).
# Self-noops if SMTP_HOST is unset, so it's safe to keep enabled.
DIGEST_SCRIPT="$SCRIPT_DIR/email-digest.mjs"
if [ -f "$DIGEST_SCRIPT" ]; then
  echo "[6/6] Sending email digest (if SMTP configured)..."
  node "$DIGEST_SCRIPT" || echo "email digest failed (continuing)"
fi

echo "Maintenance completed successfully at $(date)"
