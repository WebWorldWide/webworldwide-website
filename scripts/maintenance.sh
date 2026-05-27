#!/bin/bash

# ==============================================================================
# Terminal Eighty Routine Maintenance Script
# Runs via cron to clean up system resources and prevent disk exhaustion
# ==============================================================================

echo "Starting system maintenance at $(date)"

# 1. Prune unused Docker images, containers, and networks
# -a removes all unused images (not just dangling)
# -f forces without confirmation
echo "[1/3] Pruning Docker..."
docker system prune -af --volumes

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
SCHED_SCRIPT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/promote-scheduled.sh"
if [ -x "$SCHED_SCRIPT" ]; then
  echo "[4/5] Running scheduled-post promoter..."
  "$SCHED_SCRIPT" || echo "scheduler failed (continuing)"
fi

# 5. Dump approved webmentions to site/data/webmentions/.
# Same safety-net rationale as (4) — the 5-min cron is the primary
# trigger; this catches drift if the cron was off.
DUMP_SCRIPT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/dump-webmentions.sh"
if [ -x "$DUMP_SCRIPT" ]; then
  echo "[5/6] Running webmention dumper..."
  "$DUMP_SCRIPT" || echo "webmention dump failed (continuing)"
fi

# 6. Email comment-activity digest (Phase 8.5).
# Self-noops if SMTP_HOST is unset, so it's safe to keep enabled.
DIGEST_SCRIPT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/email-digest.mjs"
if [ -f "$DIGEST_SCRIPT" ]; then
  echo "[6/6] Sending email digest (if SMTP configured)..."
  node "$DIGEST_SCRIPT" || echo "email digest failed (continuing)"
fi

echo "Maintenance completed successfully at $(date)"
