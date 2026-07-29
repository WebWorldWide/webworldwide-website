#!/bin/bash

# Repo hygiene: cron installs this as root, but everything below only
# needs adam (repo owner; in the docker group). Re-exec so pulled/
# committed files never end up root-owned again.
if [ "$(id -u)" = 0 ] && command -v runuser >/dev/null 2>&1; then
  exec runuser -u adam -- "$0" "$@"
fi

# ==============================================================================
# Web World Wide — Scheduled Publish Promoter
#
# Cron-friendly wrapper around `node admin/src/services/scheduler.js`.
# Walks site/content/posts/*.md for entries with `draft: true` and a
# `publish_at` timestamp in the past, flips them to `draft: false`,
# commits + pushes. Hugo's next build then includes them.
#
# Install via crontab (run every 5 minutes):
#   */5 * * * * /opt/web-world-wide/scripts/promote-scheduled.sh \
#     >> /var/log/web-world-wide-scheduler.log 2>&1
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

# Git auth for the scheduler's commit+push: token lives in docker/.env
# (0600); the repo's credential helper reads $GH_TOKEN.
GH_TOKEN="$(grep -m1 '^GH_TOKEN=' "$REPO_DIR/docker/.env" 2>/dev/null | cut -d= -f2- || true)"
export GH_TOKEN

cd "$REPO_DIR"

# Serialize with CMS publishing and every host operation that can move main.
# shellcheck source=scripts/_operation-lock.sh
. "$SCRIPT_DIR/_operation-lock.sh"
if ! acquire_wwwide_operation_lock "$REPO_DIR" skip; then
  exit 0
fi

echo "[$(date -Is)] scheduler: starting"
# Run the promoter INSIDE the cms container so it uses the REAL auth DB (the
# cms_data volume at /app/data/auth.db) for its activity log and shares the
# container's env (SITE_DIR, GH_TOKEN, git identity) + the proven publish path.
# A host-side `node` defaulted AUTH_DB_PATH to the non-existent
# admin/data/auth.db, materialising a stray throwaway DB the admin UI never reads.
if [ "$(docker inspect -f '{{.State.Running}}' cms 2>/dev/null)" != "true" ]; then
  echo "[$(date -Is)] scheduler: cms container not running — skipping"
  exit 0
fi
docker exec -e WWWIDE_OPERATION_LOCK_HELD=1 cms node /app/src/services/scheduler.js "$@"
echo "[$(date -Is)] scheduler: done"
