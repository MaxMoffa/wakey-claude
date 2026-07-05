#!/usr/bin/env bash
# statusLine sensor: reads Claude Code's status JSON from stdin, prints a
# one-line summary, and — only when usage crosses the threshold — raises a
# one-shot flag file for usage-guard.sh to consume.
#
# Deliberately no `-u`: several fields (rate_limits, context_window) are
# legitimately absent (e.g. API-key logins), and treating an unset var as
# a hard error would crash the status line instead of degrading to "n/a".
set -eo pipefail

CONFIG_DIR="${CLAUDE_CONFIG_DIR:-${HOME:-$(cd && pwd)}/.claude}"
FLAG_FILE="$CONFIG_DIR/wakey-flag.json"
# Sole definition of the threshold on the bash side: usage-guard.sh trusts
# whatever flag this script already wrote and does not re-read this var.
THRESHOLD="${USAGE_GUARD_THRESHOLD:-95}"

if ! command -v jq >/dev/null 2>&1; then
  printf 'usage-guard: jq not found (install jq)\n'
  exit 0
fi

# epoch -> ISO8601 UTC, GNU (`date -d @epoch`) then BSD (`date -r epoch`) fallback.
epoch_to_iso() {
  local epoch="$1" iso
  if iso=$(date -u -d "@${epoch}" +"%Y-%m-%dT%H:%M:%SZ" 2>/dev/null); then
    printf '%s' "$iso"
    return 0
  elif iso=$(date -u -r "${epoch}" +"%Y-%m-%dT%H:%M:%SZ" 2>/dev/null); then
    printf '%s' "$iso"
    return 0
  fi
  return 1
}

# Contract: one write per window, last-write-wins, account-level shared data.
# wakey-flag.json is read by every concurrent Claude Code session on this
# account/window. If a flag already exists for this window's resets_at,
# leave it alone — usage-guard.sh may have already flipped handled:true, and
# an unconditional overwrite here would silently re-arm an alarm that
# already fired. Do not "fix" this into an unconditional overwrite.
write_flag_if_needed() {
  local resets_at_iso="$1" usage_int="$2" existing_resets_at=""
  if [ -f "$FLAG_FILE" ] && jq -e . "$FLAG_FILE" >/dev/null 2>&1; then
    existing_resets_at=$(jq -r '.resets_at // empty' "$FLAG_FILE" 2>/dev/null)
  fi
  [ "$existing_resets_at" = "$resets_at_iso" ] && return 0

  mkdir -p "$CONFIG_DIR"
  local tmp="$FLAG_FILE.tmp.$$" created_at
  created_at="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  if jq -n \
    --arg resets_at "$resets_at_iso" \
    --arg usage "$usage_int" \
    --arg created_at "$created_at" \
    '{resets_at: $resets_at, usage: ($usage|tonumber), handled: false, created_at: $created_at}' \
    >"$tmp" 2>/dev/null; then
    mv -f "$tmp" "$FLAG_FILE"
  else
    rm -f "$tmp"
  fi
}

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

  if [ "$pct_int" -ge "$THRESHOLD" ] && [ -n "$rl_resets_at" ]; then
    if resets_at_iso="$(epoch_to_iso "$rl_resets_at")"; then
      write_flag_if_needed "$resets_at_iso" "$pct_int"
    fi
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
