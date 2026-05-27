#!/bin/bash

# ==============================================================================
# Terminal Eighty — Pi Setup Script
# Run this once after cloning the repo to configure and start all services
# ==============================================================================

set -e

REPO_DIR="/home/adam/terminal-eighty-blog"
DOCKER_DIR="$REPO_DIR/docker"
ENV_FILE="$DOCKER_DIR/.env"

echo ""
echo "╔══════════════════════════════════════════════╗"
echo "║     TERMINAL EIGHTY — PI SETUP              ║"
echo "╚══════════════════════════════════════════════╝"
echo ""

# ── Step 1: Check for existing .env ──
if [ -f "$ENV_FILE" ]; then
    echo "[!] .env file already exists at $ENV_FILE"
    read -p "    Overwrite it? (y/N): " OVERWRITE
    if [ "$OVERWRITE" != "y" ] && [ "$OVERWRITE" != "Y" ]; then
        echo "[*] Keeping existing .env. Skipping to Docker start..."
        echo ""
        docker compose --project-directory "$DOCKER_DIR" up -d --build --remove-orphans
        echo ""
        echo "[✓] Done! All services are running."
        exit 0
    fi
fi

# ── Step 2: Collect Cloudflare Tunnel Token ──
echo "[1/2] CLOUDFLARE TUNNEL TOKEN"
echo "      Get this from: Cloudflare Zero Trust → Networks → Tunnels → Configure"
echo ""
read -p "      Paste your tunnel token: " CF_TOKEN

if [ -z "$CF_TOKEN" ]; then
    echo "[!] No token provided. Exiting."
    exit 1
fi

# ── Step 3: Generate secrets automatically ──
echo ""
echo "[2/2] GENERATING SECRETS..."

CMS_SECRET=$(openssl rand -base64 32)
REMARK_SECRET=$(openssl rand -base64 32)
UMAMI_SECRET=$(openssl rand -base64 32)
UMAMI_DB_PASS=$(openssl rand -base64 24 | tr -d '/+=' | head -c 32)

# ── Step 4: Write .env file ──
cat > "$ENV_FILE" <<EOF
# ── Domains ──
DOMAIN_ADMIN=admin.terminaleighty.com
DOMAIN_COMMENTS=comments.terminaleighty.com
DOMAIN_ANALYTICS=analytics.terminaleighty.com

# ── Cloudflare ──
CLOUDFLARE_TUNNEL_TOKEN=$CF_TOKEN

# ── CMS Auth ──
CMS_SESSION_SECRET=$CMS_SECRET

# ── Remark42 ──
REMARK42_SECRET=$REMARK_SECRET
REMARK42_ADMIN_ID=admin

# ── Umami ──
UMAMI_SECRET=$UMAMI_SECRET
UMAMI_DB_PASSWORD=$UMAMI_DB_PASS
EOF

echo "      .env written to $ENV_FILE"

# ── Step 5: Git safe directory ──
echo ""
echo "[*] Configuring git safe directory..."
git config --global --add safe.directory "$REPO_DIR"

# ── Step 6: Start Docker stack ──
echo ""
echo "[*] Starting Docker stack..."
docker compose --project-directory "$DOCKER_DIR" up -d --build --remove-orphans

# ── Step 7: Setup crontab ──
echo ""
echo "[*] Setting up auto-update and maintenance cron jobs..."

# Check if cron jobs already exist
CRON_EXISTS=$(crontab -l 2>/dev/null | grep -c "auto-update.sh" || true)
if [ "$CRON_EXISTS" -eq 0 ]; then
    (crontab -l 2>/dev/null; echo ""; echo "# Terminal Eighty Auto-Update (every 5 minutes)"; echo "*/5 * * * * $REPO_DIR/scripts/auto-update.sh >> /var/log/auto-update.log 2>&1"; echo "# Terminal Eighty Maintenance (Sundays at 3 AM)"; echo "0 3 * * 0 $REPO_DIR/scripts/maintenance.sh >> /var/log/maintenance.log 2>&1") | crontab -
    echo "      Cron jobs installed."
else
    echo "      Cron jobs already exist. Skipping."
fi

# ── Done ──
echo ""
echo "╔══════════════════════════════════════════════╗"
echo "║     SETUP COMPLETE                          ║"
echo "╚══════════════════════════════════════════════╝"
echo ""
echo "  Services:"
echo "    CMS:       https://admin.terminaleighty.com"
echo "    Comments:  https://comments.terminaleighty.com"
echo "    Analytics: https://analytics.terminaleighty.com"
echo ""
echo "  Auto-update: Every 5 minutes"
echo "  Maintenance: Sundays at 3:00 AM"
echo ""
echo "  To check status:  docker ps"
echo "  To view logs:     docker compose --project-directory $DOCKER_DIR logs -f"
echo ""
