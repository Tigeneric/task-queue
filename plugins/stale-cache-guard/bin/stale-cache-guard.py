#!/usr/bin/env python3
"""UserPromptSubmit: stop a prompt that would re-send a large context whose cache has expired.

The main conversation's prompt cache lives 1 hour. After a longer break the next prompt
writes the whole context to cache again at 2x the input price — for a ~900k session that is
~1.8M input-equivalent tokens before any work is done. The hook blocks the first such prompt once (exit 2:
Claude Code erases it, so it is echoed back on stderr); sending it again within GRACE
goes through. Any error lets the prompt through.

The same check guards the other side. As a PreToolUse hook on SendMessage it
finds the recipient session (by socket /tmp/cc-socks/<pid>.sock or by name) and denies the
send when the recipient's cache has expired: the receiving guard would block the message
anyway, while SendMessage reports success, so the sender never learned it was lost. A
resend alone never passes: one send within GRACE passes only after the owner runs
`--allow NAME` (with `!`; agents are denied that command in settings.json). `--status` prints, for every live
session, its idle time and whether it is cold; the task-queue pane marks cold sessions ⏸.

Test: tests/test-stale-cache-guard.sh (next to bin/ in this plugin)
"""
import glob, json, os, re, sys, time
from datetime import datetime

IDLE = 3600          # main-conversation cache TTL
MIN_CTX = 400_000    # tokens; below this a re-write is cheap enough
GRACE = 600          # a resend within 10 min goes through
STATE = os.environ.get('GUARD_STATE', os.path.expanduser('~/.claude/state/stale-cache-guard'))
SESSIONS = os.environ.get('GUARD_SESSIONS', os.path.expanduser('~/.claude/sessions'))
PROJECTS = os.environ.get('GUARD_PROJECTS', os.path.expanduser('~/.claude/projects'))
TAIL = 3 * 1024 * 1024  # the last call is near the end; the whole file only when the tail has none
# What the guard says, by the plugin's `language` option, which Claude Code hands its hooks as
# CLAUDE_PLUGIN_OPTION_LANGUAGE; English when unset (the owner's own --allow at a shell).
TEXT = {
    'ru': {
        'no_peer': "нет живой сессии «{name}»",
        'allowed': "{name}: одна отправка разрешена на {grace} мин",
        'deny': ("⏸ {name}: кеш истёк ({idle_min:.0f} мин без вызовов), контекст {ctx_k:.0f}k. "
                 "Сообщение разбудит сессию и перезапишет ≈{rewrite:.1f}M токенов (её хук его ещё и заблокирует). "
                 "Спроси владельца (повтор без него снова будет отклонён). Согласие — нажатие «wake-up» в окне "
                 "cold панели /queue или команда владельца "
                 "`! python3 -I {guard} --allow '{name}'`; "
                 "после него одна отправка в течение {grace} мин пройдёт. Запускать эту команду агенту нельзя. "
                 "Самостоятельную задачу отдай субагенту."),
        'block': ("⏸ Кеш этой сессии истёк ({idle_h:.1f} ч без вызовов), контекст {ctx_k:.0f}k.\n"
                  "Следующее сообщение запишет его заново: ≈{rewrite:.1f}M токенов в пересчёте на вход.\n"
                  "Дешевле: /compact здесь (проходит сразу) или новая сессия с коротким вводным. Отправьте сообщение ещё раз в течение "
                  "{grace} мин, чтобы продолжить здесь.\n\nВаш текст:\n{prompt}"),
    },
    'en': {
        'no_peer': 'no live session "{name}"',
        'allowed': "{name}: one send allowed for {grace} min",
        'deny': ("⏸ {name}: its cache has expired ({idle_min:.0f} min without calls), context {ctx_k:.0f}k. "
                 "The message would wake the session and re-write ≈{rewrite:.1f}M tokens (and its own hook would block it too). "
                 "Ask the owner (a resend without them is denied again). The owner says yes with the wake-up press in the "
                 "cold box of the /queue pane or with the command "
                 "`! python3 -I {guard} --allow '{name}'`; "
                 "after it one send within {grace} min goes through. An agent must not run that command. "
                 "Hand a self-contained task to a subagent."),
        'block': ("⏸ This session's cache has expired ({idle_h:.1f} h without calls), context {ctx_k:.0f}k.\n"
                  "The next message writes it again: ≈{rewrite:.1f}M input-equivalent tokens.\n"
                  "Cheaper: /compact here (it goes through at once) or a new session with a short brief. Send the message again within "
                  "{grace} min to go on here.\n\nYour text:\n{prompt}"),
    },
}


def say(key, **values):
    lang = os.environ.get('CLAUDE_PLUGIN_OPTION_LANGUAGE', 'en')
    return TEXT.get(lang, TEXT['en'])[key].format(grace=GRACE // 60, **values)


def _scan(lines):
    """(seen, last): seen = a call or a compact boundary occurred; last as in last_context."""
    seen, last = False, None
    for line in lines:
        if '"usage"' not in line and 'compact_boundary' not in line:
            continue
        try:
            d = json.loads(line)
        except ValueError:
            continue
        if d.get('subtype') == 'compact_boundary':
            seen, last = True, None
            continue
        u = (d.get('message') or {}).get('usage')
        if d.get('type') != 'assistant' or not u or d.get('isSidechain'):
            continue
        ctx = sum(u.get(k, 0) or 0 for k in ('input_tokens', 'cache_read_input_tokens', 'cache_creation_input_tokens'))
        ts = datetime.fromisoformat(d['timestamp'].replace('Z', '+00:00')).timestamp()
        seen, last = True, (ts, ctx)
    return seen, last


def last_context(path):
    """(timestamp, context tokens) of the last main-thread API call; None after a compact boundary."""
    size = os.path.getsize(path)
    with open(path, 'rb') as f:
        f.seek(max(0, size - TAIL))
        lines = f.read().decode('utf-8', 'replace').splitlines()
    if size > TAIL:
        lines = lines[1:]  # the first line is cut
    seen, last = _scan(lines)
    if not seen and size > TAIL:
        with open(path, errors='ignore') as f:
            seen, last = _scan(f)
    return last


def cold(path, now):
    """(idle seconds, context) when re-sending this transcript would re-write an expired cache."""
    last = last_context(path)
    if not last:
        return None
    ts, ctx = last
    idle = now - ts
    return (idle, ctx) if idle >= IDLE and ctx >= MIN_CTX else None


def bare(name):
    return ''.join(ch for ch in name if ch.isalnum() or ch in " '-").strip()


def transcript(cwd, sid):
    """Under the slug of the session's cwd, or, for a session that has moved since it started (the
    transcript stays under the first directory's slug), wherever its id is."""
    path = os.path.join(PROJECTS, cwd.replace('/', '-').replace('.', '-'), sid + '.jsonl')
    if os.path.isfile(path):
        return path
    found = glob.glob(os.path.join(PROJECTS, '*', glob.escape(sid) + '.jsonl'))
    return found[0] if found else path


def sessions():
    for meta in glob.glob(os.path.join(SESSIONS, '*.json')):
        try:
            s = json.load(open(meta))
        except (OSError, ValueError):
            continue
        if s.get('name') and s.get('sessionId') and s.get('cwd'):
            s['pid'] = os.path.basename(meta)[:-5]
            s['transcript'] = transcript(s['cwd'], s['sessionId'])
            yield s


def find_peer(to):
    m = re.search(r'/(\d+)\.sock$', to)
    want = re.sub(r'\s*\[[^\]]*\]$', '', to)
    for s in sessions():
        if (m and s['pid'] == m.group(1)) or (not m and bare(s['name']) == bare(want)):
            return s
    return None


def passes_once(key, now):
    """True when the same blocked action is repeated within GRACE (and clears the mark)."""
    marker = os.path.join(STATE, key)
    try:
        if now - os.path.getmtime(marker) < GRACE:
            os.remove(marker)
            return True
    except OSError:
        pass
    os.makedirs(STATE, exist_ok=True)
    open(marker, 'w').close()
    os.utime(marker, (now, now))
    return False


def allowed(sid, now):
    """One send to this session within GRACE of the owner's --allow (the mark is used up)."""
    marker = os.path.join(STATE, 'allow-' + sid)
    try:
        if now - os.path.getmtime(marker) < GRACE:
            os.remove(marker)
            # The receiving session's own guard must let this message in too, or it blocks the
            # very wake the owner allowed: hand it a mark of its own.
            woken = os.path.join(STATE, 'woken-' + sid)
            open(woken, 'w').close()
            os.utime(woken, (now, now))
            return True
    except OSError:
        pass
    return False


def woken(sid, now):
    """This session was woken on the owner's mark within GRACE (the mark is used up)."""
    marker = os.path.join(STATE, 'woken-' + sid)
    try:
        if now - os.path.getmtime(marker) < GRACE:
            os.remove(marker)
            return True
    except OSError:
        pass
    return False


def allow(name, now):
    """The owner's yes: let one message wake this session within GRACE."""
    peer = find_peer(name)
    if not peer:
        print(say('no_peer', name=name), file=sys.stderr)
        return 1
    os.makedirs(STATE, exist_ok=True)
    marker = os.path.join(STATE, 'allow-' + peer['sessionId'])
    open(marker, 'w').close()
    os.utime(marker, (now, now))
    print(say('allowed', name=bare(peer['name'])))
    return 0


def guard_send(hook, now):
    """PreToolUse SendMessage: deny a message that would wake a cold session."""
    inp = hook.get('tool_input') or {}
    if not inp.get('message'):  # a pure idle subscription costs the recipient nothing
        return 0
    peer = find_peer(inp.get('to', ''))
    if not peer or not os.path.isfile(peer['transcript']):
        return 0
    c = cold(peer['transcript'], now)
    if not c or allowed(peer['sessionId'], now):
        return 0
    idle, ctx = c
    reason = say('deny', name=bare(peer['name']), idle_min=idle / 60, ctx_k=ctx / 1000, rewrite=ctx * 2 / 1e6,
                 guard=os.path.abspath(__file__))
    print(json.dumps({'hookSpecificOutput': {'hookEventName': 'PreToolUse', 'permissionDecision': 'deny',
                                             'permissionDecisionReason': reason}}, ensure_ascii=False))
    return 0


def status(now, only=None):
    """Every live session, or only the named ones (bare names)."""
    out = {}
    for s in sessions():
        if only and bare(s['name']) not in only:
            continue
        try:
            last = last_context(s['transcript'])
        except OSError:
            continue
        if last:
            idle, ctx = now - last[0], last[1]
            entry = {'idle_s': round(idle), 'tokens': ctx, 'cold': idle >= IDLE and ctx >= MIN_CTX}
            try:  # the owner's --allow, not yet used up
                if now - os.path.getmtime(os.path.join(STATE, 'allow-' + s['sessionId'])) < GRACE:
                    entry['allowed'] = True
            except OSError:
                pass
            out[bare(s['name'])] = entry
    print(json.dumps(out, ensure_ascii=False))
    return 0


def main():
    now = float(os.environ.get('GUARD_NOW', time.time()))
    if sys.argv[1:2] == ['--status']:
        return status(now, set(sys.argv[2:]) or None)
    if len(sys.argv) == 3 and sys.argv[1] == '--allow':
        return allow(sys.argv[2], now)
    hook = json.load(sys.stdin)
    if hook.get('tool_name') == 'SendMessage':
        return guard_send(hook, now)
    # /compact is the cheap way out the message below names: it re-reads the context once and
    # then works from the summary, so blocking it would only make the owner type it twice.
    if hook.get('prompt', '').lstrip().startswith('/compact'):
        return 0
    c = cold(hook['transcript_path'], now)
    if not c or woken(hook['session_id'], now) or passes_once(hook['session_id'], now):
        return 0
    idle, ctx = c
    print(say('block', idle_h=idle / 3600, ctx_k=ctx / 1000, rewrite=ctx * 2 / 1e6, prompt=hook.get('prompt', '')),
          file=sys.stderr)
    return 2


if __name__ == '__main__':
    try:
        sys.exit(main())
    except Exception:
        sys.exit(0)
