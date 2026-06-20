#!/bin/bash

# Repo hygiene: cron installs this as root, but everything below only
# needs adam (repo owner; in the docker group). Re-exec so pulled/
# committed files never end up root-owned again.
if [ "$(id -u)" = 0 ] && command -v runuser >/dev/null 2>&1; then
  exec runuser -u adam -- "$0" "$@"
fi

# ==============================================================================
# Web World Wide — Webmention dump + commit
#
# Cron-friendly wrapper around `node admin/src/services/dump-webmentions.js`.
# Reads approved rows from the CMS SQLite DB and writes one JSON file per
# post slug under `site/data/webmentions/`. If any files changed, commits
# and pushes so the next Hugo build picks them up.
#
# Install via crontab (Pi, every 5 minutes):
#   */5 * * * * /opt/web-world-wide/scripts/dump-webmentions.sh \
#     >> /var/log/web-world-wide-webmentions.log 2>&1
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

# Stage any webmentions output, INCLUDING brand-new files. The dir starts
# untracked (it doesn't exist until the first approved mention) and `git diff`
# is blind to untracked files — so the old gate reported "no changes" and the
# bootstrap commit was NEVER made (approved mentions never reached the site).
# Test the STAGED set instead. Guard the `add` on dir existence: `git add` on a
# missing pathspec errors under `set -e` (the dir is absent when there are 0
# mentions).
if [ -d "$SITE_DIR/data/webmentions" ]; then
  git -C "$REPO_DIR" add -A -- "$SITE_DIR/data/webmentions/"
fi
if git -C "$REPO_DIR" diff --cached --quiet -- "$SITE_DIR/data/webmentions/"; then
  echo "[$(date -Is)] dump-webmentions: no new changes"
else
  git -C "$REPO_DIR" -c user.name='Web World Wide Bot' \
                      -c user.email='bot@webworldwide.online' \
                      commit -m "Sync approved webmentions $(date -Iseconds)"
fi

# Push ANY unpushed commit — a fresh one OR one stranded by a prior failed
# (non-fast-forward) push. The old code `exit 0`d whenever there was no new
# diff, so a stranded commit was never retried.
# shellcheck disable=SC1083 # @{u} is git upstream-ref syntax
if [ -z "$(git -C "$REPO_DIR" rev-list '@{u}..HEAD' 2>/dev/null)" ]; then
  echo "[$(date -Is)] dump-webmentions: nothing to push"
  exit 0
fi
# Only rebase+push when the worktree is otherwise clean. Rebasing a worktree
# dirtied by an in-flight cms write (or other edits) could autostash then revert
# unrelated tracked changes on a pop conflict. If dirty, defer — our commit is
# safe in HEAD and the next run retries.
if [ -n "$(git -C "$REPO_DIR" status --porcelain --untracked-files=no)" ]; then
  echo "[$(date -Is)] dump-webmentions: worktree has uncommitted changes — deferring push to next run"
  exit 0
fi
# Rebase onto fresh origin so the push is a fast-forward (the cms publish + other
# crons advance origin/main between runs).
git -C "$REPO_DIR" fetch origin main -q || true
if ! git -C "$REPO_DIR" rebase origin/main; then
  git -C "$REPO_DIR" rebase --abort 2>/dev/null || true
  echo "[$(date -Is)] dump-webmentions: rebase conflict — leaving commit local for next run"
  exit 0
fi
if git -C "$REPO_DIR" push 2>&1; then
  echo "[$(date -Is)] dump-webmentions: pushed"
else
  echo "[$(date -Is)] dump-webmentions: push failed; will retry on next run"
fi
