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

This is an event-based design: nothing is written to disk until usage actually crosses the
threshold, and the file that gets written is a one-shot alarm, not continuously-updated
state.

Three pieces work together:

1. **`usage-statusline.sh`** (a `statusLine` command) reads Claude Code's status JSON on
   every render and displays it as usual. It only touches disk when
   `rate_limits.five_hour.used_percentage` crosses the threshold (default 95%) — at that
   point it raises a flag by writing `~/.claude/wakey-flag.json`. Below threshold, and on
   every render after the flag for the current window already exists, it writes nothing.
2. **`usage-guard.sh`** (a `PreToolUse` hook) is a dumb one-shot consumer: if the flag file
   doesn't exist, it's a no-op. If it exists and hasn't been handled yet, it blocks the tool
   call *once*, marks the flag `handled`, and tells Claude, via the blocked-call feedback, to
   checkpoint its progress and schedule a native one-time wakeup. If the flag is already
   `handled`, or its window has already reset, the guard passes through (deleting an expired
   flag as it goes).
3. Claude writes `PROGRESS.md`, schedules the wakeup for reset time + 3 minutes, and stops.
   When the wakeup fires, Claude reads `PROGRESS.md` and resumes exactly where it left off.

### Flag file lifecycle

`~/.claude/wakey-flag.json` moves through three states over a 5-hour window:

```
        usage < threshold
        (no flag file exists)
                 │
                 │ statusline: used_percentage >= THRESHOLD,
                 │ no existing flag has this resets_at
                 ▼
   ┌─────────────────────────────┐
   │           WRITTEN           │  { resets_at: ISO8601,
   │   handled: false            │    usage: int,
   │                             │    handled: false,
   └───────────────┬─────────────┘    created_at: ISO8601 }
                    │
   ┌────────────────┴─────────────────────────┐
   │ statusline re-renders, SAME resets_at:    │  guard runs (PreToolUse):
   │ write is skipped (dedup guard — never     │  resets_at still in the
   │ clobbers handled back to false)           │  future, handled == false
   ▼                                           ▼
 (no-op, flag unchanged)             ┌────────────────────────┐
                                      │        HANDLED          │
                                      │  handled -> true        │
                                      │  exit 2 + stderr:        │
                                      │  "write PROGRESS.md,     │
                                      │   schedule native wakeup │
                                      │   at resets_at + 3m,     │
                                      │   stop new work"         │
                                      └────────────┬─────────────┘
                                                   │
                               further PreToolUse calls this window:
                               handled == true -> exit 0 (pass through)
                                                   │
                                      ── 5h window resets ──
                                                   │
                                                   ▼
                                   guard (or the next threshold
                                   crossing) sees resets_at <= now
                                                   │
                                                   ▼
                                         ┌────────────────┐
                                         │    DELETED      │
                                         │ (window reset)  │
                                         └────────────────┘
                                                   │
                             next threshold crossing writes a
                             fresh flag for the new window
```

Corrupt or unparseable flag contents are treated as "expired" by the guard (deleted, fail
open) and as "no flag" by the statusline's dedup check (overwritten) — a broken flag can't
serve as either an alarm or a dedup key, and the statusline runs far more often than the
guard, so it self-heals the file on its next render.

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
`~/.claude/wakey-flag.json`.

## Status

```
npx wakey-claude status
```

Prints whether the hooks/statusLine are installed, the configured threshold, and — if a
threshold crossing has occurred this window — the contents of `wakey-flag.json`.

## Configuration

`USAGE_GUARD_THRESHOLD` (default `95`) — the 5-hour usage % at which the statusline raises
the flag (the guard hook trusts whatever flag the statusline already wrote and does not
re-check this value). This is a **process environment variable**, not a `settings.json`
field — export it in the shell profile that launches `claude` (e.g.
`export USAGE_GUARD_THRESHOLD=90` in `.bashrc`/`.zshrc`).

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
  or resume, and no statusline render loop to raise the flag.
- The guard blocks only once per 5-hour window by design (the flag's `handled` boolean is
  the dedup mechanism — see the flag file lifecycle above).

## Troubleshooting

- **Status line shows `n/a`** — check your login type; `rate_limits` data requires a
  Pro/Max subscription login, not an API key.
- **Guard never triggers** — check `USAGE_GUARD_THRESHOLD`, and run `status` to confirm
  `~/.claude/wakey-flag.json` exists once usage crosses the threshold, and that its
  `resets_at` is in the future.
- **`jq: command not found`** — install `jq` (both scripts depend on it and degrade
  gracefully, but usage tracking won't work without it).
- **Hook not firing at all** — run `status` to confirm `settings.json` has the
  `PreToolUse` entry, and confirm you restarted Claude Code after installing.
- **Wakeup never happened** — check that the terminal/tmux/SSH session didn't die, confirm
  `PROGRESS.md` was actually written, and confirm the native scheduled task was actually
  created.
- **Manual cleanup** — if the CLI is unavailable, you can always remove
  `~/.claude/wakey-flag.json` by hand, and edit `~/.claude/settings.json` to drop the
  `statusLine`/`PreToolUse` entries pointing at `~/.claude/hooks/usage-*.sh`.

## License

MIT
