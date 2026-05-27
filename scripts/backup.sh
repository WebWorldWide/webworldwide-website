#!/bin/bash
# Terminal Eighty — Nightly Backup Script
# Dumps DBs, encrypts secrets, and pushes to a private GitHub repo.

set -e

# Configuration
APP_DIR="/opt/terminal-eighty"
BACKUP_REPO_DIR="/opt/terminal-eighty-backups"
TIMESTAMP=$(date +%Y%m%d_%H%M%S)

echo "Starting backup at $(date)"

# Ensure backup repo exists locally
if [ ! -d "$BACKUP_REPO_DIR/.git" ]; then
    echo "ERROR: Backup repository not found at $BACKUP_REPO_DIR"
    echo "Please run 'git clone <your-backup-repo-url> $BACKUP_REPO_DIR' first."
    exit 1
fi

cd $APP_DIR/docker

# 1. Backup Umami PostgreSQL
echo "Dumping Umami database..."
docker compose exec -T postgres pg_dump -U umami umami > $BACKUP_REPO_DIR/umami_backup.sql

# 2. Compress the SQL dump
echo "Compressing Umami dump..."
gzip -f $BACKUP_REPO_DIR/umami_backup.sql

# 3. Backup Remark42 BoltDB (Requires brief stop for data consistency)
echo "Backing up Remark42..."
docker compose stop remark42
# BoltDB is a single file, we just copy it
sudo cp /var/lib/docker/volumes/terminal-eighty_remark_data/_data/remark.db $BACKUP_REPO_DIR/remark42_backup.db
# Ensure ownership
sudo chown $USER:$USER $BACKUP_REPO_DIR/remark42_backup.db
docker compose start remark42

# 4. Backup CMS SQLite DB
echo "Backing up CMS Auth DB..."
docker compose stop cms
sudo cp /var/lib/docker/volumes/terminal-eighty_cms_data/_data/auth.db $BACKUP_REPO_DIR/cms_auth_backup.db
sudo chown $USER:$USER $BACKUP_REPO_DIR/cms_auth_backup.db
docker compose start cms

# 5. Backup Secrets (.env) using Age encryption
# Note: You should have an age keypair. Public key is in the backup repo, private key is kept safe elsewhere.
if [ -f "$BACKUP_REPO_DIR/public.key" ]; then
    echo "Encrypting .env..."
    age -R $BACKUP_REPO_DIR/public.key -o $BACKUP_REPO_DIR/env_backup.enc .env
else
    echo "WARNING: $BACKUP_REPO_DIR/public.key not found. Not backing up .env"
fi

# 6. Commit and push to GitHub
echo "Pushing to GitHub..."
cd $BACKUP_REPO_DIR
git add .
git commit -m "Automated backup: $TIMESTAMP"
git push origin main

echo "Backup completed successfully at $(date)"

# Phase 5e: write a marker file the admin dashboard reads to surface
# "Last backup: N hours ago". Lives in the per-user state dir so the
# admin process can find it without elevated permissions.
MARKER_DIR="${TE_STATE_DIR:-$HOME/.terminal-eighty}"
mkdir -p "$MARKER_DIR"
date -u +"%Y-%m-%dT%H:%M:%SZ" > "$MARKER_DIR/.last_backup"
