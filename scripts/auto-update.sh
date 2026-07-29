#!/bin/bash

# Repo hygiene: cron installs this as root, but everything below only
# needs adam (repo owner; in the docker group). While still root, fix
# any .git objects left root-owned by previous runs, then re-exec as
# adam so future pulled/committed files are never root-owned again.
if [ "$(id -u)" = 0 ]; then
  chown -R 1000:1000 /opt/web-world-wide/.git 2>/dev/null || true
  if command -v runuser >/dev/null 2>&1; then
    exec runuser -u adam -- "$0" "$@"
  fi
fi

set -euo pipefail

# ==============================================================================
# Web World Wide Auto-Update Script
# Runs via cron to pull latest GitHub changes and restart Docker containers
# ==============================================================================

# Variables
REPO_DIR="/opt/web-world-wide"
DOCKER_DIR="$REPO_DIR/docker"
SCRIPT_DIR="$REPO_DIR/scripts"

# Git auth: token lives in docker/.env (0600). The repo's credential
# helper reads $GH_TOKEN. The repo is public today, so fetch/pull work
# without it — exported anyway so this keeps working if it goes private.
GH_TOKEN="$(grep -m1 '^GH_TOKEN=' "$DOCKER_DIR/.env" 2>/dev/null | cut -d= -f2- || true)"
export GH_TOKEN

# Navigate to repo
cd "$REPO_DIR" || { echo "$(date): Failed to find repo at $REPO_DIR"; exit 1; }

# Do not pull/rebuild while a backup, restore, watchdog recovery, or content
# publish is using the same containers and Git index.
# shellcheck source=scripts/_operation-lock.sh
. "$SCRIPT_DIR/_operation-lock.sh"
if ! acquire_wwwide_operation_lock "$REPO_DIR" skip; then
    exit 0
fi

# Fetch latest from remote. Gate every step explicitly (a failed fetch/pull
# must never fall through to a rebuild of a partial/conflicted tree).
if ! git fetch origin main; then
    echo "$(date): fetch failed — skipping this run."
    exit 0
fi

LOCAL=$(git rev-parse HEAD)
# shellcheck disable=SC1083 # `@{u}` is git's upstream-ref syntax, not brace expansion
REMOTE=$(git rev-parse '@{u}')

if [ "$LOCAL" = "$REMOTE" ]; then
    echo "$(date): System is up to date."
    exit 0
fi

# Only rebuild when origin is genuinely AHEAD of us (a fast-forward is
# possible). If local main is merely AHEAD of / diverged from origin — a commit
# pushed from this host, or one stranded by a failed cron push — then HEAD is
# NOT an ancestor of origin. The old `LOCAL != REMOTE` test stayed true forever
# in that state and re-ran `up -d --build` every 5 minutes (a rebuild storm);
# bail instead, and never let a default merge-pull fabricate a local merge.
if ! git merge-base --is-ancestor HEAD "$REMOTE"; then
    echo "$(date): local is ahead of / diverged from origin (not a fast-forward) — skipping rebuild; a push is needed to realign."
    exit 0
fi

echo "$(date): Updates found on origin. Fast-forwarding..."
if ! git pull --ff-only origin main; then
    echo "$(date): ff-only pull failed — NOT rebuilding (tree may be partial). Will retry next run."
    exit 1
fi

# Keep the HOST admin deps in sync — promote-scheduled.sh and
# dump-webmentions.sh run admin code with the host's node, outside
# the container. Only reinstall when the lockfile actually changed.
if ! git diff --quiet "$LOCAL" HEAD -- admin/package-lock.json; then
    echo "$(date): admin lockfile changed — refreshing host node_modules..."
    npm ci --omit=dev --prefix "$REPO_DIR/admin" || \
        echo "$(date): WARNING: host npm ci failed — scheduler/webmention crons may break."
fi

# Rebuild containers gracefully (no "down" — only recreates changed containers)
# This keeps cloudflared and other unchanged services running during rebuild
echo "$(date): Rebuilding changed containers..."
if ! docker compose --project-directory "$DOCKER_DIR" up -d --build --remove-orphans; then
    echo "$(date): Docker rebuild failed — deployment is incomplete."
    exit 1
fi

echo "$(date): Update and deployment complete."
