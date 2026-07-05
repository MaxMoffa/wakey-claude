```

              z Z
        \ | / z
     ' -(u_u)- ' ______________________
        / | \.-'  ~   ~   ~   ~   ~  '-.
       (pillow)________________________/

 _    _   ___   _   __ _____ __   __
| |  | | / _ \ | | / /|  ___|\ \ / /
| |  | |/ /_\ \| |/ / | |__   \ V / 
| |/\| ||  _  ||    \ |  __|   \ /  
\  /\  /| | | || |\  \| |___   | |  
 \/  \/ \_| |_/\_| \_/\____/   \_/  
 _____  _       ___   _   _ ______  _____ 
/  __ \| |     / _ \ | | | ||  _  \|  ___|
| /  \/| |    / /_\ \| | | || | | || |__  
| |    | |    |  _  || | | || | | ||  __| 
| \__/\| |____| | | || |_| || |/ / | |___ 
 \____/\_____/\_| |_/ \___/ |___/  \____/ 
```

# wakey-claude

*"Wakey wakey, it's time for school"* — except it's your 5-hour usage window resetting.

Never lose a Claude Code session to the 5-hour usage cap. `wakey-claude` pauses your
session right before the limit hits, has Claude checkpoint its progress, and schedules a
native wakeup to resume automatically once the window resets — no cron, no `at`, no
external scheduler.

## How it works

Three pieces work together:

1. **`usage-statusline.sh`** (a `statusLine` command) reads Claude Code's status JSON on
   every render and writes the current usage % / reset time to `~/.claude/usage-state.json`.
2. **`usage-guard.sh`** (a `PreToolUse` hook) reads that state file before every tool call.
   Once usage crosses a threshold (default 95%), it blocks the tool call *once* and tells
   Claude, via the blocked-call feedback, to checkpoint its progress and schedule a native
   one-time wakeup.
3. Claude writes `PROGRESS.md`, schedules the wakeup for reset time + 3 minutes, and stops.
   When the wakeup fires, Claude reads `PROGRESS.md` and resumes exactly where it left off.

```
┌──────────────────────┐   every render    ┌────────────────────────────┐
│  usage-statusline.sh  │ ────────────────▶ │ ~/.claude/usage-state.json │
│   (statusLine hook)   │  usage, resets_at │  {usage, resets_at,        │
│                       │  updated_at       │   updated_at}              │
└───────────────────────┘                   └─────────────┬──────────────┘
                                                            │ read
                                                            ▼
                                              ┌────────────────────────────┐
                                              │      usage-guard.sh        │
                                              │ (PreToolUse, every call)   │
                                              └─────────────┬──────────────┘
                                                             │
                        usage < threshold, stale,            │  usage >= threshold
                        or already blocked this window        │  AND lock != resets_at
                                                             │
                              ┌──────────────────────────────┴────────────────────────┐
                              ▼                                                       ▼
                        exit 0 (pass)                                     write lock(resets_at)
                                                                           exit 2 + stderr:
                                                                           "write PROGRESS.md,
                                                                            schedule native wakeup
                                                                            at resets_at + 3m,
                                                                            stop new work"
                                                                                     │
                                                                                     ▼
                                                                 Claude writes PROGRESS.md,
                                                                 schedules a native one-time
                                                                 wakeup for resets_at + 3m
                                                                                     │
                                                                (session process stays alive,
                                                                     waiting for wakeup)
                                                                                     ▼
                                                                  ── 5h window resets ──
                                                                                     │
                                                                                     ▼
                                                                  native wakeup fires ->
                                                                  Claude reads PROGRESS.md
                                                                  -> resumes where it left off
```

## Install

```
npx wakey-claude install
```

This copies `usage-statusline.sh` and `usage-guard.sh` into `~/.claude/hooks/` (chmod
`755`), then merges into `~/.claude/settings.json`:

- `statusLine` → points at the copied `usage-statusline.sh`. If you already have a
  `statusLine` configured, you'll be asked to confirm before it's replaced (or pass
  `--force` / `--yes` to skip the prompt).
- `hooks.PreToolUse` → a new matcher group running `usage-guard.sh` is appended. Any
  existing hooks (e.g. a `Stop` sound notification) are left untouched. Running install
  again is a no-op if everything is already in place.

A `.bak` backup of your `settings.json` is made before any write.

**Restart Claude Code (or start a new session) after installing** for the changes to take
effect.

## Uninstall

```
npx wakey-claude uninstall
```

Removes the copied scripts, removes only the `statusLine`/`PreToolUse` entries this tool
added (anything else in `settings.json` is left alone), and deletes
`~/.claude/usage-state.json` and `~/.claude/usage-guard.lock`.

## Status

```
npx wakey-claude status
```

Prints whether the hooks/statusLine are installed, the current threshold, and the contents
of the state/lock files.

## Configuration

`USAGE_GUARD_THRESHOLD` (default `95`) — the 5-hour usage % at which the guard blocks. This
is a **process environment variable**, not a `settings.json` field — export it in the shell
profile that launches `claude` (e.g. `export USAGE_GUARD_THRESHOLD=90` in `.bashrc`/`.zshrc`).

## Install methods: CLI vs. plugin

You can install either via the `npx` CLI above, or as a Claude Code plugin:

```
/plugin marketplace add <this repo>
```

Use one or the other, not both — running both would register the `PreToolUse` hook twice.

## Limitations

- The Claude Code session process must stay alive for the scheduled wakeup to fire. PC
  sleep, closing the laptop lid, or an SSH/tmux session dying will silently prevent the
  wakeup from ever running.
- Rate-limit data (`rate_limits.five_hour`) is only populated for Pro/Max subscription
  logins. API-key-based auth shows `n/a` in the status line and the guard never triggers
  (there's nothing to compare against).
- Not meaningful in headless or CI environments — there's no interactive session to pause
  or resume, and no statusline render loop driving state updates.
- The guard blocks only once per 5-hour window by design (lock-file dedup keyed on
  `resets_at`).

## Troubleshooting

- **Status line shows `n/a`** — check your login type; `rate_limits` data requires a
  Pro/Max subscription login, not an API key.
- **Guard never triggers** — check `USAGE_GUARD_THRESHOLD`, and run `status` to confirm
  `~/.claude/usage-state.json` is being updated and isn't stale (older than 30 minutes).
- **`jq: command not found`** — install `jq` (both scripts depend on it and degrade
  gracefully, but usage tracking won't work without it).
- **Hook not firing at all** — run `status` to confirm `settings.json` has the
  `PreToolUse` entry, and confirm you restarted Claude Code after installing.
- **Wakeup never happened** — check that the terminal/tmux/SSH session didn't die, confirm
  `PROGRESS.md` was actually written, and confirm the native scheduled task was actually
  created.
- **Manual cleanup** — if the CLI is unavailable, you can always remove
  `~/.claude/usage-state.json` and `~/.claude/usage-guard.lock` by hand, and edit
  `~/.claude/settings.json` to drop the `statusLine`/`PreToolUse` entries pointing at
  `~/.claude/hooks/usage-*.sh`.

## License

MIT
