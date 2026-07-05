#!/usr/bin/env bash
# Plain-bash test suite for scripts/usage-guard.sh and scripts/usage-statusline.sh.
# No bats dependency: each test is a function that sets up an isolated fake
# HOME, runs the script, and asserts exit code / output / files.
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
GUARD="$REPO_ROOT/scripts/usage-guard.sh"
STATUSLINE="$REPO_ROOT/scripts/usage-statusline.sh"
FIXTURES="$SCRIPT_DIR/fixtures"

PASS=0
FAIL=0

pass() { PASS=$((PASS + 1)); printf '  ok - %s\n' "$1"; }
fail() { FAIL=$((FAIL + 1)); printf '  NOT OK - %s\n' "$1"; }

assert_eq() {
  local desc="$1" expected="$2" actual="$3"
  if [ "$expected" = "$actual" ]; then
    pass "$desc"
  else
    fail "$desc (expected [$expected], got [$actual])"
  fi
}

assert_contains() {
  local desc="$1" haystack="$2" needle="$3"
  if [[ "$haystack" == *"$needle"* ]]; then
    pass "$desc"
  else
    fail "$desc (did not find [$needle])"
  fi
}

new_fake_home() {
  local dir
  dir="$(mktemp -d)"
  mkdir -p "$dir/.claude"
  printf '%s' "$dir"
}

write_flag() {
  local home="$1" resets_at="$2" usage="$3" handled="$4" created_at="${5:-$(now_iso)}"
  jq -n \
    --arg resets_at "$resets_at" \
    --arg usage "$usage" \
    --argjson handled "$handled" \
    --arg created_at "$created_at" \
    '{resets_at: $resets_at, usage: ($usage|tonumber), handled: $handled, created_at: $created_at}' \
    >"$home/.claude/wakey-flag.json"
}

flag_file() { printf '%s' "$1/.claude/wakey-flag.json"; }

run_guard() {
  local home="$1"
  shift
  ( export HOME="$home"; env "$@" bash "$GUARD" )
}

now_iso() { date -u +%Y-%m-%dT%H:%M:%SZ; }
epoch_plus() { date -u -d "+$1" +%s; }
iso_plus() { date -u -d "+$1" +%Y-%m-%dT%H:%M:%SZ; }
iso_minus() { date -u -d "-$1" +%Y-%m-%dT%H:%M:%SZ; }

echo "=== usage-guard.sh ==="

# 1. no flag file -> exit 0, no output
home="$(new_fake_home)"
out=$(run_guard "$home" 2>&1); code=$?
assert_eq "no flag file: exit 0" "0" "$code"
assert_eq "no flag file: no stderr" "" "$out"

# 2. corrupt json flag -> exit 0, flag deleted
home="$(new_fake_home)"
cp "$FIXTURES/flag-malformed.json" "$(flag_file "$home")"
run_guard "$home" >/dev/null 2>&1; code=$?
assert_eq "corrupt json: exit 0" "0" "$code"
if [ -f "$(flag_file "$home")" ]; then
  fail "corrupt json: flag file deleted"
else
  pass "corrupt json: flag file deleted"
fi

# 3. unparseable resets_at -> exit 0, flag deleted
home="$(new_fake_home)"
write_flag "$home" "not-a-date" 96 false
run_guard "$home" >/dev/null 2>&1; code=$?
assert_eq "unparseable resets_at: exit 0" "0" "$code"
if [ -f "$(flag_file "$home")" ]; then
  fail "unparseable resets_at: flag file deleted"
else
  pass "unparseable resets_at: flag file deleted"
fi

# 4. expired flag (resets_at in the past) -> exit 0, flag deleted
home="$(new_fake_home)"
write_flag "$home" "$(iso_minus '10 minutes')" 97 false
run_guard "$home" >/dev/null 2>&1; code=$?
assert_eq "expired flag: exit 0" "0" "$code"
if [ -f "$(flag_file "$home")" ]; then
  fail "expired flag: flag file deleted"
else
  pass "expired flag: flag file deleted"
fi

# 5. unhandled flag, future resets_at -> blocks once, marks handled
home="$(new_fake_home)"
resets="$(iso_plus '2 hours')"
write_flag "$home" "$resets" 97 false "$(now_iso)"
out=$(run_guard "$home" 2>&1); code=$?
assert_eq "unhandled flag: exit 2" "2" "$code"
assert_contains "unhandled flag: mentions PROGRESS.md" "$out" "PROGRESS.md"
assert_contains "unhandled flag: mentions scheduled wakeup" "$out" "wake"
assert_contains "unhandled flag: mentions no new tasks" "$out" "Do not start any new tasks"
assert_contains "unhandled flag: mentions resume on wakeup" "$out" "continue exactly where you left off"
handled_after=$(jq -r '.handled' "$(flag_file "$home")")
resets_after=$(jq -r '.resets_at' "$(flag_file "$home")")
usage_after=$(jq -r '.usage' "$(flag_file "$home")")
assert_eq "unhandled flag: handled flipped to true" "true" "$handled_after"
assert_eq "unhandled flag: resets_at preserved" "$resets" "$resets_after"
assert_eq "unhandled flag: usage preserved" "97" "$usage_after"

# 6. already-handled flag, future resets_at -> passthrough, unchanged
home="$(new_fake_home)"
resets="$(iso_plus '2 hours')"
write_flag "$home" "$resets" 97 true "$(now_iso)"
before="$(cat "$(flag_file "$home")")"
run_guard "$home" >/dev/null 2>&1; code=$?
after="$(cat "$(flag_file "$home")")"
assert_eq "already handled: exit 0" "0" "$code"
assert_eq "already handled: content unchanged" "$before" "$after"

# 7. rollover: expired+handled flag is cleaned up, then a fresh flag blocks again
home="$(new_fake_home)"
write_flag "$home" "$(iso_minus '10 minutes')" 97 true "$(now_iso)"
run_guard "$home" >/dev/null 2>&1
if [ -f "$(flag_file "$home")" ]; then
  fail "rollover: expired handled flag deleted"
else
  pass "rollover: expired handled flag deleted"
fi
write_flag "$home" "$(iso_plus '2 hours')" 97 false "$(now_iso)"
run_guard "$home" >/dev/null 2>&1; code=$?
assert_eq "rollover: new window blocks again" "2" "$code"

# 8. never exits 1 across all scenarios above
home="$(new_fake_home)"
for scenario in none corrupt bad-date expired unhandled handled; do
  home="$(new_fake_home)"
  case "$scenario" in
    none) ;;
    corrupt) cp "$FIXTURES/flag-malformed.json" "$(flag_file "$home")" ;;
    bad-date) write_flag "$home" "not-a-date" 96 false ;;
    expired) write_flag "$home" "$(iso_minus '10 minutes')" 97 false ;;
    unhandled) write_flag "$home" "$(iso_plus '2 hours')" 97 false ;;
    handled) write_flag "$home" "$(iso_plus '2 hours')" 97 true ;;
  esac
  run_guard "$home" >/dev/null 2>&1; code=$?
  if [ "$code" -eq 1 ]; then
    fail "never exits 1 (scenario $scenario produced exit 1)"
  fi
done
pass "never exits 1 across all scenarios"

echo "=== usage-statusline.sh ==="

run_statusline() {
  local home="$1" input="$2"
  shift 2
  ( export HOME="$home"; printf '%s' "$input" | env "$@" bash "$STATUSLINE" )
}

# 1. full payload -> model, colored pct, ctx, reset time
home="$(new_fake_home)"
resets="$(epoch_plus '2 hours')"
out=$(run_statusline "$home" "{\"model\":{\"display_name\":\"Sonnet 5\"},\"rate_limits\":{\"five_hour\":{\"used_percentage\":40,\"resets_at\":$resets}},\"context_window\":{\"used_percentage\":42}}")
assert_contains "full payload: model name" "$out" "Sonnet 5"
assert_contains "full payload: ctx pct" "$out" "ctx: 42%"
assert_contains "full payload: has ansi color" "$out" $'\033['

# 2. missing rate_limits (API key login) -> n/a, no flag write
home="$(new_fake_home)"
out=$(run_statusline "$home" '{"model":{"display_name":"Sonnet 5"}}')
assert_contains "no rate_limits: n/a shown" "$out" "n/a"
if [ -f "$(flag_file "$home")" ]; then
  fail "no rate_limits: flag file should not be written"
else
  pass "no rate_limits: flag file not written"
fi

# 3. empty five_hour object -> n/a
home="$(new_fake_home)"
out=$(run_statusline "$home" '{"model":{"display_name":"Sonnet 5"},"rate_limits":{"five_hour":{}}}')
assert_contains "empty five_hour: n/a shown" "$out" "n/a"

# 4. missing context_window -> ctx n/a, no crash
home="$(new_fake_home)"
out=$(run_statusline "$home" "{\"model\":{\"display_name\":\"Sonnet 5\"},\"rate_limits\":{\"five_hour\":{\"used_percentage\":10,\"resets_at\":$resets}}}")
assert_contains "missing context_window: ctx n/a" "$out" "ctx: n/a"

# 5. below threshold -> no flag file written
home="$(new_fake_home)"
run_statusline "$home" "{\"model\":{\"display_name\":\"Sonnet 5\"},\"rate_limits\":{\"five_hour\":{\"used_percentage\":55,\"resets_at\":$resets}},\"context_window\":{\"used_percentage\":10}}" >/dev/null
if [ -f "$(flag_file "$home")" ]; then
  fail "below threshold: flag file should not be written"
else
  pass "below threshold: flag file not written"
fi

# 6. above threshold -> flag file written with correct fields, valid json, ISO resets_at
home="$(new_fake_home)"
run_statusline "$home" "{\"model\":{\"display_name\":\"Sonnet 5\"},\"rate_limits\":{\"five_hour\":{\"used_percentage\":97,\"resets_at\":$resets}},\"context_window\":{\"used_percentage\":10}}" >/dev/null
if jq -e . "$(flag_file "$home")" >/dev/null 2>&1; then
  pass "above threshold: flag file valid json"
else
  fail "above threshold: flag file valid json"
fi
usage_val=$(jq -r '.usage' "$(flag_file "$home")")
handled_val=$(jq -r '.handled' "$(flag_file "$home")")
resets_val=$(jq -r '.resets_at' "$(flag_file "$home")")
created_val=$(jq -r '.created_at' "$(flag_file "$home")")
assert_eq "above threshold: usage field correct" "97" "$usage_val"
assert_eq "above threshold: handled is false" "false" "$handled_val"
if [[ "$resets_val" =~ ^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}Z$ ]]; then
  pass "above threshold: resets_at is ISO8601"
else
  fail "above threshold: resets_at is ISO8601 (got [$resets_val])"
fi
if [ -n "$created_val" ] && [ "$created_val" != "null" ]; then
  pass "above threshold: created_at present"
else
  fail "above threshold: created_at present"
fi

# 7. no leftover .tmp file
tmp_count=$(find "$home/.claude" -name 'wakey-flag.json.tmp*' | wc -l)
assert_eq "no leftover tmp file" "0" "$tmp_count"

# 8. custom threshold via env gates the write
home="$(new_fake_home)"
run_statusline "$home" "{\"model\":{\"display_name\":\"M\"},\"rate_limits\":{\"five_hour\":{\"used_percentage\":60,\"resets_at\":$resets}}}" USAGE_GUARD_THRESHOLD=50 >/dev/null
if [ -f "$(flag_file "$home")" ]; then
  pass "lowered threshold: flag written at 60%"
else
  fail "lowered threshold: flag written at 60%"
fi

home="$(new_fake_home)"
run_statusline "$home" "{\"model\":{\"display_name\":\"M\"},\"rate_limits\":{\"five_hour\":{\"used_percentage\":96,\"resets_at\":$resets}}}" USAGE_GUARD_THRESHOLD=99 >/dev/null
if [ -f "$(flag_file "$home")" ]; then
  fail "raised threshold: no flag written at 96%"
else
  pass "raised threshold: no flag written at 96%"
fi

# 9. dedup: same resets_at, existing handled:true flag is left untouched
home="$(new_fake_home)"
resets_iso="$(date -u -d "@${resets}" +%Y-%m-%dT%H:%M:%SZ)"
write_flag "$home" "$resets_iso" 95 true "2020-01-01T00:00:00Z"
before="$(cat "$(flag_file "$home")")"
run_statusline "$home" "{\"model\":{\"display_name\":\"M\"},\"rate_limits\":{\"five_hour\":{\"used_percentage\":98,\"resets_at\":$resets}}}" >/dev/null
after="$(cat "$(flag_file "$home")")"
assert_eq "dedup: same resets_at leaves handled:true flag untouched" "$before" "$after"

# 10. rollover: different resets_at overwrites with handled:false
home="$(new_fake_home)"
old_resets_iso="$(date -u -d '2020-01-01T00:00:00Z' +%Y-%m-%dT%H:%M:%SZ)"
write_flag "$home" "$old_resets_iso" 95 true "2020-01-01T00:00:00Z"
run_statusline "$home" "{\"model\":{\"display_name\":\"M\"},\"rate_limits\":{\"five_hour\":{\"used_percentage\":98,\"resets_at\":$resets}}}" >/dev/null
new_resets_val=$(jq -r '.resets_at' "$(flag_file "$home")")
new_handled_val=$(jq -r '.handled' "$(flag_file "$home")")
if [ "$new_resets_val" != "$old_resets_iso" ]; then
  pass "rollover: flag overwritten with new resets_at"
else
  fail "rollover: flag overwritten with new resets_at"
fi
assert_eq "rollover: overwritten flag has handled:false" "false" "$new_handled_val"

# 11. malformed input json -> exit 0, no crash
home="$(new_fake_home)"
( export HOME="$home"; printf '{"broken' | bash "$STATUSLINE" >/tmp/sl11.out 2>&1 ); code=$?
assert_eq "malformed input: exit 0" "0" "$code"

# 12. missing jq -> graceful message, exit 0
home="$(new_fake_home)"
nopath_dir="$(mktemp -d)"
for tool in bash cat date printf mv mkdir rm sh; do
  real="$(command -v "$tool")"
  [ -n "$real" ] && ln -sf "$real" "$nopath_dir/$tool"
done
out=$(export HOME="$home"; printf '{}' | PATH="$nopath_dir" bash "$STATUSLINE"); code=$?
assert_eq "missing jq: exit 0" "0" "$code"
assert_contains "missing jq: graceful message" "$out" "jq not found"

# 13. color threshold boundaries
home="$(new_fake_home)"
check_color() {
  local pct="$1" expected_code="$2" desc="$3"
  local o
  o=$(run_statusline "$home" "{\"model\":{\"display_name\":\"M\"},\"rate_limits\":{\"five_hour\":{\"used_percentage\":$pct,\"resets_at\":$resets}}}")
  assert_contains "$desc" "$o" "$expected_code"
}
check_color 69 $'\033[32m' "color: 69 is green"
check_color 70 $'\033[33m' "color: 70 is yellow"
check_color 89 $'\033[33m' "color: 89 is yellow"
check_color 90 $'\033[31m' "color: 90 is red"

# 14. reset time correctness (GNU date path, pinned TZ)
home="$(new_fake_home)"
export TZ=UTC
fixed_epoch=$(date -u -d '2030-01-01T14:07:00Z' +%s)
out=$(run_statusline "$home" "{\"model\":{\"display_name\":\"M\"},\"rate_limits\":{\"five_hour\":{\"used_percentage\":10,\"resets_at\":$fixed_epoch}}}")
assert_contains "reset time: correct HH:MM" "$out" "resets 14:07"
unset TZ

echo
echo "-------------------------"
echo "PASS: $PASS  FAIL: $FAIL"
if [ "$FAIL" -gt 0 ]; then
  exit 1
fi
