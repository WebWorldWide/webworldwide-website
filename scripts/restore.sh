#!/bin/bash
# Terminal Eighty — Restore Script
# Pulls latest from backup repo and restores all databases.

set -e

APP_DIR="/opt/terminal-eighty"
BACKUP_REPO_DIR="/opt/terminal-eighty-backups"

echo -e "\n  ■ TERMINAL EIGHTY // RESTORE\n"

if [ ! -d "$BACKUP_REPO_DIR" ]; then
    echo "ERROR: Backup directory not found at $BACKUP_REPO_DIR"
    exit 1
fi

cd $APP_DIR/docker

echo ">> Stopping services..."
docker compose stop

# 1. Restore Umami PostgreSQL
if [ -f "$BACKUP_REPO_DIR/umami_backup.sql.gz" ]; then
    echo ">> Restoring Umami Database..."
    # Ensure postgres is running for restore
    docker compose start postgres
    # Wait for PG to be ready
    sleep 5 
    gunzip -c $BACKUP_REPO_DIR/umami_backup.sql.gz | docker compose exec -T postgres psql -U umami -d umami
    docker compose stop postgres
fi

# 2. Restore Remark42
if [ -f "$BACKUP_REPO_DIR/remark42_backup.db" ]; then
    echo ">> Restoring Remark42 Database..."
    sudo cp $BACKUP_REPO_DIR/remark42_backup.db /var/lib/docker/volumes/terminal-eighty_remark_data/_data/remark.db
fi

# 3. Restore CMS
if [ -f "$BACKUP_REPO_DIR/cms_auth_backup.db" ]; then
    echo ">> Restoring CMS Auth Database..."
    sudo cp $BACKUP_REPO_DIR/cms_auth_backup.db /var/lib/docker/volumes/terminal-eighty_cms_data/_data/auth.db
fi

# 4. Restore Environment variables (Optional - requires private key)
if [ -f "$BACKUP_REPO_DIR/env_backup.enc" ]; then
    echo ">> Encrypted .env found. To restore it, run:"
    echo "   age -d -i private.key $BACKUP_REPO_DIR/env_backup.enc > $APP_DIR/docker/.env"
fi

echo ">> Starting services..."
docker compose up -d

echo -e "\n✅ RESTORE COMPLETE"
