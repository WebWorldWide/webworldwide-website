#!/bin/bash
# Web World Wide — Restore Script
# Pulls latest from backup repo and restores all databases.

set -euo pipefail

APP_DIR="/opt/web-world-wide"
BACKUP_REPO_DIR="/opt/www-blog-backups"
SCRIPT_DIR="$APP_DIR/scripts"

# Restore is destructive and stops the full stack, so it must never overlap a
# deploy, backup, watchdog recovery, or content publish.
# shellcheck source=scripts/_operation-lock.sh
. "$SCRIPT_DIR/_operation-lock.sh"
acquire_wwwide_operation_lock "$APP_DIR" wait 300

echo -e "\n  ■ TERMINAL EIGHTY // RESTORE\n"

if [ ! -d "$BACKUP_REPO_DIR" ]; then
    echo "ERROR: Backup directory not found at $BACKUP_REPO_DIR"
    exit 1
fi

cd "$APP_DIR/docker"

echo ">> Stopping services..."
docker compose stop

# Safety net: the line above stops the WHOLE stack. If any restore step below
# fails (set -e aborts), this trap brings everything back up so a failed
# restore never leaves the site offline with no auto-recovery.
trap 'echo ">> (restoring service state)"; docker compose up -d || true' EXIT

# 1. Restore Umami PostgreSQL.
if [ -f "$BACKUP_REPO_DIR/umami_backup.sql.gz" ]; then
    echo ">> Restoring Umami Database..."
    # Ensure postgres is running for restore.
    docker compose start postgres
    # Wait for PG to be ready.
    sleep 5
    # ON_ERROR_STOP=1 so a broken restore fails loudly (the trap restarts the
    # stack) instead of half-applying and exiting 0. The dump is taken with
    # --clean --if-exists (see backup.sh), so it drops+recreates objects.
    gunzip -c "$BACKUP_REPO_DIR/umami_backup.sql.gz" \
        | docker compose exec -T postgres psql -v ON_ERROR_STOP=1 -U umami -d umami
    docker compose stop postgres
fi

# 2. Restore Remark42 (comments). backup.sh stores the whole /srv/var as a
# DIRECTORY (remark42_var/), so mirror that: copy the contents back into the
# stopped container's /srv/var. (The old code looked for a single
# remark42_backup.db file that backup.sh never writes — comments could be
# backed up but never restored.)
if [ -d "$BACKUP_REPO_DIR/remark42_var" ]; then
    echo ">> Restoring Remark42 (comments)..."
    # Container is stopped (compose stop above); docker cp still works.
    docker cp "$BACKUP_REPO_DIR/remark42_var/." remark42:/srv/var
else
    echo ">> No remark42_var/ in backup — skipping comments restore."
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
