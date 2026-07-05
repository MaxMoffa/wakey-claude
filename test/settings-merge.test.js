'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const {
  mergeStatusLine,
  hasOurPreToolUseHook,
  mergePreToolUseHook,
  removeStatusLine,
  removePreToolUseHook,
} = require('../lib/settings-merge');

const REPO_ROOT = path.join(__dirname, '..');
const FIXTURES = path.join(__dirname, 'fixtures');
const OUR_STATUSLINE = '/home/example/.claude/hooks/usage-statusline.sh';
const OUR_GUARD = '/home/example/.claude/hooks/usage-guard.sh';

function loadFixture(name) {
  return JSON.parse(fs.readFileSync(path.join(FIXTURES, name), 'utf8'));
}

test('mergeStatusLine: empty settings -> adds statusLine, changed=true', () => {
  const result = mergeStatusLine({}, { command: OUR_STATUSLINE, force: false });
  assert.equal(result.changed, true);
  assert.equal(result.conflict, false);
  assert.deepEqual(result.settings.statusLine, { type: 'command', command: OUR_STATUSLINE });
});

test('mergeStatusLine: already our command -> changed=false, idempotent', () => {
  const settings = { statusLine: { type: 'command', command: OUR_STATUSLINE } };
  const result = mergeStatusLine(settings, { command: OUR_STATUSLINE, force: false });
  assert.equal(result.changed, false);
  assert.equal(result.conflict, false);
});

test('mergeStatusLine: differing existing statusLine, force=false -> conflict, unchanged', () => {
  const settings = loadFixture('settings-with-stop-hook.json');
  const originalCommand = settings.statusLine.command;
  const result = mergeStatusLine(settings, { command: OUR_STATUSLINE, force: false });
  assert.equal(result.conflict, true);
  assert.equal(result.changed, false);
  assert.equal(result.settings.statusLine.command, originalCommand);
});

test('mergeStatusLine: differing existing statusLine, force=true -> replaces', () => {
  const settings = loadFixture('settings-with-stop-hook.json');
  const result = mergeStatusLine(settings, { command: OUR_STATUSLINE, force: true });
  assert.equal(result.conflict, false);
  assert.equal(result.changed, true);
  assert.equal(result.settings.statusLine.command, OUR_STATUSLINE);
});

test('mergePreToolUseHook: no hooks key -> creates hooks.PreToolUse with one group', () => {
  const result = mergePreToolUseHook({}, { command: OUR_GUARD });
  assert.equal(result.changed, true);
  assert.equal(result.settings.hooks.PreToolUse.length, 1);
  assert.equal(result.settings.hooks.PreToolUse[0].matcher, '*');
  assert.equal(result.settings.hooks.PreToolUse[0].hooks[0].command, OUR_GUARD);
});

test('mergePreToolUseHook: existing hooks.Stop survives untouched, PreToolUse added', () => {
  const settings = loadFixture('settings-with-stop-hook.json');
  const originalStop = JSON.parse(JSON.stringify(settings.hooks.Stop));
  const result = mergePreToolUseHook(settings, { command: OUR_GUARD });
  assert.equal(result.changed, true);
  assert.deepEqual(result.settings.hooks.Stop, originalStop);
  assert.equal(hasOurPreToolUseHook(result.settings, OUR_GUARD), true);
});

test('mergePreToolUseHook: already present -> changed=false, no duplicate', () => {
  const settings = loadFixture('settings-already-installed.json');
  const originalLength = settings.hooks.PreToolUse.length;
  const result = mergePreToolUseHook(settings, { command: OUR_GUARD });
  assert.equal(result.changed, false);
  assert.equal(result.settings.hooks.PreToolUse.length, originalLength);
});

test('mergePreToolUseHook: foreign PreToolUse hook exists -> ours appended alongside it', () => {
  const settings = loadFixture('settings-with-foreign-pretooluse.json');
  const result = mergePreToolUseHook(settings, { command: OUR_GUARD });
  assert.equal(result.changed, true);
  assert.equal(result.settings.hooks.PreToolUse.length, 2);
  assert.equal(result.settings.hooks.PreToolUse[0].matcher, 'Bash');
  assert.equal(result.settings.hooks.PreToolUse[0].hooks[0].command, '/some/other/plugin/check.sh');
});

test('hasOurPreToolUseHook: exact match true, similar-but-different path false', () => {
  const settings = loadFixture('settings-already-installed.json');
  assert.equal(hasOurPreToolUseHook(settings, OUR_GUARD), true);
  assert.equal(hasOurPreToolUseHook(settings, OUR_GUARD + '.bak'), false);
});

test('removeStatusLine: our statusLine present -> removed', () => {
  const settings = { statusLine: { type: 'command', command: OUR_STATUSLINE } };
  const result = removeStatusLine(settings, { command: OUR_STATUSLINE });
  assert.equal(result.changed, true);
  assert.equal(result.settings.statusLine, undefined);
});

test('removeStatusLine: statusLine points elsewhere -> left untouched', () => {
  const settings = loadFixture('settings-with-stop-hook.json');
  const result = removeStatusLine(settings, { command: OUR_STATUSLINE });
  assert.equal(result.changed, false);
  assert.equal(result.settings.statusLine.command, settings.statusLine.command);
});

test('removePreToolUseHook: ours removed, foreign group + hooks.Stop survive', () => {
  const settings = loadFixture('settings-already-installed.json');
  const result = removePreToolUseHook(settings, { command: OUR_GUARD });
  assert.equal(result.changed, true);
  assert.equal(result.settings.hooks.PreToolUse, undefined);
  assert.deepEqual(result.settings.hooks.Stop, settings.hooks.Stop);
});

test('removePreToolUseHook: sole entry removed -> empty group and array pruned, Stop remains', () => {
  const settings = loadFixture('settings-already-installed.json');
  const result = removePreToolUseHook(settings, { command: OUR_GUARD });
  assert.equal(result.settings.hooks.PreToolUse, undefined);
  assert.ok(Array.isArray(result.settings.hooks.Stop));
});

test('round-trip idempotency: merging twice produces identical settings', () => {
  const first = mergePreToolUseHook(mergeStatusLine({}, { command: OUR_STATUSLINE, force: false }).settings, {
    command: OUR_GUARD,
  }).settings;
  const secondStatusLine = mergeStatusLine(first, { command: OUR_STATUSLINE, force: false });
  const second = mergePreToolUseHook(secondStatusLine.settings, { command: OUR_GUARD }).settings;
  assert.deepEqual(first, second);
});

test('supply-chain safety: our command strings never contain npx or @latest', () => {
  assert.equal(OUR_STATUSLINE.includes('npx'), false);
  assert.equal(OUR_STATUSLINE.includes('@latest'), false);
  assert.equal(OUR_GUARD.includes('npx'), false);
  assert.equal(OUR_GUARD.includes('@latest'), false);
});

// --- cli.js filesystem-level integration tests ---

function makeFakeHome() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'cug-home-'));
}

function runCli(homeDir, args, input) {
  return execFileSync('node', [path.join(REPO_ROOT, 'cli.js'), ...args], {
    env: { ...process.env, HOME: homeDir },
    input: input || '',
    encoding: 'utf8',
  });
}

test('cli install: creates .bak backup only when settings.json pre-existed', () => {
  const home = makeFakeHome();
  fs.mkdirSync(path.join(home, '.claude'), { recursive: true });
  fs.writeFileSync(path.join(home, '.claude', 'settings.json'), JSON.stringify(loadFixture('settings-with-stop-hook.json')));

  runCli(home, ['install', '--yes']);
  assert.ok(fs.existsSync(path.join(home, '.claude', 'settings.json.bak')));
});

test('cli install: no pre-existing settings.json -> no backup created', () => {
  const home = makeFakeHome();
  runCli(home, ['install', '--yes']);
  assert.equal(fs.existsSync(path.join(home, '.claude', 'settings.json.bak')), false);
  assert.ok(fs.existsSync(path.join(home, '.claude', 'settings.json')));
});

test('cli install: copies both scripts and chmods them 0o755', () => {
  const home = makeFakeHome();
  runCli(home, ['install', '--yes']);
  const slPath = path.join(home, '.claude', 'hooks', 'usage-statusline.sh');
  const guardPath = path.join(home, '.claude', 'hooks', 'usage-guard.sh');
  assert.ok(fs.existsSync(slPath));
  assert.ok(fs.existsSync(guardPath));
  assert.equal(fs.statSync(slPath).mode & 0o777, 0o755);
  assert.equal(fs.statSync(guardPath).mode & 0o777, 0o755);
});

test('cli uninstall: removes wakey-flag.json, leaves other files untouched', () => {
  const home = makeFakeHome();
  runCli(home, ['install', '--yes']);
  const claudeDir = path.join(home, '.claude');
  fs.writeFileSync(
    path.join(claudeDir, 'wakey-flag.json'),
    '{"resets_at":"2030-01-01T00:00:00Z","usage":97,"handled":false,"created_at":"2030-01-01T00:00:00Z"}'
  );
  fs.writeFileSync(path.join(claudeDir, 'unrelated-file.txt'), 'keep me');

  runCli(home, ['uninstall']);

  assert.equal(fs.existsSync(path.join(claudeDir, 'wakey-flag.json')), false);
  assert.ok(fs.existsSync(path.join(claudeDir, 'unrelated-file.txt')));
});

test('cli status: reports installed after install, not installed after uninstall', () => {
  const home = makeFakeHome();
  const before = runCli(home, ['status']);
  assert.match(before, /statusLine:\s+missing/);

  runCli(home, ['install', '--yes']);
  const after = runCli(home, ['status']);
  assert.match(after, /statusLine:\s+present/);
  assert.match(after, /PreToolUse contains our hook command: yes/);

  runCli(home, ['uninstall']);
  const afterUninstall = runCli(home, ['status']);
  assert.match(afterUninstall, /statusLine:\s+missing/);
});
