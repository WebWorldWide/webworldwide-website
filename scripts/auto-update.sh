#!/bin/bash

# Repo hygiene: cron installs this as root, but everything below only
# needs adam (repo owner; in the docker group). Re-exec so pulled/
# committed files never end up root-owned again.
if [ "$(id -u)" = 0 ] && command -v runuser >/dev/null 2>&1; then
  exec runuser -u adam -- "$0" "$@"
fi


# ==============================================================================
# Web World Wide Auto-Update Script
# Runs via cron to pull latest GitHub changes and restart Docker containers
# ==============================================================================

# Variables
REPO_DIR="/opt/web-world-wide"
DOCKER_DIR="$REPO_DIR/docker"

# Git auth: token lives in docker/.env (0600). The repo's credential
# helper reads $GH_TOKEN. The repo is public today, so fetch/pull work
# without it — exported anyway so this keeps working if it goes private.
GH_TOKEN="$(grep -m1 '^GH_TOKEN=' "$DOCKER_DIR/.env" 2>/dev/null | cut -d= -f2- || true)"
export GH_TOKEN

# Navigate to repo
cd "$REPO_DIR" || { echo "$(date): Failed to find repo at $REPO_DIR"; exit 1; }

# Fetch latest from remote
git fetch origin main

# Check if local matches remote
LOCAL=$(git rev-parse HEAD)
# shellcheck disable=SC1083 # `@{u}` is git's upstream-ref syntax, not brace expansion
REMOTE=$(git rev-parse '@{u}')

if [ "$LOCAL" != "$REMOTE" ]; then
    echo "$(date): Updates found. Pulling latest code..."

    # Pull changes
    git pull origin main

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
    docker compose --project-directory "$DOCKER_DIR" up -d --build --remove-orphans

    echo "$(date): Update and deployment complete."
else
    echo "$(date): System is up to date."
fi
