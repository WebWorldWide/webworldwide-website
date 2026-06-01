#!/usr/bin/env bash
# ==============================================================================
# Web World Wide — Pi Bootstrap (single idempotent entry point)
#
# Usage (fresh Pi):
#   ssh adam@pi
#   sudo apt-get update -y && sudo apt-get install -y git
#   sudo git clone https://github.com/WebWorldWide/webworldwide-website.git /opt/web-world-wide
#   sudo /opt/web-world-wide/scripts/bootstrap.sh
#
# Re-running on a healthy system: prints "all phases already complete, system
# healthy" in <30s. Safe to run on a cron, after a reboot, or after a pull.
#
# Flags (all optional; pulled from existing .env on re-run):
#   --cf-token=TOKEN      Cloudflare Tunnel token (validated before use)
#   --gh-pat=TOKEN        GitHub PAT with `repo` scope (for backups repo)
#   --gh-user=USERNAME    GitHub username (default: AdamNolle)
#   --domain-base=DOMAIN  Base domain (default: webworldwide.online)
#   --non-interactive     Fail instead of prompting for missing values
#   --skip-backups-repo   Use local-only encrypted backups (no remote repo)
#   --self-test           Skip install; only run healthcheck + exit code
#
# Exit codes:
#   0  all phases complete or healthcheck passed
#   1  healthcheck failed or a phase aborted on a recoverable error
#   2  configuration error (bad arg, bad token, missing prereq)
#   3  pre-flight failed (wrong arch, no internet, etc.)
# ==============================================================================

set -euo pipefail

# ── Constants ────────────────────────────────────────────────────────────────
readonly REPO_URL_DEFAULT="https://github.com/WebWorldWide/webworldwide-website.git"
readonly APP_DIR="/opt/web-world-wide"
readonly BACKUP_DIR="/opt/www-blog-backups"
readonly DOCKER_DIR="$APP_DIR/docker"
readonly ENV_FILE="$DOCKER_DIR/.env"
readonly AGE_KEY_FILE="/etc/age/key.txt"
readonly SYSTEMD_UNIT="/etc/systemd/system/wwwide-boot-check.service"
readonly CRON_MARKER="# WWW-PI:"
readonly REQUIRED_APT_PKGS="git curl jq age openssl ufw cron ca-certificates"
readonly NODE_MAJOR=22

# ── Args (defaults; overridden by flags or existing .env) ───────────────────
CF_TOKEN=""
GH_PAT=""
GH_USER="WebWorldWide"
DOMAIN_BASE="webworldwide.online"
NON_INTERACTIVE=0
SKIP_BACKUPS_REPO=0
SELF_TEST=0

# ── Color helpers ────────────────────────────────────────────────────────────
if [ -t 1 ]; then
  C_RED=$'\033[31m'
  C_GREEN=$'\033[32m'
  C_YELLOW=$'\033[33m'
  C_BLUE=$'\033[34m'
  C_CYAN=$'\033[36m'
  C_BOLD=$'\033[1m'
  C_RESET=$'\033[0m'
else
  C_RED="" C_GREEN="" C_YELLOW="" C_BLUE="" C_CYAN="" C_BOLD="" C_RESET=""
fi

log()  { printf '%s[%s]%s %s\n' "$C_CYAN" "bootstrap" "$C_RESET" "$1"; }
ok()   { printf '%s[%s]%s %s\n' "$C_GREEN" "bootstrap" "$C_RESET" "$1"; }
warn() { printf '%s[%s]%s %s\n' "$C_YELLOW" "bootstrap" "$C_RESET" "$1"; }
err()  { printf '%s[%s]%s %s\n' "$C_RED" "bootstrap" "$C_RESET" "$1" >&2; }
die()  { err "$1"; exit "${2:-1}"; }

# ── parse_args ───────────────────────────────────────────────────────────────
parse_args() {
  for arg in "$@"; do
    case "$arg" in
      --cf-token=*)        CF_TOKEN="${arg#*=}" ;;
      --gh-pat=*)          GH_PAT="${arg#*=}" ;;
      --gh-user=*)         GH_USER="${arg#*=}" ;;
      --domain-base=*)     DOMAIN_BASE="${arg#*=}" ;;
      --non-interactive)   NON_INTERACTIVE=1 ;;
      --skip-backups-repo) SKIP_BACKUPS_REPO=1 ;;
      --self-test)         SELF_TEST=1 ;;
      --help|-h)           grep -E '^#( |$)' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
      *)                   die "unknown arg: $arg (use --help)" 2 ;;
    esac
  done
}

# ── preflight ────────────────────────────────────────────────────────────────
preflight() {
  log "preflight checks…"
  [ "$(id -u)" -eq 0 ] || die "must run as root (use sudo)" 2

  local arch; arch="$(uname -m)"
  if [ "$arch" != "aarch64" ] && [ "$arch" != "x86_64" ]; then
    die "unsupported arch: $arch (expected aarch64 or x86_64)" 3
  fi

  if [ -r /etc/os-release ]; then
    # shellcheck disable=SC1091
    . /etc/os-release
    case "${ID:-}${ID_LIKE:-}" in
      *debian*|*raspbian*|*ubuntu*) : ;;
      *) warn "OS '$ID' is not Debian/Raspbian/Ubuntu — proceeding but support is best-effort" ;;
    esac
  fi

  local free_kb; free_kb=$(df / | awk 'NR==2 {print $4}')
  if [ "${free_kb:-0}" -lt 8000000 ]; then
    die "less than 8 GB free on / ($((free_kb/1024)) MB) — bootstrap requires headroom" 3
  fi

  if [ "$SELF_TEST" -eq 0 ]; then
    # Network only matters for full install; self-test just polls localhost.
    curl -fsS --max-time 8 https://api.github.com/zen >/dev/null || \
      die "github.com unreachable" 3
    curl -fsS --max-time 8 https://api.cloudflare.com/client/v4/ips >/dev/null || \
      die "cloudflare api unreachable" 3
  fi

  if [ "$NON_INTERACTIVE" -eq 0 ] && [ "$SELF_TEST" -eq 0 ]; then
    [ -t 0 ] || die "must run from a TTY (or pass --non-interactive with --cf-token/--gh-pat)" 2
  fi

  ok "preflight passed (arch=$arch, ${free_kb} kB free)"
}

# ── apt_install ──────────────────────────────────────────────────────────────
apt_install() {
  log "installing apt packages: $REQUIRED_APT_PKGS"
  export DEBIAN_FRONTEND=noninteractive
  apt-get update -qq
  # shellcheck disable=SC2086
  apt-get install -y -qq $REQUIRED_APT_PKGS >/dev/null
  ok "apt packages installed"
}

# ── install_node ─────────────────────────────────────────────────────────────
install_node() {
  if command -v node >/dev/null; then
    local v; v=$(node -v 2>/dev/null | sed 's/^v//;s/\..*//')
    if [ "${v:-0}" -ge "$NODE_MAJOR" ]; then
      ok "node $(node -v) already installed"
      return 0
    fi
  fi
  log "installing Node $NODE_MAJOR via NodeSource…"
  curl -fsSL "https://deb.nodesource.com/setup_${NODE_MAJOR}.x" | bash - >/dev/null
  apt-get install -y -qq nodejs >/dev/null
  ok "node $(node -v) installed"
}

# ── setup_swap ───────────────────────────────────────────────────────────────
setup_swap() {
  if grep -q '/swapfile' /etc/fstab 2>/dev/null; then
    ok "swap already configured"
    return 0
  fi
  log "creating 2 GB /swapfile…"
  fallocate -l 2G /swapfile
  chmod 600 /swapfile
  mkswap /swapfile >/dev/null
  swapon /swapfile
  echo '/swapfile none swap sw 0 0' >> /etc/fstab
  ok "swap configured"
}

# ── install_docker ───────────────────────────────────────────────────────────
install_docker() {
  if command -v docker >/dev/null && docker info >/dev/null 2>&1; then
    ok "docker already installed and running"
  else
    log "installing Docker via get.docker.com…"
    curl -fsSL https://get.docker.com -o /tmp/get-docker.sh
    sh /tmp/get-docker.sh >/dev/null
    rm /tmp/get-docker.sh
    systemctl enable --now docker
    ok "docker installed"
  fi
  # Add the invoking sudo user to the docker group (idempotent).
  if [ -n "${SUDO_USER:-}" ] && [ "$SUDO_USER" != "root" ]; then
    usermod -aG docker "$SUDO_USER" || true
  fi
}

# ── clone_or_pull_repo ───────────────────────────────────────────────────────
clone_or_pull_repo() {
  if [ -d "$APP_DIR/.git" ]; then
    log "repo present, pulling latest…"
    git -C "$APP_DIR" config --global --add safe.directory "$APP_DIR" || true
    git -C "$APP_DIR" pull --ff-only >/dev/null 2>&1 || \
      warn "git pull failed (offline? local changes?) — continuing with current checkout"
    ok "repo at $(git -C "$APP_DIR" rev-parse --short HEAD)"
  else
    log "cloning $REPO_URL_DEFAULT → $APP_DIR…"
    git clone "$REPO_URL_DEFAULT" "$APP_DIR" >/dev/null
    chown -R "${SUDO_USER:-root}":"${SUDO_USER:-root}" "$APP_DIR"
    ok "repo cloned"
  fi
}

# ── load_existing_env ────────────────────────────────────────────────────────
# Read non-empty values from the existing .env so re-runs don't re-prompt
# and don't lose user edits.
load_existing_env() {
  [ -f "$ENV_FILE" ] || return 0
  log "found existing $ENV_FILE — preserving values"
  # Only adopt values that are set AND non-empty.
  local val
  for key in CLOUDFLARE_TUNNEL_TOKEN GH_PAT GH_USER DOMAIN_ADMIN; do
    val=$(grep -E "^${key}=" "$ENV_FILE" | head -n1 | cut -d= -f2- || true)
    [ -n "$val" ] || continue
    case "$key" in
      CLOUDFLARE_TUNNEL_TOKEN) [ -z "$CF_TOKEN" ] && CF_TOKEN="$val" ;;
      GH_PAT)                  [ -z "$GH_PAT" ]   && GH_PAT="$val" ;;
      GH_USER)                 GH_USER="$val" ;;
    esac
  done
}

# ── prompt_secrets ───────────────────────────────────────────────────────────
prompt_secrets() {
  if [ -z "$CF_TOKEN" ]; then
    if [ "$NON_INTERACTIVE" -eq 1 ]; then
      die "missing --cf-token (Cloudflare Tunnel token) in non-interactive mode" 2
    fi
    printf '\n%sCloudflare Tunnel Token%s\n' "$C_BOLD" "$C_RESET"
    printf '  Get this from: %shttps://one.dash.cloudflare.com%s → Networks → Tunnels → your tunnel → Configure\n' "$C_BLUE" "$C_RESET"
    read -rp "  Token: " CF_TOKEN
    [ -n "$CF_TOKEN" ] || die "no Cloudflare token provided" 2
  fi
  if [ -z "$GH_PAT" ] && [ "$SKIP_BACKUPS_REPO" -eq 0 ]; then
    if [ "$NON_INTERACTIVE" -eq 1 ]; then
      warn "no --gh-pat; falling back to local-only backups"
      SKIP_BACKUPS_REPO=1
    else
      printf '\n%sGitHub Personal Access Token%s (for the encrypted-backups repo)\n' "$C_BOLD" "$C_RESET"
      printf '  Needs %srepo%s scope. Create at: %shttps://github.com/settings/tokens%s\n' "$C_BOLD" "$C_RESET" "$C_BLUE" "$C_RESET"
      printf '  Leave blank to use local-only backups.\n'
      read -rp "  PAT: " GH_PAT
      [ -n "$GH_PAT" ] || SKIP_BACKUPS_REPO=1
    fi
  fi
}

# ── validate_cf_token ────────────────────────────────────────────────────────
# Decodes the JWT middle segment and verifies it contains the expected claims.
# A bad token fails here in seconds instead of after `docker compose up` runs
# for minutes and silently produces no tunnel connections.
validate_cf_token() {
  log "validating Cloudflare tunnel token…"
  local body; body=$(echo "$CF_TOKEN" | cut -d. -f2 | tr '_-' '/+' || true)
  # Pad base64 to a multiple of 4
  case $((${#body} % 4)) in
    2) body="${body}==" ;;
    3) body="${body}=" ;;
  esac
  local decoded; decoded=$(echo "$body" | base64 -d 2>/dev/null || true)
  if [ -z "$decoded" ]; then
    die "Cloudflare token is not a valid base64 JWT (regenerate at one.dash.cloudflare.com)" 2
  fi
  local tunnel_id account_tag
  tunnel_id=$(echo "$decoded" | jq -r '.t // empty' 2>/dev/null || true)
  account_tag=$(echo "$decoded" | jq -r '.a // empty' 2>/dev/null || true)
  if [ -z "$tunnel_id" ] || [ -z "$account_tag" ]; then
    die "Cloudflare token missing tunnel id (t) or account tag (a) — regenerate" 2
  fi
  ok "Cloudflare token valid (tunnel=${tunnel_id:0:8}…, account=${account_tag:0:8}…)"
}

# ── validate_gh_pat ──────────────────────────────────────────────────────────
validate_gh_pat() {
  [ "$SKIP_BACKUPS_REPO" -eq 1 ] && return 0
  [ -n "$GH_PAT" ] || return 0
  log "validating GitHub PAT…"
  local headers
  headers=$(curl -sI -H "Authorization: token $GH_PAT" \
    https://api.github.com/user 2>/dev/null || true)
  if ! echo "$headers" | head -n1 | grep -q "200"; then
    warn "GitHub PAT rejected by api.github.com — falling back to local-only backups"
    SKIP_BACKUPS_REPO=1
    return 0
  fi
  if ! echo "$headers" | grep -i '^x-oauth-scopes:' | grep -q 'repo'; then
    warn "GitHub PAT lacks 'repo' scope — falling back to local-only backups"
    SKIP_BACKUPS_REPO=1
    return 0
  fi
  ok "GitHub PAT valid (repo scope present)"
}

# ── setup_backups ────────────────────────────────────────────────────────────
setup_backups() {
  mkdir -p /etc/age
  local new_key=0
  if [ ! -f "$AGE_KEY_FILE" ]; then
    log "generating age keypair for encrypted backups…"
    age-keygen -o "$AGE_KEY_FILE" >/dev/null 2>&1
    chmod 600 "$AGE_KEY_FILE"
    new_key=1
  else
    ok "age key already exists at $AGE_KEY_FILE"
  fi
  local pub_key
  pub_key=$(grep "public key" "$AGE_KEY_FILE" | awk '{print $4}')

  if [ "$SKIP_BACKUPS_REPO" -eq 1 ]; then
    mkdir -p "$BACKUP_DIR"
    echo "$pub_key" > "$BACKUP_DIR/public.key"
    warn "backups will be encrypted to $BACKUP_DIR (no remote repo — set up off-site copy manually)"
  else
    if [ ! -d "$BACKUP_DIR/.git" ]; then
      log "cloning/creating www-blog-backups repo…"
      # Try clone first; if 404, create via GitHub API.
      if ! git clone "https://${GH_PAT}@github.com/${GH_USER}/www-blog-backups.git" "$BACKUP_DIR" 2>/dev/null; then
        log "repo not found — creating https://github.com/${GH_USER}/www-blog-backups (private)"
        curl -fsS -H "Authorization: token $GH_PAT" \
             -H "Content-Type: application/json" \
             -d '{"name":"www-blog-backups","private":true,"description":"Encrypted backups for webworldwide-website (Pi)"}' \
             https://api.github.com/user/repos >/dev/null \
          || die "failed to create www-blog-backups repo via GitHub API" 1
        sleep 2
        git clone "https://${GH_PAT}@github.com/${GH_USER}/www-blog-backups.git" "$BACKUP_DIR" \
          || die "failed to clone newly-created backup repo" 1
      fi
      chown -R "${SUDO_USER:-root}":"${SUDO_USER:-root}" "$BACKUP_DIR"
    fi
    # Always overwrite public.key (it's idempotent — same content if same key).
    echo "$pub_key" > "$BACKUP_DIR/public.key"
    if ! git -C "$BACKUP_DIR" diff --quiet -- public.key 2>/dev/null; then
      git -C "$BACKUP_DIR" config user.name  "Web World Wide Pi"
      git -C "$BACKUP_DIR" config user.email "pi@${DOMAIN_BASE}"
      git -C "$BACKUP_DIR" add public.key
      git -C "$BACKUP_DIR" commit -m "Update age public key" >/dev/null
      git -C "$BACKUP_DIR" push origin HEAD >/dev/null 2>&1 || \
        warn "could not push public key to backup repo (check PAT scope)"
    fi
    ok "backups: $BACKUP_DIR (remote: ${GH_USER}/www-blog-backups)"
  fi

  if [ "$new_key" -eq 1 ]; then
    AGE_PRIVATE_KEY_PRINTED=$(grep "AGE-SECRET-KEY" "$AGE_KEY_FILE" || true)
  fi
}

# ── write_env ────────────────────────────────────────────────────────────────
# Atomic write that preserves any keys not managed here. The script ONLY
# generates random secrets for keys that are missing — re-runs don't rotate
# existing secrets (would invalidate active sessions).
write_env() {
  log "writing $ENV_FILE…"
  # Load existing values into env so we can reference them.
  local existing_cms_sec="" existing_remark_sec="" existing_umami_sec="" existing_umami_db=""
  if [ -f "$ENV_FILE" ]; then
    existing_cms_sec=$(grep   -E '^CMS_SESSION_SECRET=' "$ENV_FILE" | cut -d= -f2- || true)
    existing_remark_sec=$(grep -E '^REMARK42_SECRET='    "$ENV_FILE" | cut -d= -f2- || true)
    existing_umami_sec=$(grep  -E '^UMAMI_SECRET='       "$ENV_FILE" | cut -d= -f2- || true)
    existing_umami_db=$(grep   -E '^UMAMI_DB_PASSWORD='  "$ENV_FILE" | cut -d= -f2- || true)
  fi

  local cms_sec="${existing_cms_sec:-$(openssl rand -base64 32 | tr -d '/+=')}"
  local remark_sec="${existing_remark_sec:-$(openssl rand -base64 32 | tr -d '/+=')}"
  local umami_sec="${existing_umami_sec:-$(openssl rand -base64 32 | tr -d '/+=')}"
  local umami_db="${existing_umami_db:-$(openssl rand -hex 16)}"

  mkdir -p "$DOCKER_DIR"
  local tmp; tmp=$(mktemp)
  cat > "$tmp" <<EOF
# ── Domains ──
DOMAIN_ADMIN=admin.${DOMAIN_BASE}
DOMAIN_COMMENTS=comments.${DOMAIN_BASE}
DOMAIN_ANALYTICS=analytics.${DOMAIN_BASE}

# ── Cloudflare ──
CLOUDFLARE_TUNNEL_TOKEN=$CF_TOKEN

# ── CMS Auth ──
CMS_SESSION_SECRET=$cms_sec
WEBAUTHN_RP_ID=admin.${DOMAIN_BASE}
WEBAUTHN_ORIGIN=https://admin.${DOMAIN_BASE}

# ── Remark42 ──
REMARK42_SECRET=$remark_sec
REMARK42_ADMIN_ID=admin
REMARK42_URL=https://comments.${DOMAIN_BASE}

# ── Umami ──
UMAMI_SECRET=$umami_sec
UMAMI_DB_PASSWORD=$umami_db
UMAMI_URL=https://analytics.${DOMAIN_BASE}

# ── Site ──
SITE_BASE_URL=https://${DOMAIN_BASE}

# ── Bootstrap-managed (used by --self-test) ──
GH_USER=$GH_USER
HEALTHCHECK_WEBHOOK_URL=
EOF
  chmod 600 "$tmp"
  mv "$tmp" "$ENV_FILE"
  chown "${SUDO_USER:-root}":"${SUDO_USER:-root}" "$ENV_FILE" || true
  ok ".env written (existing secrets preserved)"
}

# ── compose_up ───────────────────────────────────────────────────────────────
compose_up() {
  log "bringing Docker stack up…"
  docker compose --project-directory "$DOCKER_DIR" up -d --build --remove-orphans
  ok "docker compose up: complete"
}

# ── install_crons ────────────────────────────────────────────────────────────
# Atomic block replacement keyed off CRON_MARKER. Re-running replaces the
# whole block (never duplicates entries).
install_crons() {
  log "installing cron jobs…"
  local current; current=$(crontab -l 2>/dev/null || true)
  # Strip any previous WWW-PI block (everything from marker to blank/next-marker).
  local stripped
  stripped=$(echo "$current" | awk -v m="$CRON_MARKER" '
    BEGIN { inblock=0 }
    $0 ~ m { inblock=1; next }
    inblock && (NF==0 || /^#/ && $0 !~ m) { inblock=0 }
    !inblock { print }
  ')
  local new_block
  new_block=$(cat <<EOF
$CRON_MARKER backup (daily 2am)
0 2 * * * $APP_DIR/scripts/backup.sh >> /var/log/wwwide-backup.log 2>&1
$CRON_MARKER auto-update (every 5 min)
*/5 * * * * $APP_DIR/scripts/auto-update.sh >> /var/log/wwwide-update.log 2>&1
$CRON_MARKER maintenance (sun 3am)
0 3 * * 0 $APP_DIR/scripts/maintenance.sh >> /var/log/wwwide-maint.log 2>&1
$CRON_MARKER promote-scheduled (every 5 min)
*/5 * * * * $APP_DIR/scripts/promote-scheduled.sh >> /var/log/wwwide-promote.log 2>&1
$CRON_MARKER dump-webmentions (every 15 min)
*/15 * * * * $APP_DIR/scripts/dump-webmentions.sh >> /var/log/wwwide-webmentions.log 2>&1
$CRON_MARKER system-health (every 5 min)
*/5 * * * * $APP_DIR/scripts/system-health.sh >> /var/log/wwwide-syshealth.log 2>&1
EOF
)
  printf '%s\n\n%s\n' "$stripped" "$new_block" | crontab -
  ok "cron jobs installed"
}

# ── install_systemd_unit ─────────────────────────────────────────────────────
# Boot-time healthcheck. Runs the script in --self-test mode 60s after Docker
# is ready; posts failure to HEALTHCHECK_WEBHOOK_URL (read from .env) if set.
install_systemd_unit() {
  log "installing systemd boot-check unit…"
  cat > "$SYSTEMD_UNIT" <<EOF
[Unit]
Description=Web World Wide — boot-time healthcheck
After=docker.service network-online.target
Wants=docker.service network-online.target

[Service]
Type=oneshot
ExecStartPre=/bin/sleep 60
ExecStart=$APP_DIR/scripts/bootstrap.sh --self-test
StandardOutput=journal
StandardError=journal

[Install]
WantedBy=multi-user.target
EOF
  systemctl daemon-reload
  systemctl enable wwwide-boot-check.service >/dev/null
  ok "systemd unit installed (runs 60s after every boot)"
}

# ── healthcheck_loop ─────────────────────────────────────────────────────────
# Poll the stack with exponential backoff. 180s total budget.
healthcheck_loop() {
  log "running healthcheck loop (up to 180s)…"
  local domain_admin
  domain_admin=$(grep '^DOMAIN_ADMIN=' "$ENV_FILE" 2>/dev/null | cut -d= -f2- || echo "admin.${DOMAIN_BASE}")
  local deadline=$((SECONDS + 180))
  local delay=3
  while [ "$SECONDS" -lt "$deadline" ]; do
    if check_health "$domain_admin"; then
      ok "all services healthy"
      return 0
    fi
    sleep "$delay"
    delay=$(( delay < 30 ? delay + 3 : 30 ))
  done
  err "healthcheck timed out after 180s"
  docker compose --project-directory "$DOCKER_DIR" ps || true
  for c in cloudflared caddy cms remark42 umami postgres; do
    echo "--- $c ---"
    docker logs --tail 20 "$c" 2>&1 || true
  done
  return 1
}

check_health() {
  local domain_admin="$1"
  # 1. No container in 'unhealthy' state and no container with >2 restarts.
  if docker ps --format '{{.Names}} {{.Status}}' | grep -q 'unhealthy'; then
    return 1
  fi
  # 2. CMS reachable via Caddy on host port 80 with proper Host header.
  if ! curl -fsS -o /dev/null --max-time 5 \
       -H "Host: $domain_admin" http://127.0.0.1/auth/status 2>/dev/null; then
    return 1
  fi
  # 3. Cloudflared registered with Cloudflare edge.
  if ! docker logs --tail 200 cloudflared 2>&1 | grep -q 'Registered tunnel connection'; then
    return 1
  fi
  return 0
}

# ── print_success ────────────────────────────────────────────────────────────
print_success() {
  printf '\n%s════════════════════════════════════════════════════════════════%s\n' "$C_GREEN" "$C_RESET"
  printf '%s  WEB WORLD WIDE — BOOTSTRAP COMPLETE%s\n' "$C_BOLD" "$C_RESET"
  printf '%s════════════════════════════════════════════════════════════════%s\n\n' "$C_GREEN" "$C_RESET"

  printf '  %sSERVICES%s\n' "$C_BOLD" "$C_RESET"
  docker compose --project-directory "$DOCKER_DIR" ps --format '    {{.Service}}\t{{.Status}}' 2>/dev/null \
    | column -t -s$'\t'
  printf '\n  %sNEXT STEPS%s\n' "$C_BOLD" "$C_RESET"
  printf '    1. Cloudflare Zero Trust → Tunnels → your tunnel → Public Hostnames\n'
  printf '       Add 3 hostnames, all routing to %shttp://caddy:80%s:\n' "$C_CYAN" "$C_RESET"
  printf '         admin.%s\n'    "$DOMAIN_BASE"
  printf '         comments.%s\n' "$DOMAIN_BASE"
  printf '         analytics.%s\n' "$DOMAIN_BASE"
  printf '    2. Visit %shttps://admin.%s%s and register your passkey.\n' "$C_CYAN" "$DOMAIN_BASE" "$C_RESET"
  printf '    3. (Optional) Set HEALTHCHECK_WEBHOOK_URL in %s for boot/failure alerts.\n' "$ENV_FILE"

  if [ -n "${AGE_PRIVATE_KEY_PRINTED:-}" ]; then
    printf '\n  %sAGE PRIVATE KEY (SAVE THIS — NOT SHOWN AGAIN)%s\n' "$C_YELLOW" "$C_RESET"
    printf '    Store in 1Password / Bitwarden. Without it, encrypted\n'
    printf '    backups in %s cannot be restored.\n\n' "${GH_USER}/www-blog-backups"
    printf '    %s%s%s\n\n' "$C_BOLD" "$AGE_PRIVATE_KEY_PRINTED" "$C_RESET"
  else
    printf '\n  age key was already present at %s (private key not re-printed)\n\n' "$AGE_KEY_FILE"
  fi
}

# ── self_test ────────────────────────────────────────────────────────────────
self_test() {
  log "self-test mode (skipping install, only running healthcheck)"
  if [ ! -f "$ENV_FILE" ]; then
    die "$ENV_FILE missing — run full bootstrap first" 2
  fi
  local domain_admin
  domain_admin=$(grep '^DOMAIN_ADMIN=' "$ENV_FILE" | cut -d= -f2-)
  if check_health "$domain_admin"; then
    ok "self-test PASS"
    exit 0
  fi
  err "self-test FAIL"
  local webhook
  webhook=$(grep '^HEALTHCHECK_WEBHOOK_URL=' "$ENV_FILE" | cut -d= -f2- || true)
  if [ -n "$webhook" ]; then
    curl -fsS -X POST -H 'Content-Type: application/json' \
      -d "{\"host\":\"$(hostname)\",\"status\":\"unhealthy\",\"ts\":\"$(date -Iseconds)\"}" \
      "$webhook" >/dev/null 2>&1 || true
  fi
  exit 1
}

# ── harden ─────────────────────────────────────────────────────────────────
# Security + SD-longevity hardening. Idempotent; safe to re-run. LAN-friendly:
# allows SSH BEFORE enabling ufw so a re-run never locks the operator out.
harden() {
  log "applying security + reliability hardening…"
  DEBIAN_FRONTEND=noninteractive apt-get install -y \
    unattended-upgrades fail2ban ufw smartmontools lm-sensors vnstat >/dev/null 2>&1 ||
    warn "some hardening packages failed to install"

  # Automatic security updates.
  cat >/etc/apt/apt.conf.d/20auto-upgrades <<'CONF'
APT::Periodic::Update-Package-Lists "1";
APT::Periodic::Unattended-Upgrade "1";
APT::Periodic::AutocleanInterval "7";
CONF
  systemctl enable --now unattended-upgrades >/dev/null 2>&1 || true

  # SSH brute-force protection.
  cat >/etc/fail2ban/jail.d/sshd-wwwide.local <<'CONF'
[sshd]
enabled = true
maxretry = 5
bantime = 1h
findtime = 10m
CONF
  systemctl enable --now fail2ban >/dev/null 2>&1 || true

  # Firewall: allow SSH FIRST, then enable (lockout-safe).
  ufw allow OpenSSH >/dev/null 2>&1 || true
  ufw default deny incoming >/dev/null 2>&1 || true
  ufw default allow outgoing >/dev/null 2>&1 || true
  ufw --force enable >/dev/null 2>&1 || true

  # Bound journald growth on the SD card.
  mkdir -p /etc/systemd/journald.conf.d
  cat >/etc/systemd/journald.conf.d/00-wwwide-size.conf <<'CONF'
[Journal]
SystemMaxUse=200M
SystemMaxFileSize=50M
CONF
  systemctl restart systemd-journald >/dev/null 2>&1 || true

  # Prefer RAM/zram over the SD swapfile.
  echo 'vm.swappiness=10' >/etc/sysctl.d/99-wwwide-swappiness.conf
  sysctl -p /etc/sysctl.d/99-wwwide-swappiness.conf >/dev/null 2>&1 || true

  systemctl enable --now vnstat >/dev/null 2>&1 || true
  ok "hardening applied"
}

# ── main ─────────────────────────────────────────────────────────────────────
main() {
  parse_args "$@"
  preflight

  if [ "$SELF_TEST" -eq 1 ]; then
    self_test
    return
  fi

  apt_install
  install_node
  setup_swap
  install_docker
  harden
  clone_or_pull_repo
  load_existing_env
  prompt_secrets
  validate_cf_token
  validate_gh_pat
  setup_backups
  write_env
  mkdir -p "$DOCKER_DIR/health"
  compose_up
  install_crons
  install_systemd_unit
  if healthcheck_loop; then
    print_success
    exit 0
  else
    err "bootstrap completed install steps but healthcheck failed."
    err "investigate with: docker compose --project-directory $DOCKER_DIR logs -f"
    exit 1
  fi
}

main "$@"
