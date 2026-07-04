#!/usr/bin/env bash
# PreToolUse hook (guard): blocks tool calls once the 5-hour usage window
# crosses USAGE_GUARD_THRESHOLD (default 95), exactly once per window, so
# Claude can checkpoint progress and schedule a native wakeup before the
# window resets. All "can't tell / don't know" paths fail open (exit 0) -
# this hook must never accidentally lock a session out.
set -euo pipefail

STATE_DIR="${CLAUDE_CONFIG_DIR:-${HOME:-$(cd && pwd)}/.claude}"
STATE_FILE="$STATE_DIR/usage-state.json"
LOCK_FILE="$STATE_DIR/usage-guard.lock"
THRESHOLD="${USAGE_GUARD_THRESHOLD:-95}"
STALE_SECONDS=1800

[ -f "$STATE_FILE" ] || exit 0

command -v jq >/dev/null 2>&1 || exit 0

if ! jq -e . "$STATE_FILE" >/dev/null 2>&1; then
  exit 0
fi

usage=$(jq -r '.usage // empty' "$STATE_FILE")
resets_at=$(jq -r '.resets_at // empty' "$STATE_FILE")
updated_at=$(jq -r '.updated_at // empty' "$STATE_FILE")

if [ -z "$usage" ] || [ -z "$updated_at" ] || [ -z "$resets_at" ]; then
  exit 0
fi

now_epoch=$(date -u +%s)

updated_epoch=""
if v=$(date -u -d "$updated_at" +%s 2>/dev/null); then
  updated_epoch="$v"
elif v=$(date -j -u -f "%Y-%m-%dT%H:%M:%SZ" "$updated_at" +%s 2>/dev/null); then
  updated_epoch="$v"
fi
[ -n "$updated_epoch" ] || exit 0

age=$(( now_epoch - updated_epoch ))
[ "$age" -le "$STALE_SECONDS" ] || exit 0

usage_int=$(printf '%.0f' "$usage")
[ "$usage_int" -ge "$THRESHOLD" ] || exit 0

if [ -f "$LOCK_FILE" ]; then
  lock_resets_at=$(cat "$LOCK_FILE" 2>/dev/null || true)
  if [ "$lock_resets_at" = "$resets_at" ]; then
    exit 0
  fi
fi

printf '%s' "$resets_at" >"$LOCK_FILE"

resets_epoch_int=$(printf '%.0f' "$resets_at" 2>/dev/null || echo "$resets_at")
wake_epoch=$(( resets_epoch_int + 180 ))

wake_human=""
if v=$(date -u -d "@${wake_epoch}" +"%Y-%m-%dT%H:%M:%SZ" 2>/dev/null); then
  wake_human="$v"
elif v=$(date -u -r "${wake_epoch}" +"%Y-%m-%dT%H:%M:%SZ" 2>/dev/null); then
  wake_human="$v"
else
  wake_human="(could not format; use epoch below)"
fi

cat >&2 <<EOF
Claude Code usage guard: the 5-hour usage window is at ${usage_int}% (threshold ${THRESHOLD}%).

Before doing anything else, you must:
1. Write a detailed PROGRESS.md file at the project root describing: what has been completed so far, what work remains, the exact next step to take, all relevant file paths, and the current git branch (if applicable).
2. Schedule a native one-time Claude Code scheduled task/reminder to wake this session up at ${wake_human} UTC (epoch ${wake_epoch}), which is resets_at + 3 minutes, so you can resume automatically when the usage window resets.
3. Do not start any new tasks, features, or tool calls beyond steps 1 and 2 above until that scheduled wakeup fires.
4. When woken up, read PROGRESS.md first and continue exactly where you left off, in the same order described there.

This is a one-time block for the current usage window; once you complete steps 1-2 above, further tool calls will not be blocked again until the next window.
EOF
exit 2
