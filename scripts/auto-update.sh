#!/bin/bash

# ==============================================================================
# Terminal Eighty Auto-Update Script
# Runs via cron to pull latest GitHub changes and restart Docker containers
# ==============================================================================

# Variables
REPO_DIR="/home/adam/terminal-eighty-blog"
DOCKER_DIR="$REPO_DIR/docker"

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
    
    # Rebuild containers gracefully (no "down" — only recreates changed containers)
    # This keeps cloudflared and other unchanged services running during rebuild
    echo "$(date): Rebuilding changed containers..."
    docker compose --project-directory "$DOCKER_DIR" up -d --build --remove-orphans
    
    echo "$(date): Update and deployment complete."
else
    echo "$(date): System is up to date."
fi
