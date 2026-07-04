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

function getPaths(homeDir) {
  const claudeDir = path.join(homeDir, '.claude');
  const hooksDir = path.join(claudeDir, 'hooks');
  const statuslineDest = path.join(hooksDir, 'usage-statusline.sh');
  const guardDest = path.join(hooksDir, 'usage-guard.sh');
  return {
    claudeDir,
    hooksDir,
    settingsPath: path.join(claudeDir, 'settings.json'),
    stateFile: path.join(claudeDir, 'usage-state.json'),
    lockFile: path.join(claudeDir, 'usage-guard.lock'),
    statuslineSrc: path.join(__dirname, 'scripts', 'usage-statusline.sh'),
    guardSrc: path.join(__dirname, 'scripts', 'usage-guard.sh'),
    statuslineDest,
    guardDest,
    statuslineCommand: statuslineDest,
    guardCommand: guardDest,
  };
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
  const flags = { force: false, yes: false };
  const positional = [];
  for (const arg of argv) {
    if (arg === '--force') flags.force = true;
    else if (arg === '--yes' || arg === '-y') flags.yes = true;
    else positional.push(arg);
  }
  return { command: positional[0], flags };
}

async function install(homeDir, flags) {
  const p = getPaths(homeDir);
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
        `An existing statusLine is configured (currently: "${existingCommand}"). Replace it with claude-usage-guard's statusline?`
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

  console.log('claude-usage-guard install complete:');
  for (const c of changes) console.log(`  - ${c}`);
  console.log('\nRestart Claude Code (or start a new session) for these changes to take effect.');
}

function uninstall(homeDir) {
  const p = getPaths(homeDir);
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
    changes.push('No settings.json found (nothing to update)');
  }

  for (const f of [p.statuslineDest, p.guardDest, p.stateFile, p.lockFile]) {
    if (fs.existsSync(f)) {
      fs.rmSync(f, { force: true });
      changes.push(`Removed ${f}`);
    }
  }

  if (fs.existsSync(p.hooksDir) && fs.readdirSync(p.hooksDir).length === 0) {
    fs.rmdirSync(p.hooksDir);
    changes.push(`Removed empty ${p.hooksDir}`);
  }

  console.log('claude-usage-guard uninstall complete:');
  for (const c of changes) console.log(`  - ${c}`);
}

function formatAge(updatedAt) {
  const updatedMs = Date.parse(updatedAt);
  if (Number.isNaN(updatedMs)) return 'unknown';
  const ageMin = Math.round((Date.now() - updatedMs) / 60000);
  return `${ageMin}m ago${ageMin > 30 ? ' (STALE)' : ''}`;
}

function status(homeDir) {
  const p = getPaths(homeDir);
  const settings = readSettings(p.settingsPath);
  const threshold = process.env.USAGE_GUARD_THRESHOLD || '95';

  console.log('claude-usage-guard status');
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

  console.log(`State file (${p.stateFile}):`);
  if (fs.existsSync(p.stateFile)) {
    try {
      const state = JSON.parse(fs.readFileSync(p.stateFile, 'utf8'));
      console.log(
        `  usage: ${state.usage}%   resets_at: ${state.resets_at}   updated_at: ${state.updated_at}   age: ${formatAge(state.updated_at)}`
      );
    } catch {
      console.log('  (could not parse state file)');
    }
  } else {
    console.log('  not found (no statusline data recorded yet)');
  }

  console.log(`Lock file (${p.lockFile}):`);
  if (fs.existsSync(p.lockFile)) {
    console.log(`  resets_at: ${fs.readFileSync(p.lockFile, 'utf8')}`);
  } else {
    console.log('  not set');
  }
}

function printUsage() {
  console.log(`Usage: claude-usage-guard <install|uninstall|status> [--force] [--yes]

  install    Copy hook scripts to ~/.claude/hooks and wire them into ~/.claude/settings.json
  uninstall  Remove the scripts and settings entries claude-usage-guard added
  status     Show current install state, threshold, and usage-state.json contents

Options:
  --force    Replace an existing statusLine without prompting
  --yes, -y  Answer yes to any confirmation prompts
`);
}

async function main() {
  const { command, flags } = parseArgs(process.argv.slice(2));
  const homeDir = os.homedir();

  try {
    if (command === 'install') {
      await install(homeDir, flags);
    } else if (command === 'uninstall') {
      uninstall(homeDir);
    } else if (command === 'status') {
      status(homeDir);
    } else {
      printUsage();
      if (command) process.exitCode = 1;
    }
  } catch (err) {
    console.error(`claude-usage-guard: ${err.message}`);
    process.exitCode = 1;
  }
}

if (require.main === module) {
  main();
}

module.exports = { getPaths, install, uninstall, status };
