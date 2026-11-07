#!/usr/bin/env bash
#
# Shared alerting for host scripts.
#
#   wwwide_notify <key> <throttle-seconds> <message…>
#
# Always logs to stderr. When HEALTHCHECK_WEBHOOK_URL is set in docker/.env it
# also POSTs the message: ntfy.sh-style URLs get a plain-text body, everything
# else gets JSON carrying both `text` (Slack/Mattermost/Google Chat) and
# `content` (Discord). A per-key stamp file throttles repeats so a condition
# that persists for days alerts once per window instead of every cron tick.
#
#   wwwide_notify_clear <key>   — forget the throttle stamp (condition fixed)

_wwwide_notify_state_dir() {
  local d="${WWWIDE_STATE_DIR:-${HOME:-/tmp}/.local/state/wwwide-watchdog}"
  mkdir -p "$d/notify" 2>/dev/null || true
  printf '%s/notify' "$d"
}

_wwwide_json_escape() {
  # Escape backslash, double quote, and control characters for a JSON string.
  printf '%s' "$1" | sed -e 's/\\/\\\\/g' -e 's/"/\\"/g' | tr '\n\r\t' '   '
}

wwwide_notify() {
  local key="$1" throttle="$2"
  shift 2
  local msg="$*" host stamp now last webhook env_file
  host="$(hostname 2>/dev/null || echo host)"
  echo "$(date -Is) [alert:$key] $msg" >&2

  stamp="$(_wwwide_notify_state_dir)/$(printf '%s' "$key" | tr -c 'A-Za-z0-9_.-' '_')"
  now="$(date +%s)"
  if [ "$throttle" -gt 0 ] && [ -f "$stamp" ]; then
    last="$(cat "$stamp" 2>/dev/null || echo 0)"
    if [ $((now - last)) -lt "$throttle" ]; then
      return 0
    fi
  fi
  echo "$now" >"$stamp" 2>/dev/null || true

  env_file="${WWWIDE_APP_DIR:-/opt/web-world-wide}/docker/.env"
  webhook="${HEALTHCHECK_WEBHOOK_URL:-$(grep -m1 '^HEALTHCHECK_WEBHOOK_URL=' "$env_file" 2>/dev/null | cut -d= -f2- || true)}"
  if [ -z "$webhook" ]; then
    # No webhook configured: raise it through GitHub instead (a failed
    # "Server alert" run emails the repo owner). Only the key leaves the box.
    if command -v gh >/dev/null 2>&1; then
      gh workflow run server-alert.yml -R WebWorldWide/webworldwide-website \
        -f key="$(printf '%s' "$key" | tr -c 'A-Za-z0-9_.-' '_')" >/dev/null 2>&1 || true
    fi
    return 0
  fi

  local text="[WWWide@$host] $msg"
  if printf '%s' "$webhook" | grep -q 'ntfy'; then
    curl -fsS -m 10 -H "Title: WWWide alert ($key)" -d "$text" "$webhook" >/dev/null 2>&1 || true
  else
    local esc
    esc="$(_wwwide_json_escape "$text")"
    curl -fsS -m 10 -X POST -H 'Content-Type: application/json' \
      -d "{\"text\":\"$esc\",\"content\":\"$esc\"}" "$webhook" >/dev/null 2>&1 || true
  fi
}

wwwide_notify_clear() {
  rm -f "$(_wwwide_notify_state_dir)/$(printf '%s' "$1" | tr -c 'A-Za-z0-9_.-' '_')" 2>/dev/null || true
}

# Git invocation for host scripts that hardens against a tampered .git/config
# (the CMS container shares .git): no hooks, no fsmonitor, no custom ssh
# command, no ext:: transport.
wwwide_git() {
  git -c core.hooksPath=/dev/null -c core.fsmonitor=false -c core.sshCommand=ssh \
    -c protocol.ext.allow=never "$@"
}
