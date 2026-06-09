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
if docker ps -a --format '{{.Names}}' | grep -qx 'remark42'; then
    echo "Backing up Remark42..."
    docker compose stop remark42
    STOPPED_SERVICES="$STOPPED_SERVICES remark42"
    docker cp remark42:/srv/var/remark.db "$BACKUP_REPO_DIR/remark42_backup.db"
    docker compose start remark42
    STOPPED_SERVICES="${STOPPED_SERVICES// remark42/}"
else
    echo "WARNING: remark42 container not found — skipping its backup."
fi

# 4. Backup CMS SQLite DB (same brief-stop + docker cp pattern)
echo "Backing up CMS Auth DB..."
docker compose stop cms
STOPPED_SERVICES="$STOPPED_SERVICES cms"
docker cp cms:/app/data/auth.db "$BACKUP_REPO_DIR/cms_auth_backup.db"
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

# 6. Commit and push to GitHub
echo "Pushing to GitHub..."
cd "$BACKUP_REPO_DIR"
git add .
if git diff --cached --quiet; then
    echo "Nothing new to back up."
else
    git commit -m "Automated backup: $TIMESTAMP"
    git push origin main
fi

echo "Backup completed successfully at $(date)"

# Phase 5e: write a marker file the admin dashboard reads to surface
# "Last backup: N hours ago". Lives in the per-user state dir so the
# admin process can find it without elevated permissions.
MARKER_DIR="${TE_STATE_DIR:-$HOME/.web-world-wide}"
mkdir -p "$MARKER_DIR"
date -u +"%Y-%m-%dT%H:%M:%SZ" > "$MARKER_DIR/.last_backup"
