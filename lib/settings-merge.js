'use strict';

// Pure, side-effect-free transforms over a Claude Code settings.json object.
// No filesystem I/O here so these are cheaply unit-testable; cli.js owns
// reading/writing/backups/prompts.

function clone(obj) {
  return JSON.parse(JSON.stringify(obj));
}

function mergeStatusLine(settings, { command, force }) {
  const result = clone(settings);
  const existing = result.statusLine;

  if (existing && existing.command === command) {
    return { settings: result, changed: false, conflict: false };
  }

  if (existing && existing.command && existing.command !== command && !force) {
    return { settings: result, changed: false, conflict: true };
  }

  result.statusLine = { type: 'command', command };
  return { settings: result, changed: true, conflict: false };
}

function hasOurPreToolUseHook(settings, command) {
  const groups = settings?.hooks?.PreToolUse;
  if (!Array.isArray(groups)) return false;
  return groups.some(
    (group) =>
      Array.isArray(group.hooks) &&
      group.hooks.some((h) => h && h.type === 'command' && h.command === command)
  );
}

function mergePreToolUseHook(settings, { command }) {
  const result = clone(settings);

  if (hasOurPreToolUseHook(result, command)) {
    return { settings: result, changed: false };
  }

  if (!result.hooks || typeof result.hooks !== 'object') {
    result.hooks = {};
  }
  if (!Array.isArray(result.hooks.PreToolUse)) {
    result.hooks.PreToolUse = [];
  }

  result.hooks.PreToolUse.push({
    matcher: '*',
    hooks: [{ type: 'command', command }],
  });

  return { settings: result, changed: true };
}

function removeStatusLine(settings, { command }) {
  const result = clone(settings);
  if (result.statusLine && result.statusLine.command === command) {
    delete result.statusLine;
    return { settings: result, changed: true };
  }
  return { settings: result, changed: false };
}

function removePreToolUseHook(settings, { command }) {
  const result = clone(settings);
  const groups = result.hooks?.PreToolUse;
  if (!Array.isArray(groups)) {
    return { settings: result, changed: false };
  }

  let changed = false;
  const filteredGroups = groups
    .map((group) => {
      if (!Array.isArray(group.hooks)) return group;
      const filteredHooks = group.hooks.filter((h) => {
        const isOurs = h && h.type === 'command' && h.command === command;
        if (isOurs) changed = true;
        return !isOurs;
      });
      return { ...group, hooks: filteredHooks };
    })
    .filter((group) => Array.isArray(group.hooks) && group.hooks.length > 0);

  if (!changed) {
    return { settings: result, changed: false };
  }

  if (filteredGroups.length > 0) {
    result.hooks.PreToolUse = filteredGroups;
  } else {
    delete result.hooks.PreToolUse;
    if (Object.keys(result.hooks).length === 0) {
      delete result.hooks;
    }
  }

  return { settings: result, changed: true };
}

module.exports = {
  mergeStatusLine,
  hasOurPreToolUseHook,
  mergePreToolUseHook,
  removeStatusLine,
  removePreToolUseHook,
};
