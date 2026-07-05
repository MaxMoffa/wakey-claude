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
const { findProjectRoot } = require('../cli');

const REPO_ROOT = path.join(__dirname, '..');
const FIXTURES = path.join(__dirname, 'fixtures');
const OUR_STATUSLINE = '/home/example/.claude/hooks/usage-statusline.sh';
const OUR_GUARD = '/home/example/.claude/hooks/usage-guard.sh';
const PROJECT_STATUSLINE = '"$CLAUDE_PROJECT_DIR/.claude/hooks/usage-statusline.sh"';
const PROJECT_GUARD = '"$CLAUDE_PROJECT_DIR/.claude/hooks/usage-guard.sh"';

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

function makeFakeProject() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cug-project-'));
  fs.mkdirSync(path.join(root, '.git'));
  return root;
}

function runCli(homeDir, args, input, opts = {}) {
  return execFileSync('node', [path.join(REPO_ROOT, 'cli.js'), ...args], {
    env: { ...process.env, HOME: homeDir },
    input: input || '',
    encoding: 'utf8',
    cwd: opts.cwd,
  });
}

function runCliExpectError(homeDir, args, opts = {}) {
  try {
    runCli(homeDir, args, null, opts);
    assert.fail('expected cli to exit with a non-zero status');
  } catch (err) {
    return err.stderr;
  }
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

// --- findProjectRoot ---

test('findProjectRoot: finds nearest ancestor with .git from a nested subdir', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wc-root-'));
  fs.mkdirSync(path.join(root, '.git'));
  const nested = path.join(root, 'a', 'b', 'c');
  fs.mkdirSync(nested, { recursive: true });
  assert.equal(findProjectRoot(nested), root);
});

test('findProjectRoot: finds nearest ancestor with an existing .claude dir', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wc-root-'));
  fs.mkdirSync(path.join(root, '.claude'));
  const nested = path.join(root, 'sub');
  fs.mkdirSync(nested);
  assert.equal(findProjectRoot(nested), root);
});

test('findProjectRoot: neither .git nor .claude anywhere up to filesystem root -> null', () => {
  const leaf = fs.mkdtempSync(path.join(os.tmpdir(), 'wc-leaf-'));
  assert.equal(findProjectRoot(leaf), null);
});

// --- cli.js project-scope integration tests ---

test('cli install --project: writes $CLAUDE_PROJECT_DIR-literal commands, copies scripts under project .claude/hooks', () => {
  const home = makeFakeHome();
  const project = makeFakeProject();
  runCli(home, ['install', '--project', '--yes'], null, { cwd: project });

  const settings = JSON.parse(fs.readFileSync(path.join(project, '.claude', 'settings.json'), 'utf8'));
  assert.equal(settings.statusLine.command, PROJECT_STATUSLINE);
  assert.ok(fs.existsSync(path.join(project, '.claude', 'hooks', 'usage-statusline.sh')));
  assert.ok(fs.existsSync(path.join(project, '.claude', 'hooks', 'usage-guard.sh')));
  assert.equal(fs.existsSync(path.join(home, '.claude', 'settings.json')), false);
});

test('cli install --project --local: targets settings.local.json, leaves settings.json untouched', () => {
  const home = makeFakeHome();
  const project = makeFakeProject();
  runCli(home, ['install', '--project', '--yes'], null, { cwd: project });
  const sharedPath = path.join(project, '.claude', 'settings.json');
  const sharedBefore = fs.readFileSync(sharedPath, 'utf8');

  runCli(home, ['install', '--project', '--local', '--yes'], null, { cwd: project });

  const localPath = path.join(project, '.claude', 'settings.local.json');
  const local = JSON.parse(fs.readFileSync(localPath, 'utf8'));
  assert.equal(local.statusLine.command, PROJECT_STATUSLINE);
  assert.equal(fs.readFileSync(sharedPath, 'utf8'), sharedBefore);
});

test('cli install --local (no --project): errors clearly', () => {
  const home = makeFakeHome();
  const stderr = runCliExpectError(home, ['install', '--local', '--yes']);
  assert.match(stderr, /--local requires --project/);
});

test('cli install --project: outside any project errors clearly', () => {
  const home = makeFakeHome();
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'cug-outside-'));
  const stderr = runCliExpectError(home, ['install', '--project', '--yes'], { cwd: outside });
  assert.match(stderr, /Run inside a project, or use the global install/);
});

test('cli install --project: appends .claude/wakey-flag.json to .gitignore, stays deduped on repeat', () => {
  const home = makeFakeHome();
  const project = makeFakeProject();
  runCli(home, ['install', '--project', '--yes'], null, { cwd: project });

  const gitignorePath = path.join(project, '.gitignore');
  assert.match(fs.readFileSync(gitignorePath, 'utf8'), /^\.claude\/wakey-flag\.json$/m);

  runCli(home, ['install', '--project', '--yes'], null, { cwd: project });
  const lines = fs.readFileSync(gitignorePath, 'utf8').split('\n');
  const occurrences = lines.filter((l) => l.trim() === '.claude/wakey-flag.json').length;
  assert.equal(occurrences, 1);
});

test('cli status: reports both global and project scopes when both installed, warns on double-install', () => {
  const home = makeFakeHome();
  const project = makeFakeProject();
  runCli(home, ['install', '--yes']);
  runCli(home, ['install', '--project', '--yes'], null, { cwd: project });

  const out = runCli(home, ['status'], null, { cwd: project });
  assert.match(out, /global: installed/);
  assert.match(out, /project \(shared\): installed/);
  assert.match(out, /Warning: installed in multiple scopes/);
});

test('cli uninstall --project: shared uninstall leaves scripts and local settings intact while local install is still active', () => {
  const home = makeFakeHome();
  const project = makeFakeProject();
  runCli(home, ['install', '--project', '--yes'], null, { cwd: project });
  runCli(home, ['install', '--project', '--local', '--yes'], null, { cwd: project });

  runCli(home, ['uninstall', '--project'], null, { cwd: project });

  assert.ok(fs.existsSync(path.join(project, '.claude', 'hooks', 'usage-statusline.sh')));
  assert.ok(fs.existsSync(path.join(project, '.claude', 'hooks', 'usage-guard.sh')));

  const shared = JSON.parse(fs.readFileSync(path.join(project, '.claude', 'settings.json'), 'utf8'));
  assert.equal(shared.statusLine, undefined);

  const local = JSON.parse(fs.readFileSync(path.join(project, '.claude', 'settings.local.json'), 'utf8'));
  assert.equal(local.statusLine.command, PROJECT_STATUSLINE);
});
