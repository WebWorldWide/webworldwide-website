#!/bin/bash
# ==============================================================================
# Terminal Eighty — Webmention dump + commit
#
# Cron-friendly wrapper around `node admin/src/services/dump-webmentions.js`.
# Reads approved rows from the CMS SQLite DB and writes one JSON file per
# post slug under `site/data/webmentions/`. If any files changed, commits
# and pushes so the next Hugo build picks them up.
#
# Install via crontab (Pi, every 5 minutes):
#   */5 * * * * /opt/terminal-eighty/scripts/dump-webmentions.sh \
#     >> /var/log/terminal-eighty-webmentions.log 2>&1
#
# Honors:
#   TE_REPO_DIR  path to the repo root (default: derive from script location)
#   SITE_DIR     hugo site dir       (default: $TE_REPO_DIR/site)
#   AUTH_DB_PATH SQLite path         (default: $TE_REPO_DIR/admin/data/auth.db)
#   --dry-run    list candidates but do not write, commit, or push
# ==============================================================================

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="${TE_REPO_DIR:-$(cd "$SCRIPT_DIR/.." && pwd)}"
SITE_DIR="${SITE_DIR:-$REPO_DIR/site}"
AUTH_DB_PATH="${AUTH_DB_PATH:-$REPO_DIR/admin/data/auth.db}"

export SITE_DIR
export AUTH_DB_PATH

cd "$REPO_DIR"

DRY_RUN_FLAG=""
if [[ "${1:-}" == "--dry-run" ]]; then
  DRY_RUN_FLAG="--dry-run"
fi

echo "[$(date -Is)] dump-webmentions: starting"
node "$REPO_DIR/admin/src/services/dump-webmentions.js" $DRY_RUN_FLAG

if [[ -n "$DRY_RUN_FLAG" ]]; then
  echo "[$(date -Is)] dump-webmentions: dry-run complete"
  exit 0
fi

# Only commit if there are actual changes to the webmentions data dir.
if git -C "$REPO_DIR" diff --quiet --exit-code -- "$SITE_DIR/data/webmentions/"; then
  echo "[$(date -Is)] dump-webmentions: no changes; skipping commit"
  exit 0
fi

git -C "$REPO_DIR" add "$SITE_DIR/data/webmentions/"
git -C "$REPO_DIR" -c user.name='Terminal Eighty Bot' \
                    -c user.email='bot@terminaleighty.com' \
                    commit -m "Sync approved webmentions $(date -Iseconds)"

# Push is best-effort — a failure (offline, auth issue) shouldn't fail
# the cron. The next run will catch up.
if git -C "$REPO_DIR" push 2>&1; then
  echo "[$(date -Is)] dump-webmentions: pushed"
else
  echo "[$(date -Is)] dump-webmentions: push failed; will retry on next run"
fi
