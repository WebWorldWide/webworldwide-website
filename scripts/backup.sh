#!/bin/bash
# Web World Wide — Nightly Backup Script
# Dumps DBs, encrypts secrets, and pushes to a private GitHub repo.
#
# Failure posture: each service we stop is guaranteed a restart via the
# EXIT trap, and a failed step must never silently skip the steps after
# it (the 2026-06 incident: a bad remark42 copy path aborted the script
# nightly — the CMS DB was never backed up and remark42 was once left
# stopped, then reaped by `docker system prune`).

set -euo pipefail

# Configuration
APP_DIR="/opt/web-world-wide"
BACKUP_REPO_DIR="/opt/www-blog-backups"
TIMESTAMP=$(date +%Y%m%d_%H%M%S)

# Git auth: token lives in docker/.env (0600). The repos' credential
# helper reads $GH_TOKEN — see .git/config credential.helper.
GH_TOKEN="$(grep -m1 '^GH_TOKEN=' "$APP_DIR/docker/.env" 2>/dev/null | cut -d= -f2- || true)"
export GH_TOKEN

echo "Starting backup at $(date)"

# Ensure backup repo exists locally
if [ ! -d "$BACKUP_REPO_DIR/.git" ]; then
    echo "ERROR: Backup repository not found at $BACKUP_REPO_DIR"
    echo "Please run 'git clone <your-backup-repo-url> $BACKUP_REPO_DIR' first."
    exit 1
fi

cd "$APP_DIR/docker"

# Whatever happens below, never leave a service stopped.
STOPPED_SERVICES=""
restart_stopped() {
    if [ -n "$STOPPED_SERVICES" ]; then
        # shellcheck disable=SC2086 # intentional word-splitting of service names
        docker compose start $STOPPED_SERVICES || true
    fi
}
trap restart_stopped EXIT

# 1. Backup Umami PostgreSQL
echo "Dumping Umami database..."
docker compose exec -T postgres pg_dump -U umami umami > "$BACKUP_REPO_DIR/umami_backup.sql"

# 2. Compress the SQL dump
echo "Compressing Umami dump..."
gzip -f "$BACKUP_REPO_DIR/umami_backup.sql"

# 3. Backup Remark42 BoltDB (brief stop for data consistency).
# `docker cp` reads from the container filesystem (works while stopped)
# — never reach into /var/lib/docker/volumes, whose layout is not ours.
# Copy the WHOLE data dir: the bolt store is per-site ({site}.db) and
# created lazily, so on a fresh container the file may not exist yet —
# a missing store must warn and continue, never abort the script
# (the 2026-06 incident, second verse).
if docker ps -a --format '{{.Names}}' | grep -qx 'remark42'; then
    echo "Backing up Remark42..."
    docker compose stop remark42
    STOPPED_SERVICES="$STOPPED_SERVICES remark42"
    if docker cp remark42:/srv/var "$BACKUP_REPO_DIR/remark42_var.tmp" 2>/dev/null; then
        rm -rf "$BACKUP_REPO_DIR/remark42_var"
        mv "$BACKUP_REPO_DIR/remark42_var.tmp" "$BACKUP_REPO_DIR/remark42_var"
    else
        echo "WARNING: could not copy remark42 /srv/var (fresh store?) — skipping its backup."
        rm -rf "$BACKUP_REPO_DIR/remark42_var.tmp"
    fi
    docker compose start remark42
    STOPPED_SERVICES="${STOPPED_SERVICES// remark42/}"
else
    echo "WARNING: remark42 container not found — skipping its backup."
fi

# 4. Backup CMS SQLite DB (same brief-stop + docker cp pattern; same
# warn-don't-abort posture so the .env backup + push always run).
#
# CRITICAL: auth.db runs in WAL mode. Recent writes (comment moderation,
# webmentions, media, post snapshots, activity) live in `auth.db-wal`
# until a checkpoint folds them into auth.db — and a *stopped* container
# never checkpoints. Copying auth.db alone silently loses everything
# since the last checkpoint. So copy the WAL sidecars too; SQLite replays
# them when the DB is reopened. The container is stopped here, so the
# three files are a consistent, race-free snapshot.
#
# The `|| rm -f` on each sidecar matters for correctness: if a future run
# finds the DB already checkpointed (no -wal in the container), we must
# DELETE any stale -wal/-shm left in the backup repo — applying an old
# WAL to a newer DB would corrupt the restore.
echo "Backing up CMS Auth DB (incl. WAL sidecars)..."
docker compose stop cms
STOPPED_SERVICES="$STOPPED_SERVICES cms"
if ! docker cp cms:/app/data/auth.db "$BACKUP_REPO_DIR/cms_auth_backup.db" 2>/dev/null; then
    echo "WARNING: could not copy cms auth.db — skipping its backup."
fi
docker cp cms:/app/data/auth.db-wal "$BACKUP_REPO_DIR/cms_auth_backup.db-wal" 2>/dev/null \
    || rm -f "$BACKUP_REPO_DIR/cms_auth_backup.db-wal"
docker cp cms:/app/data/auth.db-shm "$BACKUP_REPO_DIR/cms_auth_backup.db-shm" 2>/dev/null \
    || rm -f "$BACKUP_REPO_DIR/cms_auth_backup.db-shm"
docker compose start cms
STOPPED_SERVICES="${STOPPED_SERVICES// cms/}"

# 5. Backup Secrets (.env) using Age encryption
# Note: You should have an age keypair. Public key is in the backup repo, private key is kept safe elsewhere.
if [ -f "$BACKUP_REPO_DIR/public.key" ]; then
    echo "Encrypting .env..."
    age -R "$BACKUP_REPO_DIR/public.key" -o "$BACKUP_REPO_DIR/env_backup.enc" .env
else
    echo "WARNING: $BACKUP_REPO_DIR/public.key not found. Not backing up .env"
fi

# 6. Commit and push to GitHub. Identity is passed inline — the cron
# runs as root, whose global git config has none (a fresh clone
# otherwise dies at "unable to auto-detect email" right here).
echo "Pushing to GitHub..."
cd "$BACKUP_REPO_DIR"
git add .
if git diff --cached --quiet; then
    echo "Nothing new to back up."
else
    git -c user.name="Web World Wide Pi" -c user.email="pi@webworldwide.online" \
        commit -m "Automated backup: $TIMESTAMP"
    git push origin main
fi

echo "Backup completed successfully at $(date)"

# Phase 5e: write a marker file the admin dashboard reads to surface
# "Last backup: N hours ago". Lives in the per-user state dir so the
# admin process can find it without elevated permissions.
MARKER_DIR="${TE_STATE_DIR:-$HOME/.web-world-wide}"
mkdir -p "$MARKER_DIR"
date -u +"%Y-%m-%dT%H:%M:%SZ" > "$MARKER_DIR/.last_backup"
