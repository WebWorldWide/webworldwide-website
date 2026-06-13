#!/usr/bin/env bash
#
# watchdog.sh — self-healing for the WWWide stack. Runs every few minutes
# from cron. Docker's `restart: unless-stopped` policy recovers a process
# that CRASHES, but it does NOT help when a container is "unhealthy"
# (healthcheck failing while the process lingers), when a service is
# unreachable end-to-end, or when the disk fills. This closes those gaps.
#
# Posture: conservative + rate-limited. Each container may be auto-restarted
# at most MAX_RESTARTS times within WINDOW seconds; past that we stop poking
# it and alert, so a genuinely broken service can't become a restart loop.
# Every action is logged and (if configured) pushed to HEALTHCHECK_WEBHOOK_URL.
#
# Safe to run by hand. Idempotent. No args.
set -uo pipefail

APP_DIR="${WWWIDE_APP_DIR:-/opt/web-world-wide}"
DOCKER_DIR="$APP_DIR/docker"
STATE_DIR="${WWWIDE_STATE_DIR:-/var/lib/wwwide-watchdog}"
ENV_FILE="$DOCKER_DIR/.env"

# Containers we keep alive. Order doesn't matter — each is checked
# independently so one failure never blocks the others.
SERVICES=(postgres umami remark42 cms caddy cloudflared)

MAX_RESTARTS=3      # per container within the window
WINDOW=3600         # seconds
DISK_EMERGENCY=95   # % used → emergency cleanup

mkdir -p "$STATE_DIR"
ts() { date '+%Y-%m-%dT%H:%M:%S%z'; }
log() { echo "$(ts) [watchdog] $*"; }

WEBHOOK="$(grep -m1 '^HEALTHCHECK_WEBHOOK_URL=' "$ENV_FILE" 2>/dev/null | cut -d= -f2- || true)"
alert() {
  log "ALERT: $*"
  [ -n "${WEBHOOK:-}" ] || return 0
  curl -fsS -m 10 -X POST -H 'Content-Type: application/json' \
    -d "{\"text\":\"[WWWide watchdog] $*\"}" "$WEBHOOK" >/dev/null 2>&1 || true
}

# Rate-limit: returns 0 (ok to restart) if under the cap, 1 if we should hold off.
allow_restart() {
  local svc="$1" now stamp_file count cutoff
  stamp_file="$STATE_DIR/$svc.restarts"
  now=$(date +%s)
  cutoff=$((now - WINDOW))
  # Keep only timestamps within the window.
  if [ -f "$stamp_file" ]; then
    awk -v c="$cutoff" '$1 >= c' "$stamp_file" > "$stamp_file.tmp" && mv "$stamp_file.tmp" "$stamp_file"
  fi
  count=$([ -f "$stamp_file" ] && wc -l < "$stamp_file" || echo 0)
  if [ "$count" -ge "$MAX_RESTARTS" ]; then
    return 1
  fi
  echo "$now" >> "$stamp_file"
  return 0
}

restart_service() {
  local svc="$1" reason="$2"
  if allow_restart "$svc"; then
    log "restarting '$svc' ($reason)"
    ( cd "$DOCKER_DIR" && docker compose up -d "$svc" >/dev/null 2>&1 ) \
      || docker start "$svc" >/dev/null 2>&1 || true
    alert "restarted '$svc' — $reason"
  else
    alert "'$svc' is $reason but hit the restart cap ($MAX_RESTARTS/${WINDOW}s) — NOT restarting; needs a human"
  fi
}

# ── 1. Per-container state ──────────────────────────────────────────
for svc in "${SERVICES[@]}"; do
  # `docker inspect` is authoritative; skip a service that isn't defined.
  state=$(docker inspect -f '{{.State.Status}}' "$svc" 2>/dev/null || echo "absent")
  case "$state" in
    running)
      health=$(docker inspect -f '{{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}' "$svc" 2>/dev/null || echo none)
      if [ "$health" = "unhealthy" ]; then
        restart_service "$svc" "unhealthy"
      fi
      ;;
    absent)
      log "'$svc' not found (not part of this deployment?) — skipping"
      ;;
    *)
      # exited / dead / created / paused
      restart_service "$svc" "state=$state"
      ;;
  esac
done

# ── 2. End-to-end reachability (local, so no Cloudflare dependency) ──
# Hit the CMS through Caddy on an UNAUTHENTICATED endpoint. /auth/status is
# the SPA's own boot ping — it always returns 200 from the live Express app
# (not just a static file), so a 200 means cms + caddy are both truly
# serving. (/api/* is behind the session gate and would 401 here.)
if ! curl -fsS -m 8 -H 'Host: admin.webworldwide.online' http://127.0.0.1/auth/status >/dev/null 2>&1; then
  # Re-check raw cms in case it's only Caddy that's wedged.
  if docker inspect -f '{{.State.Status}}' cms 2>/dev/null | grep -q running; then
    restart_service caddy "admin endpoint unreachable but cms is up"
  else
    restart_service cms "admin endpoint unreachable"
  fi
fi

# ── 3. Disk emergency valve ─────────────────────────────────────────
disk=$(df --output=pcent / | tail -1 | tr -dc '0-9')
if [ "${disk:-0}" -ge "$DISK_EMERGENCY" ]; then
  alert "disk at ${disk}% — running emergency cleanup"
  docker system prune -f >/dev/null 2>&1 || true
  journalctl --vacuum-size=100M >/dev/null 2>&1 || true
fi

log "watchdog pass complete (disk ${disk:-?}%)"
