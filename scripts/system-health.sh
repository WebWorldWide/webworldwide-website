#!/usr/bin/env bash
#
# system-health.sh — collect Raspberry Pi SD-card + system health into a JSON
# marker that the CMS dashboard reads, and alert (once per state change) via
# HEALTHCHECK_WEBHOOK_URL.
#
# SD cards expose no SMART/wear data, so "health" is inferred from: read-only
# remount, recent kernel filesystem/I-O errors, disk + inode usage, and write
# volume (sectors written from /sys/block/<dev>/stat). Throttle/undervoltage
# comes from vcgencmd (host-only — the cms container has no vcgencmd, which is
# exactly why this runs on the host and the CMS just reads the marker).
#
# Runs from cron every 5 min (see bootstrap install_crons). Idempotent; no args.
# Writes $OUT_DIR/system-health.json, where OUT_DIR is the dir bind-mounted into
# the cms container at /app/health.
set -euo pipefail

APP_DIR="${APP_DIR:-/opt/web-world-wide}"
OUT_DIR="${WWWIDE_HEALTH_DIR:-$APP_DIR/docker/health}"
ENV_FILE="$APP_DIR/docker/.env"
STATE_FILE="$OUT_DIR/.write-state"
MARKER="$OUT_DIR/system-health.json"

mkdir -p "$OUT_DIR"

now_epoch=$(date +%s)
now_iso=$(date -Iseconds)

# Previous reading (for write-rate delta + alert de-duplication).
prev_epoch=""
prev_sectors=""
prev_status="ok"
if [ -f "$STATE_FILE" ]; then
  read -r prev_epoch prev_sectors prev_status <"$STATE_FILE" 2>/dev/null || true
  : "${prev_status:=ok}"
fi

# ── Throttle / undervoltage ─────────────────────────────────────────────────
throttle_raw=""
uv_now=0
uv_ever=0
thr_now=0
thr_ever=0
power_status="unknown"
if command -v vcgencmd >/dev/null 2>&1; then
  throttle_raw=$(vcgencmd get_throttled 2>/dev/null | sed -E 's/.*=//' || true)
  if [ -n "$throttle_raw" ]; then
    tval=$((throttle_raw)) # 0x… hex parses in bash arithmetic
    uv_now=$(((tval >> 0) & 1))
    thr_now=$(((tval >> 2) & 1))
    uv_ever=$(((tval >> 16) & 1))
    thr_ever=$(((tval >> 18) & 1))
    if [ "$uv_now" -eq 1 ] || [ "$thr_now" -eq 1 ]; then
      power_status="critical"
    elif [ "$uv_ever" -eq 1 ] || [ "$thr_ever" -eq 1 ]; then
      power_status="warn"
    else
      power_status="ok"
    fi
  fi
fi

# ── Root filesystem: device, read-only state ────────────────────────────────
root_src=$(findmnt -no SOURCE / 2>/dev/null || echo "")
root_opts=$(findmnt -no OPTIONS / 2>/dev/null || echo "")
mount_ro=false
case ",$root_opts," in
  *",ro,"*) mount_ro=true ;;
esac

# Base block device for the partition (mmcblk0p2 → mmcblk0, sda2 → sda).
dev_base=""
if [ -n "$root_src" ]; then
  b=$(basename "$root_src")
  if [[ "$b" =~ ^(mmcblk[0-9]+)p[0-9]+$ ]]; then
    dev_base="${BASH_REMATCH[1]}"
  elif [[ "$b" =~ ^(nvme[0-9]+n[0-9]+)p[0-9]+$ ]]; then
    dev_base="${BASH_REMATCH[1]}"
  elif [[ "$b" =~ ^([a-z]+)[0-9]+$ ]]; then
    dev_base="${BASH_REMATCH[1]}"
  else
    dev_base="$b"
  fi
fi

# ── Disk + inode usage ──────────────────────────────────────────────────────
disk_pct=$(df -P / 2>/dev/null | awk 'NR==2 {gsub("%","",$5); print $5+0}')
inode_pct=$(df -Pi / 2>/dev/null | awk 'NR==2 {gsub("%","",$5); print $5+0}')
[ -n "$disk_pct" ] || disk_pct=0
[ -n "$inode_pct" ] || inode_pct=0

# ── Recent kernel filesystem / I-O errors (early SD-failure signal) ─────────
fs_errors=0
if command -v journalctl >/dev/null 2>&1; then
  fs_errors=$(journalctl -k --since "-24 hours" --no-pager 2>/dev/null |
    grep -icE 'EXT4-fs error|I/O error|mmc[0-9].*error|remounting filesystem read-only|critical medium error' || true)
fi
[ -n "$fs_errors" ] || fs_errors=0

# ── Write volume → GB/day (SD endurance proxy) ──────────────────────────────
write_gb_day="null"
sectors=""
if [ -n "$dev_base" ] && [ -r "/sys/block/$dev_base/stat" ]; then
  sectors=$(awk '{print $7}' "/sys/block/$dev_base/stat" 2>/dev/null || echo "")
  if [ -n "$sectors" ] && [ -n "$prev_sectors" ] && [ -n "$prev_epoch" ] &&
    [ "$now_epoch" -gt "$prev_epoch" ] && [ "$sectors" -ge "$prev_sectors" ]; then
    write_gb_day=$(awk -v ds="$((sectors - prev_sectors))" -v dt="$((now_epoch - prev_epoch))" \
      'BEGIN { printf "%.2f", (ds * 512.0 / dt) * 86400 / 1073741824 }')
  fi
fi

# ── Swap (zram-first is healthy; SD swapfile churn is not) ──────────────────
swap_total=$(awk '/^SwapTotal:/ {print $2}' /proc/meminfo 2>/dev/null || echo 0)
swap_free=$(awk '/^SwapFree:/ {print $2}' /proc/meminfo 2>/dev/null || echo 0)
swap_pct=0
if [ "${swap_total:-0}" -gt 0 ]; then
  swap_pct=$(awk -v t="$swap_total" -v f="$swap_free" 'BEGIN { printf "%.0f", (t - f) * 100.0 / t }')
fi
swap_kind="swapfile"
if grep -q '^/dev/zram' /proc/swaps 2>/dev/null; then
  swap_kind="zram"
fi

# ── Derive statuses ─────────────────────────────────────────────────────────
storage_status="ok"
if [ "$mount_ro" = true ] || [ "$fs_errors" -gt 0 ] || [ "$disk_pct" -ge 95 ] || [ "$inode_pct" -ge 95 ]; then
  storage_status="critical"
elif [ "$disk_pct" -ge 85 ] || [ "$inode_pct" -ge 85 ]; then
  storage_status="warn"
fi

overall="ok"
for s in "$storage_status" "$power_status"; do
  case "$s" in
    critical) overall="critical" ;;
    warn) [ "$overall" = "ok" ] && overall="warn" ;;
  esac
done

# ── Write marker (atomic) ───────────────────────────────────────────────────
jq -n \
  --arg collected "$now_iso" \
  --arg overall "$overall" \
  --arg dev "$dev_base" \
  --argjson mount_ro "$mount_ro" \
  --argjson fs_errors "$fs_errors" \
  --argjson disk_pct "$disk_pct" \
  --argjson inode_pct "$inode_pct" \
  --argjson write_gb_day "$write_gb_day" \
  --arg storage_status "$storage_status" \
  --arg throttle_raw "$throttle_raw" \
  --argjson uv_now "$uv_now" \
  --argjson uv_ever "$uv_ever" \
  --argjson thr_now "$thr_now" \
  --argjson thr_ever "$thr_ever" \
  --arg power_status "$power_status" \
  --argjson swap_pct "$swap_pct" \
  --arg swap_kind "$swap_kind" \
  '{
    collected_iso: $collected,
    status: $overall,
    storage: {
      device: $dev,
      mount_ro: $mount_ro,
      fs_errors: $fs_errors,
      disk_used_pct: $disk_pct,
      inode_used_pct: $inode_pct,
      write_gb_per_day: $write_gb_day,
      status: $storage_status
    },
    power: {
      throttled_raw: $throttle_raw,
      undervoltage_now: ($uv_now == 1),
      undervoltage_ever: ($uv_ever == 1),
      throttled_now: ($thr_now == 1),
      throttled_ever: ($thr_ever == 1),
      status: $power_status
    },
    swap: { usagePercent: $swap_pct, kind: $swap_kind }
  }' >"$MARKER.tmp" && mv "$MARKER.tmp" "$MARKER"

# Persist reading for the next run (epoch, sectors, status).
printf '%s %s %s\n' "$now_epoch" "${sectors:-0}" "$overall" >"$STATE_FILE"

# ── Alert on state change only (avoid every-5-min spam) ─────────────────────
if [ "$overall" != "ok" ] && [ "$prev_status" != "$overall" ]; then
  webhook=""
  if [ -f "$ENV_FILE" ]; then
    webhook=$(grep '^HEALTHCHECK_WEBHOOK_URL=' "$ENV_FILE" | cut -d= -f2- || true)
  fi
  if [ -n "$webhook" ]; then
    curl -fsS -X POST -H 'Content-Type: application/json' \
      -d "{\"host\":\"$(hostname)\",\"status\":\"$overall\",\"component\":\"system-health\",\"storage\":\"$storage_status\",\"power\":\"$power_status\",\"ts\":\"$now_iso\"}" \
      "$webhook" >/dev/null 2>&1 || true
  fi
fi
