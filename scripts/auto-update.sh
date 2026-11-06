#!/bin/bash

# Repo hygiene: cron may install this as root, but everything below only
# needs adam (repo owner; in the docker group). While still root, fix
# any .git objects left root-owned by previous runs, then re-exec as
# adam so future pulled/committed files are never root-owned again.
REPO_DIR="${WWWIDE_APP_DIR:-/opt/web-world-wide}"
if [ "$(id -u)" = 0 ]; then
  chown -R 1000:1000 "$REPO_DIR/.git" 2>/dev/null || true
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

# shellcheck source=scripts/_notify.sh
. "$SCRIPT_DIR/_notify.sh"

# Production must track main. A checkout left on another branch silently
# froze deploys for a month in 2026-10 (CMS publishes were also stranded).
BRANCH="$(wwwide_git symbolic-ref --short -q HEAD || echo '(detached)')"
if [ "$BRANCH" != "main" ]; then
    wwwide_notify auto-update-branch 21600 \
        "Production checkout is on '$BRANCH', not main — deploys are paused. Fix: cd $REPO_DIR && git switch main"
    exit 1
fi
wwwide_notify_clear auto-update-branch

# Fetch latest from remote. Gate every step explicitly (a failed fetch/pull
# must never fall through to a rebuild of a partial/conflicted tree).
if ! wwwide_git fetch origin +refs/heads/main:refs/remotes/origin/main; then
    wwwide_notify auto-update-fetch 21600 "git fetch failed on the production checkout."
    exit 0
fi
wwwide_notify_clear auto-update-fetch

LOCAL=$(wwwide_git rev-parse HEAD)
REMOTE=$(wwwide_git rev-parse refs/remotes/origin/main)

if [ "$LOCAL" = "$REMOTE" ]; then
    echo "$(date): System is up to date."
    wwwide_notify_clear auto-update-diverged
    exit 0
fi

# Only fast-forward. If local main has commits origin lacks, a human must
# decide (push or drop them) — never fabricate a merge here.
if ! wwwide_git merge-base --is-ancestor HEAD "$REMOTE"; then
    wwwide_notify auto-update-diverged 21600 \
        "Production main has diverged from origin/main ($(wwwide_git rev-list --count "$REMOTE..HEAD") local-only commit(s)). Deploys are paused until it is realigned."
    exit 1
fi

echo "$(date): Updates found on origin. Fast-forwarding..."
# The CMS publishes straight to origin without moving this checkout, so the
# site/ files it published are already on disk as "local modifications". Stage
# site/ first: a fast-forward then accepts files whose staged content already
# equals the incoming commit, and still refuses (safely) if an unpublished edit
# collides with an incoming change to the same file.
wwwide_git add -A -- site
if ! wwwide_git merge --ff-only -q "$REMOTE"; then
    wwwide_git reset -q -- site || true
    wwwide_notify auto-update-ff 3600 \
        "Fast-forward to origin/main failed (local edits collide with incoming changes). Run: cd $REPO_DIR && git status"
    exit 1
fi
# Leave any still-unpublished CMS edits as plain worktree changes.
wwwide_git reset -q -- site || true
wwwide_notify_clear auto-update-ff

# Keep the HOST admin deps in sync — promote-scheduled.sh and
# dump-webmentions.sh run admin code with the host's node, outside
# the container. Only reinstall when the lockfile actually changed.
if ! wwwide_git diff --quiet "$LOCAL" HEAD -- admin/package-lock.json; then
    echo "$(date): admin lockfile changed — refreshing host node_modules..."
    npm ci --omit=dev --prefix "$REPO_DIR/admin" || \
        echo "$(date): WARNING: host npm ci failed — scheduler/webmention crons may break."
fi

# Content-only updates (CMS publishes touch only site/, which is bind-mounted
# live) need no container rebuild.
if wwwide_git diff --quiet "$LOCAL" HEAD -- . ':(exclude)site'; then
    echo "$(date): Content-only update ($(wwwide_git rev-list --count "$LOCAL..HEAD") commit(s)) — no rebuild needed."
    exit 0
fi

# Rebuild containers gracefully (no "down" — only recreates changed containers)
# This keeps cloudflared and other unchanged services running during rebuild
echo "$(date): Rebuilding changed containers..."
if ! docker compose --project-directory "$DOCKER_DIR" up -d --build --remove-orphans; then
    wwwide_notify auto-update-rebuild 3600 "docker compose rebuild failed after updating to $(wwwide_git rev-parse --short HEAD) — deployment is incomplete."
    exit 1
fi
wwwide_notify_clear auto-update-rebuild

echo "$(date): Update and deployment complete."
