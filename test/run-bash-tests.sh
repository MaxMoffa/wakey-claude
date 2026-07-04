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

write_state() {
  local home="$1" usage="$2" resets_at="$3" updated_at="$4"
  jq -n --arg usage "$usage" --arg resets_at "$resets_at" --arg updated_at "$updated_at" \
    '{usage: ($usage|tonumber), resets_at: $resets_at, updated_at: $updated_at}' \
    >"$home/.claude/usage-state.json"
}

run_guard() {
  local home="$1"
  shift
  ( export HOME="$home"; env "$@" bash "$GUARD" )
}

now_iso() { date -u +%Y-%m-%dT%H:%M:%SZ; }
epoch_plus() { date -u -d "+$1" +%s; }
iso_minus() { date -u -d "-$1" +%Y-%m-%dT%H:%M:%SZ; }

echo "=== usage-guard.sh ==="

# 1. no state file -> exit 0, no output
home="$(new_fake_home)"
out=$(run_guard "$home" 2>&1); code=$?
assert_eq "no state file: exit 0" "0" "$code"
assert_eq "no state file: no stderr" "" "$out"

# 2. malformed json -> exit 0
home="$(new_fake_home)"
cp "$FIXTURES/state-malformed.json" "$home/.claude/usage-state.json"
run_guard "$home" >/tmp/g2.out 2>&1; code=$?
assert_eq "malformed json: exit 0" "0" "$code"

# 3. missing usage field -> exit 0
home="$(new_fake_home)"
jq -n --arg resets_at "$(epoch_plus '2 hours')" --arg updated_at "$(now_iso)" \
  '{resets_at: $resets_at, updated_at: $updated_at}' >"$home/.claude/usage-state.json"
run_guard "$home" >/dev/null 2>&1; code=$?
assert_eq "missing usage field: exit 0" "0" "$code"

# 4. stale state (age > 30m) -> exit 0 even though over threshold
home="$(new_fake_home)"
write_state "$home" 96 "$(epoch_plus '2 hours')" "$(iso_minus '40 minutes')"
run_guard "$home" >/dev/null 2>&1; code=$?
assert_eq "stale state: exit 0" "0" "$code"

# 5. fresh, below threshold -> exit 0
home="$(new_fake_home)"
write_state "$home" 40 "$(epoch_plus '2 hours')" "$(now_iso)"
run_guard "$home" >/dev/null 2>&1; code=$?
assert_eq "below threshold: exit 0" "0" "$code"

# 6. fresh, at default threshold (95) -> blocks, stderr has all 4 instructions
home="$(new_fake_home)"
write_state "$home" 95 "$(epoch_plus '2 hours')" "$(now_iso)"
out=$(run_guard "$home" 2>&1); code=$?
assert_eq "at threshold: exit 2" "2" "$code"
assert_contains "at threshold: mentions PROGRESS.md" "$out" "PROGRESS.md"
assert_contains "at threshold: mentions scheduled wakeup" "$out" "wake"
assert_contains "at threshold: mentions no new tasks" "$out" "Do not start any new tasks"
assert_contains "at threshold: mentions resume on wakeup" "$out" "continue exactly where you left off"

# 7. above threshold -> blocks, lock file written with resets_at
home="$(new_fake_home)"
resets="$(epoch_plus '2 hours')"
write_state "$home" 97 "$resets" "$(now_iso)"
run_guard "$home" >/dev/null 2>&1; code=$?
assert_eq "above threshold: exit 2" "2" "$code"
lock_content="$(cat "$home/.claude/usage-guard.lock" 2>/dev/null || true)"
assert_eq "above threshold: lock file has resets_at" "$resets" "$lock_content"

# 8. custom threshold lowers the bar -> blocks at 60 with USAGE_GUARD_THRESHOLD=50
home="$(new_fake_home)"
write_state "$home" 60 "$(epoch_plus '2 hours')" "$(now_iso)"
run_guard "$home" USAGE_GUARD_THRESHOLD=50 >/dev/null 2>&1; code=$?
assert_eq "lowered threshold: exit 2" "2" "$code"

# 9. custom threshold raises the bar -> passes at 96 with USAGE_GUARD_THRESHOLD=99
home="$(new_fake_home)"
write_state "$home" 96 "$(epoch_plus '2 hours')" "$(now_iso)"
run_guard "$home" USAGE_GUARD_THRESHOLD=99 >/dev/null 2>&1; code=$?
assert_eq "raised threshold: exit 0" "0" "$code"

# 10. lock-file dedup: second call same window is silent
home="$(new_fake_home)"
resets="$(epoch_plus '2 hours')"
write_state "$home" 97 "$resets" "$(now_iso)"
run_guard "$home" >/dev/null 2>&1
run_guard "$home" >/dev/null 2>&1; code=$?
assert_eq "dedup: second call same window exits 0" "0" "$code"

# 11. lock rollover: new resets_at re-triggers
home="$(new_fake_home)"
write_state "$home" 97 "$(epoch_plus '2 hours')" "$(now_iso)"
run_guard "$home" >/dev/null 2>&1
write_state "$home" 97 "$(epoch_plus '7 hours')" "$(now_iso)"
run_guard "$home" >/dev/null 2>&1; code=$?
assert_eq "rollover: new window re-triggers exit 2" "2" "$code"

# 12. mismatched stale lock content still blocks and rewrites lock
home="$(new_fake_home)"
resets="$(epoch_plus '2 hours')"
write_state "$home" 97 "$resets" "$(now_iso)"
printf '%s' "some-other-old-resets-at" >"$home/.claude/usage-guard.lock"
run_guard "$home" >/dev/null 2>&1; code=$?
assert_eq "mismatched lock: exit 2" "2" "$code"
lock_content="$(cat "$home/.claude/usage-guard.lock" 2>/dev/null || true)"
assert_eq "mismatched lock: rewritten to current resets_at" "$resets" "$lock_content"

# 13. never exits 1 across all fixture combinations above (spot re-check a few)
for combo in "0:40" "0:97" "50:60"; do
  home="$(new_fake_home)"
  th="${combo%%:*}"; us="${combo##*:}"
  write_state "$home" "$us" "$(epoch_plus '2 hours')" "$(now_iso)"
  if [ "$th" = "0" ]; then
    run_guard "$home" >/dev/null 2>&1; code=$?
  else
    run_guard "$home" USAGE_GUARD_THRESHOLD="$th" >/dev/null 2>&1; code=$?
  fi
  if [ "$code" -eq 1 ]; then
    fail "never exits 1 (combo $combo produced exit 1)"
  fi
done
pass "never exits 1 across sampled combos"

echo "=== usage-statusline.sh ==="

run_statusline() {
  local home="$1" input="$2"
  ( export HOME="$home"; printf '%s' "$input" | bash "$STATUSLINE" )
}

# 1. full payload -> model, colored pct, ctx, reset time
home="$(new_fake_home)"
resets="$(epoch_plus '2 hours')"
out=$(run_statusline "$home" "{\"model\":{\"display_name\":\"Sonnet 5\"},\"rate_limits\":{\"five_hour\":{\"used_percentage\":96,\"resets_at\":$resets}},\"context_window\":{\"used_percentage\":42}}")
assert_contains "full payload: model name" "$out" "Sonnet 5"
assert_contains "full payload: ctx pct" "$out" "ctx: 42%"
assert_contains "full payload: has ansi color" "$out" $'\033['

# 2. missing rate_limits (API key login) -> n/a, no state write
home="$(new_fake_home)"
out=$(run_statusline "$home" '{"model":{"display_name":"Sonnet 5"}}')
assert_contains "no rate_limits: n/a shown" "$out" "n/a"
if [ -f "$home/.claude/usage-state.json" ]; then
  fail "no rate_limits: state file should not be written"
else
  pass "no rate_limits: state file not written"
fi

# 3. empty five_hour object -> n/a
home="$(new_fake_home)"
out=$(run_statusline "$home" '{"model":{"display_name":"Sonnet 5"},"rate_limits":{"five_hour":{}}}')
assert_contains "empty five_hour: n/a shown" "$out" "n/a"

# 4. missing context_window -> ctx n/a, no crash
home="$(new_fake_home)"
out=$(run_statusline "$home" "{\"model\":{\"display_name\":\"Sonnet 5\"},\"rate_limits\":{\"five_hour\":{\"used_percentage\":10,\"resets_at\":$resets}}}")
assert_contains "missing context_window: ctx n/a" "$out" "ctx: n/a"

# 5. state file written with correct fields, valid json
home="$(new_fake_home)"
run_statusline "$home" "{\"model\":{\"display_name\":\"Sonnet 5\"},\"rate_limits\":{\"five_hour\":{\"used_percentage\":55,\"resets_at\":$resets}},\"context_window\":{\"used_percentage\":10}}" >/dev/null
if jq -e . "$home/.claude/usage-state.json" >/dev/null 2>&1; then
  pass "state file: valid json"
else
  fail "state file: valid json"
fi
usage_val=$(jq -r '.usage' "$home/.claude/usage-state.json")
assert_eq "state file: usage field correct" "55" "$usage_val"

# 6. no leftover .tmp file
tmp_count=$(find "$home/.claude" -name 'usage-state.json.tmp*' | wc -l)
assert_eq "no leftover tmp file" "0" "$tmp_count"

# 7. malformed input json -> exit 0, no crash
home="$(new_fake_home)"
( export HOME="$home"; printf '{"broken' | bash "$STATUSLINE" >/tmp/sl7.out 2>&1 ); code=$?
assert_eq "malformed input: exit 0" "0" "$code"

# 8. missing jq -> graceful message, exit 0
home="$(new_fake_home)"
nopath_dir="$(mktemp -d)"
for tool in bash cat date printf mv mkdir rm sh; do
  real="$(command -v "$tool")"
  [ -n "$real" ] && ln -sf "$real" "$nopath_dir/$tool"
done
out=$(export HOME="$home"; printf '{}' | PATH="$nopath_dir" bash "$STATUSLINE"); code=$?
assert_eq "missing jq: exit 0" "0" "$code"
assert_contains "missing jq: graceful message" "$out" "jq not found"

# 9. color threshold boundaries
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

# 10. reset time correctness (GNU date path, pinned TZ)
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
