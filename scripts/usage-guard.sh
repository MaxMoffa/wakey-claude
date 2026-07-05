#!/usr/bin/env bash
# PreToolUse hook (guard): consumes the one-shot flag usage-statusline.sh
# raises when the 5-hour usage window crosses the threshold. Blocks exactly
# once per window so Claude can checkpoint progress and schedule a native
# wakeup before the window resets. All "can't tell / don't know" paths fail
# open (exit 0) - this hook must never accidentally lock a session out.
set -euo pipefail

CONFIG_DIR="${CLAUDE_CONFIG_DIR:-${HOME:-$(cd && pwd)}/.claude}"
FLAG_FILE="$CONFIG_DIR/wakey-flag.json"

[ -f "$FLAG_FILE" ] || exit 0

command -v jq >/dev/null 2>&1 || exit 0

if ! jq -e . "$FLAG_FILE" >/dev/null 2>&1; then
  rm -f "$FLAG_FILE"
  exit 0
fi

resets_at=$(jq -r '.resets_at // empty' "$FLAG_FILE")
usage=$(jq -r '.usage // empty' "$FLAG_FILE")
handled=$(jq -r '.handled // false' "$FLAG_FILE")

if [ -z "$resets_at" ]; then
  rm -f "$FLAG_FILE"
  exit 0
fi

# ISO8601 UTC -> epoch, GNU (`date -d`) then BSD (`date -j -f`) fallback.
iso_to_epoch() {
  local iso="$1" epoch
  if epoch=$(date -u -d "$iso" +%s 2>/dev/null); then
    printf '%s' "$epoch"
    return 0
  elif epoch=$(date -j -u -f "%Y-%m-%dT%H:%M:%SZ" "$iso" +%s 2>/dev/null); then
    printf '%s' "$epoch"
    return 0
  fi
  return 1
}

if ! resets_epoch="$(iso_to_epoch "$resets_at")"; then
  rm -f "$FLAG_FILE"
  exit 0
fi

now_epoch=$(date -u +%s)
if [ "$resets_epoch" -le "$now_epoch" ]; then
  rm -f "$FLAG_FILE"
  exit 0
fi

[ "$handled" = "true" ] && exit 0

tmp="$FLAG_FILE.tmp.$$"
if jq '.handled = true' "$FLAG_FILE" >"$tmp" 2>/dev/null; then
  mv -f "$tmp" "$FLAG_FILE"
else
  rm -f "$tmp"
fi

usage_int=$(printf '%.0f' "${usage:-0}" 2>/dev/null || echo "${usage:-0}")
wake_epoch=$(( resets_epoch + 180 ))

wake_human=""
if v=$(date -u -d "@${wake_epoch}" +"%Y-%m-%dT%H:%M:%SZ" 2>/dev/null); then
  wake_human="$v"
elif v=$(date -u -r "${wake_epoch}" +"%Y-%m-%dT%H:%M:%SZ" 2>/dev/null); then
  wake_human="$v"
else
  wake_human="(could not format; use epoch below)"
fi

cat >&2 <<EOF
Claude Code usage guard: the 5-hour usage window is at ${usage_int}%.

Before doing anything else, you must:
1. Write a detailed PROGRESS.md file at the project root describing: what has been completed so far, what work remains, the exact next step to take, all relevant file paths, and the current git branch (if applicable).
2. Schedule a native one-time Claude Code scheduled task/reminder to wake this session up at ${wake_human} UTC (epoch ${wake_epoch}), which is resets_at + 3 minutes, so you can resume automatically when the usage window resets.
3. Do not start any new tasks, features, or tool calls beyond steps 1 and 2 above until that scheduled wakeup fires.
4. When woken up, read PROGRESS.md first and continue exactly where you left off, in the same order described there.

This is a one-time block for the current usage window; once you complete steps 1-2 above, further tool calls will not be blocked again until the next window.
EOF
exit 2
