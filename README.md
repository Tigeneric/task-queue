# task-queue

Two [Claude Code](https://claude.com/claude-code) plugins. They work together and stand alone:

| Plugin | What it does |
|---|---|
| `task-queue` | A live pane beside the chat with this session's task queue: what is done, what runs, what waits, which questions are open. Claude keeps it through a small CLI as it works. When the session hands tasks to other sessions, the pane also shows how those sessions are doing. |
| `stale-cache-guard` | Stops a prompt, or another session's `SendMessage`, from re-writing a large context whose prompt cache has expired, unless you allow it. |

## Why

You should not have to ask Claude what it is doing. The queue sits beside the chat and changes as
the work moves, and a turn that ends on a question to you which never reached the queue is sent
back once, so open questions stay in one place.

A session that hands work to others loses track of who does what, and the person watching loses
it first. Once the queue holds tasks owned by other sessions, the pane shows them too: their context
fill and idle time. Coordinator mode adds a report, when this session stops, of any that sit idle
with work left.

The guard exists because of a price: the main conversation's prompt cache lives an hour, and the
next prompt to a large session after that re-writes its whole context at twice the input price. For
a 900k session that is about 1.8M input-equivalent tokens before any work is done, usually for a
message that could have waited or gone to a fresh session.

## Installing

```
/plugin marketplace add Tigeneric/task-queue
/plugin install task-queue@task-queue
/plugin install stale-cache-guard@task-queue
```

Then `/queue` opens the pane. It needs `python3` (3.9 or newer) on `PATH`; nothing else is installed.

A plugin cannot set your permissions. To keep agents from allowing a wake themselves, add to
`permissions.deny` in `~/.claude/settings.json`:

```json
"Bash(*stale-cache-guard.py --allow*)", "Bash(*state/stale-cache-guard/allow-*)"
```

## Options

Set them on the install screen, with `/config`, or under `pluginConfigs` in settings:

```json
"pluginConfigs": {
  "task-queue@task-queue": { "options": { "language": "en", "icons": "plain" } },
  "stale-cache-guard@task-queue": { "options": { "language": "en" } }
}
```

- `language`: `en` (the default) or `ru`. It picks the words the plugins write: the owner words
  Claude is told (`me | you | subagent | codex | bg | session <name>`, or
  `я | ты | субагент | codex | фон | сессия <name>`), the drafts a press puts in the prompt box, the
  Stop hook's lines and the guard's messages. Owner words of either language are read under both,
  so a queue written in one draws the same under the other.
- `icons` (task-queue): `plain` (the default) uses ordinary Unicode any font draws (`✻` Claude,
  `◆` Codex, `★` you, `◎` subagent, `$` background shell, `⇄` other session, `⏸` a cold session's
  row). `plimsoll` draws the owner column and the model mark with the glyphs of
  [plimsoll](https://github.com/Tigeneric/plimsoll)'s icon font and Nerd Font symbols.

## Optional companions

The pane works without these. Each one adds a press:

| With | You get | Without it |
|---|---|---|
| [cmux](https://cmux.dev) and tabfolk (`$TABFOLK_ROOT`, not yet published) | A press on a session's name switches to its tab; the `/compact` press types `/compact <text>` into that session's prompt, unsent | The name press does nothing; the compact text goes to the clipboard |
| macOS `pbcopy` and `open` | The clipboard fallback above | The toast says nothing was copied and points at the ready file |
| Apple's `fm` CLI (Foundation Models, on-device) | A short line each companion session's character says | The line is left out |
| `stale-cache-guard` | The `cold · free` box: who would be blocked, the wake-up cost and the button | The box is absent |

## How task-queue works

The queue is a JSON file per session, `~/.claude/task-queues/<session id>.json`. Claude changes it
only through `bin/queue --file … add|start|done|wait|fail|park|unpark|set|phase|note|ask|answer|why|coordinator|show`,
one call per change; the pane reads the file.

- `/queue` opens the pane. On an empty queue it then sends Claude one prompt to fill it from what
  the session is doing. A kept queue is shown as it stands; a second `/queue` with the pane open
  asks Claude to bring it up to date. So a session resumed after a restart is not woken, over a
  cache that may have expired, just to open its pane.
- **Owners.** Each task has an owner, drawn as an icon explained in a legend under the list. A task
  owned by another session (`session <name>`) shows the name in a colour of its own. `queue add` and
  `queue set` warn when such an owner is not one session's name (`session X → operator`); a trailing
  badge is fine.
- **Companions.** Sessions working side by side under one coordinator are its companions; the pane
  folds them into a `companions` box with one sign of state each.
- **Context fill.** `bin/contexts` reads each live session's transcript tail for its context fill
  (the window is taken as 1M; `QUEUE_CONTEXT_WINDOW` overrides). Sessions at 80 % or more, or ready,
  are listed in a `/compact` box.
- **Compact readiness.** A session at a clean point writes its `/compact` argument to
  `~/.claude/task-queues/compact-ready/<name>.txt`, which marks it ready (✓). A press drafts the
  compact into that session (see optional companions); `bin/contexts` removes the file once the
  transcript shows a compact newer than it. Past 80 % with no file, the Stop hook tells the session
  where to write it, once per five points (`bin/compactready`).
- **Unqueued questions.** `bin/unasked` tells the Stop hook whether the turn ended on a question to
  the owner that no `queue ask` or `queue answer` of the same turn put into the queue; if so, the turn
  is sent back once with one line.
- **Coordinator mode.** `queue coordinator on` marks the queue as a coordinator's. Then each Stop of
  that session runs `bin/stalls --coordinator` and sends the turn back with its report: sessions idle
  15–55 min with a live task, or idle with waiting tasks of their own. Parked and question-blocked
  tasks never count; a reason recorded with `queue why NAME TEXT` is shown and silences nothing. Each
  report is told once, until it changes. The check runs only when the coordinator itself stops, so a
  background `stalls --file QUEUE --wait` (polls every 60 s, exits on the first new report) is what
  wakes a coordinator with no turns of its own; SessionStart tells a coordinator to launch it, and
  the Stop hook says once when none is running. The hook itself launches nothing.
- **Cold and free sessions.** With `stale-cache-guard` installed, a `cold · free` box lists sessions
  the guard would block, with the wake-up cost as a button and a sign (`?` asked, `⏸` parked,
  `▶` allowed), and sessions with no live task. Beside a cold session's wake-up sits its other way
  back, `compact`: it re-reads the expired context once and the session then works from the summary,
  so it pays off when the session has more work ahead. A cold session cannot write its own argument
  without waking, so `queue compact-for NAME TEXT [--by WHO]` writes it for it. A session that is only
  idle with 200k or more is offered the compact too, while its cache is warm and the re-read costs a
  tenth.

## How stale-cache-guard works

- It blocks a prompt to a session idle for over an hour with 400k tokens or more of context, once
  (`UserPromptSubmit`). Sending it again within 10 minutes goes through. A prompt that starts with
  `/compact` is never blocked, since compacting is the cheaper way out.
- It denies a `SendMessage` to such a session (`PreToolUse`): the receiving guard would block it
  while the sender was told it had been delivered.
- It lets one message through, on both sides, within 10 minutes of your
  `python3 -I …/stale-cache-guard.py --allow NAME` (run it with `!`), or of the pane's wake-up press.
- `--status` prints every live session's idle time and whether it is cold.

## Developing

Clone the repository and point Claude Code at it as a directory marketplace:

```json
"extraKnownMarketplaces": { "task-queue": { "source": { "source": "directory", "path": "/path/to/task-queue" } } },
"enabledPlugins": { "task-queue@task-queue": true, "stale-cache-guard@task-queue": true }
```

`make test` runs the Python and shell tests (CI runs it on macOS). `make check` adds what needs the
`claude` CLI: the pane's tests (`claude plugin test`) and manifest validation.

## Licence

MIT, see [LICENSE](LICENSE).
