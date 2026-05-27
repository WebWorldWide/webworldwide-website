#!/bin/bash
# Terminal Eighty — Pi Bootstrap Script
# Run this on a fresh Raspberry Pi OS Lite 64-bit

set -e

echo -e "\n  ■ TERMINAL EIGHTY // BOOTSTRAP\n"

# 1. Update system
echo ">> Updating system..."
sudo apt update && sudo apt upgrade -y
sudo apt install -y git curl wget ufw age

# 2. Add 2GB Swap file (important for Docker + builds)
echo ">> Configuring swap..."
if [ ! -f /swapfile ]; then
    sudo fallocate -l 2G /swapfile
    sudo chmod 600 /swapfile
    sudo mkswap /swapfile
    sudo swapon /swapfile
    echo '/swapfile none swap sw 0 0' | sudo tee -a /etc/fstab
fi

# 3. Install Docker & Docker Compose
if ! command -v docker &> /dev/null; then
    echo ">> Installing Docker..."
    curl -fsSL https://get.docker.com -o get-docker.sh
    sudo sh get-docker.sh
    sudo usermod -aG docker $USER
    rm get-docker.sh
fi

# 4. Clone repository
APP_DIR="/opt/terminal-eighty"
if [ ! -d "$APP_DIR" ]; then
    echo ">> Please enter your GitHub Username:"
    read -p "Username: " GITHUB_USER
    
    echo ">> Please enter your GitHub PAT (Personal Access Token):"
    read -p "Token: " GITHUB_TOKEN
    
    # We clone into /opt/terminal-eighty
    sudo git clone https://${GITHUB_TOKEN}@github.com/${GITHUB_USER}/terminal-eighty-blog.git $APP_DIR
    sudo chown -R $USER:$USER $APP_DIR
fi

# 4.5. Clone Backup Repository & Setup Encryption
BACKUP_DIR="/opt/terminal-eighty-backups"
if [ ! -d "$BACKUP_DIR" ]; then
    echo ">> Cloning private backup repository..."
    sudo git clone https://${GITHUB_TOKEN}@github.com/${GITHUB_USER}/terminal-eighty-backups.git $BACKUP_DIR
    sudo chown -R $USER:$USER $BACKUP_DIR
    
    # Generate Age Keypair for backups
    if command -v age-keygen &> /dev/null; then
        echo ">> Generating encryption keys for backups..."
        age-keygen -o /tmp/key.txt > /dev/null 2>&1
        PUB_KEY=$(grep "public key" /tmp/key.txt | awk '{print $4}')
        echo $PUB_KEY > $BACKUP_DIR/public.key
        
        echo -e "\n=========================================================="
        echo "🚨 IMPORTANT: SAVE YOUR PRIVATE KEY!"
        echo "Please copy the following private key into your password manager."
        echo "You will need this to restore your blog from backups if the Pi dies!"
        echo "=========================================================="
        cat /tmp/key.txt | grep "AGE-SECRET-KEY"
        echo -e "==========================================================\n"
        rm /tmp/key.txt
        
        # We need git name/email to commit the public key if not set
        cd $BACKUP_DIR
        git config user.name "Terminal Eighty Pi"
        git config user.email "pi@terminaleighty.com"
        git add public.key
        git commit -m "Add age public key for environment backups"
        git push origin main
        cd - > /dev/null
    fi
fi

cd $APP_DIR/docker

# 5. Environment configuration
if [ ! -f .env ]; then
    echo ">> Configuring environment..."
    cp .env.example .env
    
    read -p "Cloudflare Tunnel Token: " CF_TOKEN
    sed -i "s/your-token-here/$CF_TOKEN/" .env
    
    # Generate random secrets
    CMS_SEC=$(openssl rand -base64 32 | tr -d '/')
    REM_SEC=$(openssl rand -base64 32 | tr -d '/')
    UMA_SEC=$(openssl rand -base64 32 | tr -d '/')
    UMA_DB=$(openssl rand -hex 16)
    
    sed -i "s/CMS_SESSION_SECRET=.*/CMS_SESSION_SECRET=$CMS_SEC/" .env
    sed -i "s/REMARK42_SECRET=.*/REMARK42_SECRET=$REM_SEC/" .env
    sed -i "s/UMAMI_SECRET=.*/UMAMI_SECRET=$UMA_SEC/" .env
    sed -i "s/UMAMI_DB_PASSWORD=.*/UMAMI_DB_PASSWORD=$UMA_DB/" .env
fi

# 6. Start Docker Compose
echo ">> Starting services..."
sudo docker compose up -d --build

# 7. Setup Backup Cron (Daily at 2 AM)
echo ">> Setting up automated backups..."
(crontab -l 2>/dev/null | grep -v "backup.sh"; echo "0 2 * * * cd $APP_DIR && ./scripts/backup.sh >> $APP_DIR/backup.log 2>&1") | crontab -

echo -e "\n✅ BOOTSTRAP COMPLETE"
echo "  The system is now running. Wait 1-2 minutes for containers to initialize."
echo "  Access the CMS at: https://admin.terminaleighty.com"
echo "  Note: You may need to log out and log back in for Docker groups to apply."
echo ""
