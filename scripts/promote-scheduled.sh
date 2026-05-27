#!/bin/bash
# ==============================================================================
# Terminal Eighty — Scheduled Publish Promoter
#
# Cron-friendly wrapper around `node admin/src/services/scheduler.js`.
# Walks site/content/posts/*.md for entries with `draft: true` and a
# `publish_at` timestamp in the past, flips them to `draft: false`,
# commits + pushes. Hugo's next build then includes them.
#
# Install via crontab (run every 5 minutes):
#   */5 * * * * /opt/terminal-eighty/scripts/promote-scheduled.sh \
#     >> /var/log/terminal-eighty-scheduler.log 2>&1
#
# Honors:
#   TE_REPO_DIR  path to the repo root (default: derive from script location)
#   SITE_DIR     hugo site dir (default: $TE_REPO_DIR/site)
#   --dry-run    list candidates but do not write or commit
# ==============================================================================

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="${TE_REPO_DIR:-$(cd "$SCRIPT_DIR/.." && pwd)}"
SITE_DIR="${SITE_DIR:-$REPO_DIR/site}"

export SITE_DIR

cd "$REPO_DIR"

echo "[$(date -Is)] scheduler: starting"
node "$REPO_DIR/admin/src/services/scheduler.js" "$@"
echo "[$(date -Is)] scheduler: done"
