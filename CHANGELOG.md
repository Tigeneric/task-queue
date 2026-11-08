# Changelog

Versions follow [semantic versioning](https://semver.org). Both plugins share one version, kept in
their `plugin.json` and in the git tag; a release is a section here, the version in both manifests
and `git tag vX.Y.Z`.

## 0.4.1 — 2026-11-08

### stale-cache-guard

- The language test finds Cyrillic by code point. It used `grep '[А-я]'`, which in the C locale of
  a CI runner compares bytes and took `⏸` and `≈` in the English messages for Russian, so the first
  CI run failed. The plugins themselves are unchanged.

## 0.4.0 — 2026-11-08

The first public release; versions before 0.4.0 were used privately and never published.

### task-queue

- A live pane beside the chat, opened with `/queue`: the session's tasks by status, open questions,
  the phase, and a legend of who owns what.
- `bin/queue`, the CLI Claude keeps the queue through, one call per change.
- `/queue` asks Claude to fill an empty queue; a kept one it refreshes only when the pane is
  already open, so opening the pane in a resumed session wakes nothing.
- Companion sessions: tasks owned by another session, drawn in a colour of their own, folded into a
  `companions` box with one sign of state each.
- Context fill of each live session, and a `/compact` box for sessions at 80 % or ready, with a
  press that drafts the compact into that session (with cmux and tabfolk) or copies it.
- Coordinator mode: the Stop hook reports companions idle with work left, each report once.
- The Stop hook sends a turn back once when it ended on a question that never reached the queue,
  and tells a session past 80 % where to write its compact argument.
- With `stale-cache-guard` installed, a `cold · free` box with the wake-up cost, a wake-up press and
  a compact as the other way back.
- Options: `language` (`en`, the default, or `ru`) and `icons` (`plain`, the default, or
  `plimsoll`).

### stale-cache-guard

- Blocks, once, a prompt that would re-write a large expired prompt cache; `/compact` always passes.
- Denies a `SendMessage` to such a session, and lets one message through on the owner's `--allow`.
- `--status` for every live session's idle time and whether it is cold.
- Option: `language` (`en`, the default, or `ru`).
