#!/bin/bash
# Web World Wide — Restore Script
# Pulls latest from backup repo and restores all databases.

set -e

APP_DIR="/opt/web-world-wide"
BACKUP_REPO_DIR="/opt/www-blog-backups"

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
    sudo cp $BACKUP_REPO_DIR/remark42_backup.db /var/lib/docker/volumes/web-world-wide_remark_data/_data/remark.db
fi

# 3. Restore CMS (auth.db + its WAL sidecars — see backup.sh for why).
if [ -f "$BACKUP_REPO_DIR/cms_auth_backup.db" ]; then
    echo ">> Restoring CMS Auth Database (incl. WAL sidecars)..."
    CMS_DATA=/var/lib/docker/volumes/web-world-wide_cms_data/_data
    sudo cp "$BACKUP_REPO_DIR/cms_auth_backup.db" "$CMS_DATA/auth.db"
    # Restore the WAL sidecars so SQLite replays everything written since
    # the last checkpoint. If the backup has none, REMOVE any stale
    # sidecars in the target — replaying a foreign WAL would corrupt it.
    if [ -f "$BACKUP_REPO_DIR/cms_auth_backup.db-wal" ]; then
        sudo cp "$BACKUP_REPO_DIR/cms_auth_backup.db-wal" "$CMS_DATA/auth.db-wal"
    else
        sudo rm -f "$CMS_DATA/auth.db-wal"
    fi
    if [ -f "$BACKUP_REPO_DIR/cms_auth_backup.db-shm" ]; then
        sudo cp "$BACKUP_REPO_DIR/cms_auth_backup.db-shm" "$CMS_DATA/auth.db-shm"
    else
        sudo rm -f "$CMS_DATA/auth.db-shm"
    fi
fi

# 4. Restore Environment variables (Optional - requires private key)
if [ -f "$BACKUP_REPO_DIR/env_backup.enc" ]; then
    echo ">> Encrypted .env found. To restore it, run:"
    echo "   age -d -i private.key $BACKUP_REPO_DIR/env_backup.enc > $APP_DIR/docker/.env"
fi

echo ">> Starting services..."
docker compose up -d

echo -e "\n✅ RESTORE COMPLETE"
