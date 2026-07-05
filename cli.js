#!/usr/bin/env node
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const readline = require('readline');

const {
  mergeStatusLine,
  hasOurPreToolUseHook,
  mergePreToolUseHook,
  removeStatusLine,
  removePreToolUseHook,
} = require('./lib/settings-merge');

function getPaths(baseDir, opts = {}) {
  const { scope = 'global', local = false } = opts;
  const claudeDir = path.join(baseDir, '.claude');
  const hooksDir = path.join(claudeDir, 'hooks');
  const statuslineDest = path.join(hooksDir, 'usage-statusline.sh');
  const guardDest = path.join(hooksDir, 'usage-guard.sh');
  const settingsFilename = scope === 'project' && local ? 'settings.local.json' : 'settings.json';
  return {
    scope,
    local,
    claudeDir,
    hooksDir,
    settingsPath: path.join(claudeDir, settingsFilename),
    flagFile: path.join(claudeDir, 'wakey-flag.json'),
    statuslineSrc: path.join(__dirname, 'scripts', 'usage-statusline.sh'),
    guardSrc: path.join(__dirname, 'scripts', 'usage-guard.sh'),
    statuslineDest,
    guardDest,
    statuslineCommand:
      scope === 'project' ? '"$CLAUDE_PROJECT_DIR/.claude/hooks/usage-statusline.sh"' : statuslineDest,
    guardCommand:
      scope === 'project' ? '"$CLAUDE_PROJECT_DIR/.claude/hooks/usage-guard.sh"' : guardDest,
    gitignorePath: scope === 'project' ? path.join(baseDir, '.gitignore') : null,
  };
}

function findProjectRoot(startDir) {
  let dir = startDir;
  for (;;) {
    if (fs.existsSync(path.join(dir, '.git')) || fs.existsSync(path.join(dir, '.claude'))) {
      return dir;
    }
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

function scopeLabel({ scope, local }) {
  if (scope === 'global') return 'global';
  return local ? 'project (local)' : 'project (shared)';
}

function readSettings(settingsPath) {
  if (!fs.existsSync(settingsPath)) {
    return {};
  }
  const raw = fs.readFileSync(settingsPath, 'utf8');
  try {
    return JSON.parse(raw);
  } catch (err) {
    throw new Error(
      `Could not parse ${settingsPath} as JSON (${err.message}). Aborting without changes to avoid clobbering it.`
    );
  }
}

function backupSettings(settingsPath) {
  if (!fs.existsSync(settingsPath)) return null;
  const backupPath = `${settingsPath}.bak`;
  fs.copyFileSync(settingsPath, backupPath);
  return backupPath;
}

function writeSettings(settingsPath, settings) {
  fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + '\n');
}

function gitignoreHasEntry(gitignorePath, entry) {
  if (!fs.existsSync(gitignorePath)) return false;
  const content = fs.readFileSync(gitignorePath, 'utf8');
  return content.split(/\r?\n/).some((line) => line.trim() === entry);
}

function ensureGitignoreEntry(gitignorePath, entry) {
  if (gitignoreHasEntry(gitignorePath, entry)) return { changed: false };
  const content = fs.existsSync(gitignorePath) ? fs.readFileSync(gitignorePath, 'utf8') : '';
  const prefix = content.length > 0 && !content.endsWith('\n') ? '\n' : '';
  fs.appendFileSync(gitignorePath, `${prefix}${entry}\n`);
  return { changed: true };
}

function promptYesNo(question) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    rl.question(`${question} [y/N] `, (answer) => {
      rl.close();
      resolve(/^y(es)?$/i.test(answer.trim()));
    });
  });
}

function parseArgs(argv) {
  const flags = { force: false, yes: false, project: false, local: false };
  const positional = [];
  for (const arg of argv) {
    if (arg === '--force') flags.force = true;
    else if (arg === '--yes' || arg === '-y') flags.yes = true;
    else if (arg === '--project') flags.project = true;
    else if (arg === '--local') flags.local = true;
    else positional.push(arg);
  }
  return { command: positional[0], flags };
}

function resolveContext(flags) {
  if (flags.local && !flags.project) {
    throw new Error('--local requires --project (e.g. `wakey-claude install --project --local`)');
  }
  if (!flags.project) {
    return { baseDir: os.homedir(), pathOpts: { scope: 'global', local: false } };
  }
  const root = findProjectRoot(process.cwd());
  if (!root) {
    throw new Error(
      `No project found (looked for .git or .claude/ while walking up from ${process.cwd()}). ` +
        'Run inside a project, or use the global install.'
    );
  }
  return { baseDir: root, pathOpts: { scope: 'project', local: flags.local } };
}

async function install(baseDir, pathOpts, flags) {
  const p = getPaths(baseDir, pathOpts);
  const changes = [];

  fs.mkdirSync(p.hooksDir, { recursive: true });
  fs.copyFileSync(p.statuslineSrc, p.statuslineDest);
  fs.copyFileSync(p.guardSrc, p.guardDest);
  fs.chmodSync(p.statuslineDest, 0o755);
  fs.chmodSync(p.guardDest, 0o755);
  changes.push(`Copied scripts to ${p.hooksDir}`);

  let settings = readSettings(p.settingsPath);
  const backupPath = backupSettings(p.settingsPath);
  if (backupPath) changes.push(`Backed up existing settings to ${backupPath}`);

  let slResult = mergeStatusLine(settings, { command: p.statuslineCommand, force: flags.force });
  if (slResult.conflict) {
    const existingCommand = settings.statusLine.command;
    let proceed = flags.force || flags.yes;
    if (!proceed) {
      proceed = await promptYesNo(
        `An existing statusLine is configured (currently: "${existingCommand}"). Replace it with wakey-claude's statusline?`
      );
    }
    if (proceed) {
      slResult = mergeStatusLine(settings, { command: p.statuslineCommand, force: true });
      changes.push(`Replaced statusLine (was: "${existingCommand}")`);
    } else {
      changes.push(`Left existing statusLine untouched (was: "${existingCommand}")`);
    }
  } else if (slResult.changed) {
    changes.push('Set statusLine to usage-statusline.sh');
  } else {
    changes.push('statusLine already points to usage-statusline.sh (no change)');
  }
  settings = slResult.settings;

  const hookResult = mergePreToolUseHook(settings, { command: p.guardCommand });
  settings = hookResult.settings;
  if (hookResult.changed) {
    changes.push('Added PreToolUse hook for usage-guard.sh');
  } else {
    changes.push('PreToolUse hook already present (no change)');
  }

  writeSettings(p.settingsPath, settings);

  if (pathOpts.scope === 'project') {
    const { changed } = ensureGitignoreEntry(p.gitignorePath, '.claude/wakey-flag.json');
    changes.push(
      changed
        ? 'Added .claude/wakey-flag.json to .gitignore'
        : '.claude/wakey-flag.json already in .gitignore (no change)'
    );
  }

  console.log(`wakey-claude install complete (${scopeLabel(pathOpts)}):`);
  for (const c of changes) console.log(`  - ${c}`);
  console.log('\nRestart Claude Code (or start a new session) for these changes to take effect.');
}

function isScopeActive(settings, p) {
  return (
    (settings.statusLine && settings.statusLine.command === p.statuslineCommand) ||
    hasOurPreToolUseHook(settings, p.guardCommand)
  );
}

function uninstall(baseDir, pathOpts) {
  const p = getPaths(baseDir, pathOpts);
  const changes = [];

  let settings = readSettings(p.settingsPath);
  if (fs.existsSync(p.settingsPath)) {
    const backupPath = backupSettings(p.settingsPath);
    if (backupPath) changes.push(`Backed up existing settings to ${backupPath}`);

    const slResult = removeStatusLine(settings, { command: p.statuslineCommand });
    settings = slResult.settings;
    if (slResult.changed) changes.push('Removed statusLine entry');

    const hookResult = removePreToolUseHook(settings, { command: p.guardCommand });
    settings = hookResult.settings;
    if (hookResult.changed) changes.push('Removed PreToolUse hook entry');

    writeSettings(p.settingsPath, settings);
  } else {
    changes.push(`No ${path.basename(p.settingsPath)} found (nothing to update)`);
  }

  let siblingActive = false;
  if (pathOpts.scope === 'project') {
    const siblingP = getPaths(baseDir, { scope: 'project', local: !pathOpts.local });
    let siblingSettings = {};
    try {
      siblingSettings = readSettings(siblingP.settingsPath);
    } catch {
      siblingSettings = {};
    }
    siblingActive = isScopeActive(siblingSettings, siblingP);
  }

  if (siblingActive) {
    changes.push(
      `Left scripts and wakey-flag.json in place (still referenced by ${path.basename(
        getPaths(baseDir, { scope: 'project', local: !pathOpts.local }).settingsPath
      )})`
    );
  } else {
    for (const f of [p.statuslineDest, p.guardDest, p.flagFile]) {
      if (fs.existsSync(f)) {
        fs.rmSync(f, { force: true });
        changes.push(`Removed ${f}`);
      }
    }

    if (fs.existsSync(p.hooksDir) && fs.readdirSync(p.hooksDir).length === 0) {
      fs.rmdirSync(p.hooksDir);
      changes.push(`Removed empty ${p.hooksDir}`);
    }
  }

  if (pathOpts.scope === 'project' && gitignoreHasEntry(p.gitignorePath, '.claude/wakey-flag.json')) {
    changes.push('.claude/wakey-flag.json entry left in .gitignore (remove it by hand if no longer needed)');
  }

  console.log(`wakey-claude uninstall complete (${scopeLabel(pathOpts)}):`);
  for (const c of changes) console.log(`  - ${c}`);
}

function checkInstalled(p) {
  let settings;
  try {
    settings = readSettings(p.settingsPath);
  } catch {
    return { installed: false };
  }
  const scriptsPresent = fs.existsSync(p.statuslineDest) && fs.existsSync(p.guardDest);
  return { installed: scriptsPresent && isScopeActive(settings, p) };
}

function status(baseDir, pathOpts) {
  const p = getPaths(baseDir, pathOpts);
  const settings = readSettings(p.settingsPath);
  const threshold = process.env.USAGE_GUARD_THRESHOLD || '95';

  console.log(`wakey-claude status (${scopeLabel(pathOpts)})`);
  console.log('------------------------');
  console.log('Installed hooks:');
  console.log(
    `  statusLine:  ${fs.existsSync(p.statuslineDest) ? 'present' : 'missing'}  (${p.statuslineDest})`
  );
  console.log(
    `  PreToolUse:  ${fs.existsSync(p.guardDest) ? 'present' : 'missing'}  (${p.guardDest})`
  );
  console.log('Settings.json:');
  console.log(
    `  statusLine points to our script:      ${settings.statusLine && settings.statusLine.command === p.statuslineCommand ? 'yes' : 'no'}`
  );
  console.log(
    `  PreToolUse contains our hook command: ${hasOurPreToolUseHook(settings, p.guardCommand) ? 'yes' : 'no'}`
  );
  console.log(`Threshold: ${threshold}%`);

  console.log(`Flag file (${p.flagFile}):`);
  if (fs.existsSync(p.flagFile)) {
    try {
      const flag = JSON.parse(fs.readFileSync(p.flagFile, 'utf8'));
      console.log(
        `  resets_at: ${flag.resets_at}   usage: ${flag.usage}%   handled: ${flag.handled}   created_at: ${flag.created_at}`
      );
    } catch {
      console.log('  (could not parse flag file)');
    }
  } else {
    console.log('  not set (usage has not crossed the threshold this window)');
  }

  console.log('\nScope summary (checked regardless of --project/--local flags):');
  const candidates = [{ label: 'global', p: getPaths(os.homedir(), { scope: 'global' }) }];
  const root = findProjectRoot(process.cwd());
  if (root) {
    candidates.push({ label: 'project (shared)', p: getPaths(root, { scope: 'project', local: false }) });
    candidates.push({ label: 'project (local)', p: getPaths(root, { scope: 'project', local: true }) });
  } else {
    console.log('  project (shared): n/a (not inside a project — no .git or .claude/ found from cwd)');
    console.log('  project (local):  n/a (not inside a project — no .git or .claude/ found from cwd)');
  }
  const results = candidates.map((c) => ({ ...c, ...checkInstalled(c.p) }));
  for (const r of results) console.log(`  ${r.label}: ${r.installed ? 'installed' : 'not installed'}`);
  const installedScopes = results.filter((r) => r.installed).map((r) => r.label);
  if (installedScopes.length > 1) {
    console.log(
      `\nWarning: installed in multiple scopes (${installedScopes.join(', ')}). ` +
        "Project settings take precedence within that project. Consider `uninstall --project [--local]` on the ones you don't want."
    );
  }
}

function printUsage() {
  console.log(`Usage: wakey-claude <install|uninstall|status> [--project [--local]] [--force] [--yes]

  install    Copy hook scripts and wire them into settings (global by default)
  uninstall  Remove the scripts and settings entries wakey-claude added
  status     Show current install state, threshold, and wakey-flag.json contents

Options:
  --project    Install/operate on the current project (<root>/.claude) instead of ~/.claude
  --local      With --project, target settings.local.json (personal, gitignored) instead of settings.json
  --force      Replace an existing statusLine without prompting
  --yes, -y    Answer yes to any confirmation prompts
`);
}

async function main() {
  const { command, flags } = parseArgs(process.argv.slice(2));

  try {
    if (command === 'install' || command === 'uninstall' || command === 'status') {
      const { baseDir, pathOpts } = resolveContext(flags);
      if (command === 'install') {
        await install(baseDir, pathOpts, flags);
      } else if (command === 'uninstall') {
        uninstall(baseDir, pathOpts);
      } else {
        status(baseDir, pathOpts);
      }
    } else {
      printUsage();
      if (command) process.exitCode = 1;
    }
  } catch (err) {
    console.error(`wakey-claude: ${err.message}`);
    process.exitCode = 1;
  }
}

if (require.main === module) {
  main();
}

module.exports = { getPaths, install, uninstall, status, findProjectRoot };
