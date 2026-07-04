#!/usr/bin/env bash
# statusLine sensor: reads Claude Code's status JSON from stdin, prints a
# one-line summary, and records usage state to disk for usage-guard.sh.
#
# Deliberately no `-u`: several fields (rate_limits, context_window) are
# legitimately absent (e.g. API-key logins), and treating an unset var as
# a hard error would crash the status line instead of degrading to "n/a".
set -eo pipefail

STATE_DIR="${CLAUDE_CONFIG_DIR:-${HOME:-$(cd && pwd)}/.claude}"
STATE_FILE="$STATE_DIR/usage-state.json"

if ! command -v jq >/dev/null 2>&1; then
  printf 'usage-guard: jq not found (install jq)\n'
  exit 0
fi

input="$(cat)"

if ! jq -e . >/dev/null 2>&1 <<<"$input"; then
  printf 'usage-guard: n/a (invalid status JSON)\n'
  exit 0
fi

model_name=$(jq -r '.model.display_name // .model.id // "Claude"' <<<"$input")
rl_pct=$(jq -r '.rate_limits.five_hour.used_percentage // empty' <<<"$input")
rl_resets_at=$(jq -r '.rate_limits.five_hour.resets_at // empty' <<<"$input")
ctx_pct=$(jq -r '.context_window.used_percentage // empty' <<<"$input")

GREEN='\033[32m'
YELLOW='\033[33m'
RED='\033[31m'
RESET='\033[0m'

if [ -z "$rl_pct" ]; then
  usage_seg="5h: n/a"
else
  pct_int=$(printf '%.0f' "$rl_pct")
  if [ "$pct_int" -ge 90 ]; then
    color="$RED"
  elif [ "$pct_int" -ge 70 ]; then
    color="$YELLOW"
  else
    color="$GREEN"
  fi
  usage_seg=$(printf "5h: ${color}%s%%${RESET}" "$pct_int")

  mkdir -p "$STATE_DIR"
  TMP_FILE="$STATE_FILE.tmp.$$"
  updated_at="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  if jq -n \
    --arg usage "$pct_int" \
    --arg resets_at "$rl_resets_at" \
    --arg updated_at "$updated_at" \
    '{usage: ($usage|tonumber), resets_at: $resets_at, updated_at: $updated_at}' \
    >"$TMP_FILE" 2>/dev/null; then
    mv -f "$TMP_FILE" "$STATE_FILE"
  else
    rm -f "$TMP_FILE"
  fi
fi

if [ -n "$ctx_pct" ]; then
  ctx_int=$(printf '%.0f' "$ctx_pct")
  ctx_seg="ctx: ${ctx_int}%"
else
  ctx_seg="ctx: n/a"
fi

if [ -n "$rl_resets_at" ]; then
  if reset_hhmm=$(date -d "@${rl_resets_at}" +"%H:%M" 2>/dev/null); then
    :
  elif reset_hhmm=$(date -r "${rl_resets_at}" +"%H:%M" 2>/dev/null); then
    :
  else
    reset_hhmm="?"
  fi
  reset_seg="resets ${reset_hhmm}"
else
  reset_seg="resets n/a"
fi

printf '%b\n' "${model_name} │ ${usage_seg} │ ${ctx_seg} │ ${reset_seg}"
