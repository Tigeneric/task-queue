import type { EngineInterface, Register } from 'claude-code'

import type { Queue, Task } from '../types'

// Each session keeps its own queue at ~/.claude/task-queues/<session id>.json. Claude
// writes it through bin/queue (the prompt.compose section below says how); the pane reads it on every
// draw and is redrawn after each tool call and on a timer.
const PANE = 'task-queue'
const COMMAND = 'queue' // not `tasks`: that one is Claude Code's own background-task list
const SHOWN = { plugin: 'task-queue', key: 'isShown' } as const
const EXPANDED = { plugin: 'task-queue', key: 'expanded' } as const

// cmux's terminal theme, Nordfox (cmux.app/Contents/Resources/ghostty/themes/Nordfox),
// so the pane reads as part of the terminal.
const NORD = {
  bg: '#2e3440',
  fg: '#cdcecf',
  green: '#a3be8c',
  yellow: '#ebcb8b',
  blue: '#81a1c1',
  magenta: '#b48ead',
  cyan: '#88c0d0',
  red: '#bf616a',
  muted: '#53648d',
  orange: '#d08770',
  ice: '#88c0d0',   // the NOW line's cyan
  faint: '#4c566a', // nord3: leaders and other marks meant to recede
}

// Who does a task, by the first word that names them: an icon in the row, explained
// once in the legend under the list. Single-width glyphs, so the column stays aligned.
// Claude and Codex are the marks of plimsoll's icon font (github.com/Tigeneric/plimsoll),
// which Ghostty draws at U+E900-E9A9 through font-codepoint-map: whole glyphs at
// U+E900 + index, Fable, Opus, Sonnet, Haiku, then Codex at U+E904.
// You, subagent, background job and other session are Nerd Font symbols (md-crown,
// fa-users, oct-terminal, fa-handshake-o), which Ghostty carries built in.
type Role = { icon: string; label: string; color?: string }

// The owner words, read in both languages whichever the `language` option picks, so a queue
// written in one draws the same under the other. A Russian word is read as a prefix, as it
// always was; an English one must end there (`mentor` is not `me`).
const OWNER_WORDS = {
  me: /^(я|me(?![a-z]))/iu,
  you: /^(ты|you(?![a-z]))/iu,
  subagent: /^(субагент|subagent(?![a-z]))/iu,
  codex: /^codex/iu,
  bg: /^(фон|bg(?![a-z]))/iu,
  session: /^(сессия|session(?![a-z]))/iu,
}
const isSession = (owner: string) => OWNER_WORDS.session.test(owner.trim())

// The glyphs, by the `icons` option. `plimsoll` (the default) is the set above: private-use
// code points that only plimsoll's "Statusline Icons" font and a Nerd Font draw. `plain` is
// ordinary Unicode every terminal font has, single-width like the rest, so the column holds.
// `claude` is indexed by MODEL_MARKS (Fable, Opus, Sonnet, Haiku); `cold` is the tile a row's
// owner becomes when its session's cache has expired.
type Icons = { claude: readonly string[]; codex: string; you: string; subagent: string; bg: string; session: string; cold: string }
const ICONS: Record<'plimsoll' | 'plain', Icons> = {
  plimsoll: {
    claude: ['\uE900', '\uE901', '\uE902', '\uE903'],
    codex: '\uE904',
    you: '\u{F01A5}',
    subagent: '\uF0C0',
    bg: '\uF489',
    session: '\uF2B5',
    // plimsoll's session tile (U+E905, Statusline Icons 10): the handshake cut out of a rounded
    // square like the model marks.
    cold: '\uE905',
  },
  plain: {
    claude: ['✻', '✻', '✻', '✻'],
    codex: '◆',
    you: '★',
    subagent: '◎',
    bg: '$',
    session: '⇄',
    cold: '⏸',
  },
}

function rolesOf(icons: Icons): { word: RegExp; role: Role }[] {
  return [
    { word: OWNER_WORDS.you, role: { icon: icons.you, label: 'you', color: NORD.yellow } },
    { word: OWNER_WORDS.subagent, role: { icon: icons.subagent, label: 'subagent', color: NORD.magenta } },
    { word: OWNER_WORDS.codex, role: { icon: icons.codex, label: 'Codex', color: NORD.blue } },
    { word: OWNER_WORDS.bg, role: { icon: icons.bg, label: 'background shell', color: NORD.green } },
    { word: OWNER_WORDS.session, role: { icon: icons.session, label: 'other session', color: NORD.cyan } },
  ]
}

// What the person and Claude read, by the `language` option: the owner words Claude is told,
// the drafts a press puts in the prompt box, the text a compact press copies. The pane's own
// labels are English in both. Task data is never translated.
type Lang = 'ru' | 'en'
const WORDS = {
  ru: {
    cliLang: ' --lang ru',
    who: 'я (default) | ты | субагент … | codex … | фон (a background shell job) | сессия <name> (another Claude session)',
    session: 'сессия <name>',
    finding: 'находка 12',
    nudge: '«ты в простое N мин с задачей #n — продолжай или скажи, что мешает», or «…, следующие: #6, #7 — бери следующую»',
    aboutTask: (n: number, task: string) => `Про #${n} «${task}»: `,
    aboutQuestion: (q: string) => `Про вопрос «${q}»: `,
    answer: (q: string) => `Ответ на «${q}»: `,
    wake: (name: string, ids: string) => `${name}: разбудить — отправь отложенное${ids ? ` (${ids})` : ''}; разрешение действует 10 мин`,
    afterCompact: 'После compact: одной строкой сообщи координатору, что compact готов и с чего начинаешь.',
    compactAskWarm: (name: string) => `${name}: бездействует, кеш ещё тёплый — попроси её записать аргумент /compact (с чего продолжить и где заметка) в ~/.claude/task-queues/compact-ready/${name}.txt, пока кеш не истёк; потом кнопка compact в окне cold · free`,
    compactAskCold: (name: string, root: string) => `${name}: кеш истёк — напиши за неё аргумент /compact: \`${root}/bin/queue --lang ru compact-for '${name}' "…"\` (с чего продолжить и где заметка — из её последних сообщений и очереди); потом кнопка compact в окне cold`,
  },
  en: {
    cliLang: '',
    who: 'me (default) | you | subagent … | codex … | bg (a background shell job) | session <name> (another Claude session)',
    session: 'session <name>',
    finding: 'finding 12',
    nudge: '"you have been idle N min with task #n — carry on or say what is in the way", or "…, next: #6, #7 — take the next one"',
    aboutTask: (n: number, task: string) => `About #${n} "${task}": `,
    aboutQuestion: (q: string) => `About the question "${q}": `,
    answer: (q: string) => `Answer to "${q}": `,
    wake: (name: string, ids: string) => `${name}: wake up — send what was held back${ids ? ` (${ids})` : ''}; the permission lasts 10 min`,
    afterCompact: 'After compact: tell the coordinator in one line that the compact is done and what you start with.',
    compactAskWarm: (name: string) => `${name}: idle, its cache still warm — ask it to write its /compact argument (what to resume with and where the note is) to ~/.claude/task-queues/compact-ready/${name}.txt before the cache expires; then the compact button in the cold · free box`,
    compactAskCold: (name: string, root: string) => `${name}: its cache has expired — write its /compact argument for it: \`${root}/bin/queue compact-for '${name}' "…"\` (what to resume with and where the note is, from its last messages and the queue); then the compact button in the cold box`,
  },
} satisfies Record<Lang, unknown>
type Words = (typeof WORDS)[Lang]

const MODEL_MARKS = ['fable', 'opus', 'sonnet', 'haiku']

// The session's own mark is its model's: Opus draws the Opus glyph.
function claudeMark(model: string, icons: Icons): string {
  const i = MODEL_MARKS.findIndex(name => model.toLowerCase().includes(name))
  return icons.claude[Math.max(0, i)] ?? icons.claude[0] ?? ''
}

// Each other session's name is drawn in a colour of its own; its icon stays plain. The
// colours are the terminal theme's (Nordfox's bright palette) plus the two extra hues of the
// Nightfox family it belongs to, orange and pink; red is left out, it marks failures.
// Ordered so the first sessions get the hues farthest apart. They go out in the order
// sessions first appear in the queue (an owner naming two sessions takes none), so a few
// sessions never share one and a session keeps its colour as rows are added.
const SESSION_COLORS = ['#f0d399', '#8cafd2', '#b1d196', '#c895bf', '#93ccdc', '#c9826b', '#bf88bc']

// The bare roster name, by the rule bin/contexts and bin/stalls key sessions by: letters,
// digits, space, ' and -. An owner written with its badge (`сессия Ada🎻`) is the same
// session, and focus wants the name without it.
function sessionName(owner: string): string {
  return [...owner.trim().replace(OWNER_WORDS.session, '')].filter(ch => /[\p{L}\p{N} '-]/u.test(ch)).join('').trim()
}

// An owner naming two sessions (`сессия «A» + «B»`) is no one session's row.
function isOneSession(owner: string): boolean {
  return isSession(owner) && sessionName(owner) !== '' && !/[+«»]/.test(owner)
}

// Cmd+click on a session's name switches cmux to its tab, as names do in the chat:
// tabfolk://focus/<bare roster name>, percent-encoded (' too, which encodeURIComponent keeps).
function focusUrl(name: string): string {
  return `tabfolk://focus/${encodeURIComponent(name).replace(/'/g, '%27')}`
}

// Puts `/compact <text>` into another session's prompt in cmux, unsent. Returns true, or why not.
// The session's workspace and panel come from tabfolk (focus.py --print-surface, the resolver
// its tabfolk://focus links use); TABFOLK_ROOT overrides where tabfolk lives.
// Shape, measured 2026-10-22 on a throwaway claude 2.1.296 session: a pasted
// `/compact <text>` of ~250 bytes ran as the command, but one of ~2 KB collapsed
// to [Pasted text #n] and went to the model as a prompt. Typing `/compact ` and then pasting
// the argument ran the compact at both sizes. `cmux send` refuses a prompt that already holds
// text, so the owner's draft is never touched; the paste after it needs --force, since by then
// the prompt holds our own `/compact `.
async function draftCompact($: EngineInterface, name: string, text: string): Promise<true | string> {
  const root = (await $.env.get('TABFOLK_ROOT')) || `${(await $.env.get('HOME')) ?? ''}/projects/tabfolk`
  const found = await $.process.run(['/usr/bin/python3', '-I', '-B', `${root}/tabfolk/focus.py`, '--print-surface', name], { timeoutMs: 10000 }).catch(() => undefined)
  const ids = found?.exitCode === 0 ? found.stdout.trim().split(/\s+/) : []
  if (ids.length !== 2) return 'its cmux tab was not found'
  const target = ['--workspace', ids[0], '--surface', ids[1]]
  const typed = await $.process.run(['cmux', 'send', ...target, '--', '/compact ']).catch(() => undefined)
  if (typed?.exitCode !== 0) return /holds text/.test(typed?.stderr ?? '') ? 'its prompt already has text' : 'cmux did not type into it'
  const pasted = await $.process.run(['cmux', 'paste', '--force', ...target, '-'], { stdin: text }).catch(() => undefined)
  return pasted?.exitCode === 0 ? true : 'only /compact got into its prompt'
}

function sessionRole(owner: string, icons: Icons): Role {
  const name = sessionName(owner)
  return { icon: icons.session, label: name || 'other session' }
}

function roleOf(owner: string, mark: string, icons: Icons): Role {
  const o = owner.toLowerCase()
  if (OWNER_WORDS.me.test(o)) return { icon: mark, label: 'Claude', color: NORD.cyan }
  if (OWNER_WORDS.session.test(o)) return sessionRole(owner, icons)
  // `ты/я` and the like: the first name decides.
  return rolesOf(icons).find(one => one.word.test(o))?.role ?? { icon: [...owner][0] ?? '·', label: owner }
}

// `wrap="truncate-end"` does not take inside a Button, so cut by hand.
function cut(text: string, width: number): string {
  const chars = [...text]
  return chars.length <= width ? text : `${chars.slice(0, Math.max(1, width - 1)).join('')}…`
}

async function queuePath($: EngineInterface) {
  const home = (await $.env.get('HOME')) ?? ''
  return `${home}/.claude/task-queues/${await $.session.id()}.json`
}

// Claude keeps the file through bin/queue, one short Bash call per change: writing the
// whole JSON each time cost a thousand or more output tokens. The file is named
// explicitly rather than left to the CLI's CLAUDE_CODE_SESSION_ID default, so the
// pane and the CLI cannot disagree about which session's queue it is.
function instructions(root: string, file: string, w: Words): string {
  const cli = `${root}/bin/queue --file ${file}${w.cliLang}`
  return [
    '# Task queue pane',
    `The person watches a pane of this session's tasks. Keep it current with Bash \`${cli} …\`, one call per change and never by editing the file: when a task is added, starts, finishes or fails, the phase changes, or a question for the person comes up or is answered.`,
    'Commands: `new TITLE [--purpose "what the session is for, one or two sentences"]` (first); `add TASK [--owner WHO] [--status active]` (prints #n; a short label); `start|done|wait|fail N...`; `park|unpark N...` (a task left for later on purpose, or one of a cold session the owner chose not to wake: shown ⏸, never reported idle); `set N [--task T] [--owner WHO]`; `phase TEXT` (what is happening now; "" clears); `note TEXT`; `ask QUESTION [--blocks N...]` (prints ?k); `answer K...`; `why NAME TEXT` (why a companion session is idle; "" clears); `coordinator on|off` (see below); `show`.',
    `WHO: ${w.who}.`,
    'Every companion session (another Claude session working beside this one under the same coordinator) that is idle — free, cold or parked — owes a reason the person can read in the cold · free box: record it with `why NAME TEXT` when it goes idle (waiting for a decision, for another session, nothing left for it) and clear it when it gets work.',
    'Compact readiness: once this session\'s context passes 80 %, at the next clean point — no live subagent and no background shell of its own, its work committed, a resume note written to a durable file — write the /compact argument (what to resume with and where the note is) to `~/.claude/task-queues/compact-ready/<your bare roster name>.txt`. That file is what marks the session ready (✓) in the coordinator\'s pane and what its button drafts into your prompt; it is removed after the compact. Ask a session you coordinate to do the same. A coordinated session whose cache has expired cannot write it without being woken, so write it for that session with `queue compact-for NAME TEXT` — from its last messages and its rows here — and the pane offers its compact in place of the wake-up.',
    `In a task's or question's text, \`#n\` refers only to a task of this queue (the pane numbers rows that way); write another numbering without \`#\` — \`N12\`, \`${w.finding}\`, \`ABC-123\` — so a row never reads as two task numbers.`,
    `Once the queue holds tasks of other sessions (\`${w.session}\`), turn coordinator mode on with \`${cli} coordinator on\` (\`off\` when no other session holds a live task). Then each time this session stops, the plugin's Stop hook runs \`${root}/bin/stalls --coordinator\` and sends the turn back with what it found, each report once until it changes: «<name>: N min idle with #n» for a session idle 15–55 min with a live task, and «<name>: N min idle, next: #6, #7» for one idle with waiting rows of its own; a recorded \`why\` is shown beside a report and never silences it. It runs only when this session stops, so while coordinator mode is on also keep a background \`${root}/bin/stalls --file ${file} --wait\` (run_in_background; exits on the first new report — launch it again after each): it is what wakes you during a stretch with no turns of your own, and the Stop hook says once when it is gone. Nudge with one line (${w.nudge}) while its cache is still warm. Waiting on a lock, a run or another session is not a reason to idle while the session has UP NEXT rows of its own; a row deliberately left for later gets \`park\`, and parked or question-blocked rows are never reported.`,
  ].join('\n')
}

// How full each live session's context is, by session name, refreshed every 30 s by
// bin/contexts (transcripts are far over $.fs's 4 MiB read limit, so a script reads their
// tails). A module variable: a reload starts it empty and the next refresh fills it.
type Context = { tokens: number; pct: number; compact?: string; compact_by?: string; cold?: boolean; idle_s?: number; allowed?: boolean; stalled?: boolean }
let contexts: Record<string, Context> = {}
// DONE is folded to its last few rows by default; a press on its header unfolds it. A module
// variable: a reload folds it again.
let doneOpen = false
// UP NEXT rows are cut to one line; a press on the header shows them in full.
let upOpen = false
// Sessions in the cold · free box whose idle reason is unfolded (queue `why NAME TEXT`).
const whyOpen = new Set<string>()
// The companions box under the progress line is folded by default; a press on its button unfolds it.
let companionsOpen = false
// A line each session's character says, drawn by the local fm model (bin/phrase) while the
// companions list is open, shown above the dots of its row; redrawn after PHRASE_TTL.
const phrases = new Map<string, { text: string; at: number }>()
const phraseAsked = new Map<string, number>()
const PHRASE_TTL = 10 * 60 * 1000
const DONE_TAIL = 5
const COMPACT_AT = 80
// An idle session this large is offered a compact while its cache is still warm: then the
// compact re-reads the context at a tenth of the price, against twice that once it has expired.
const COMPACT_IDLE_MIN = 200_000
// Said at every start, so a coordinator resumed after a reboot relaunches the watcher that died with it.
const coordinatorReminder = (root: string, file: string) => `Task queue: coordinator mode is on — launch a background \`${root}/bin/stalls --file ${file} --wait\` now (run_in_background; it wakes you when a session stalls while you are silent, and dies with a reboot); each time this session stops, its Stop hook also reports idle sessions and says once if that watcher is gone. \`queue coordinator off\` ends it.`

// What /queue sends Claude: fill an empty queue from what this session is doing, or bring a kept one up to date.
function refreshPrompt(filled: boolean): string {
  return filled
    ? 'Task queue pane opened: bring the queue up to date through bin/queue, one call per change — task statuses, the phase, open questions for the person — then carry on with what you were doing.'
    : 'Task queue pane opened and the queue is empty: fill it through bin/queue — `new TITLE --purpose …` first, then this session\'s tasks (done, active, up next) and any open question for the person — then carry on with what you were doing.'
}

function idleText(s: number): string {
  const m = Math.round(s / 60)
  return m < 120 ? `${m} min` : m < 48 * 60 ? `${Math.round(m / 60)} h` : `${Math.round(m / 1440)} d`
}

async function refreshContexts($: EngineInterface): Promise<void> {
  try {
    const { exitCode, stdout } = await $.process.run([`${$.plugin.root}/bin/contexts`, '--queue', await queuePath($)], { timeoutMs: 20000 })
    if (exitCode === 0) contexts = JSON.parse(stdout) as Record<string, Context>
  } catch {
    // a failed read keeps the last numbers
  }
}

export const register: Register = (on, options) => {
  const w: Words = WORDS[options.language === 'ru' ? 'ru' : 'en']
  const icons: Icons = ICONS[options.icons === 'plimsoll' ? 'plimsoll' : 'plain']

  on('session.start', async ($, e, next) => {
    // A reload runs session.start again while the command is still registered: that
    // throw must not skip the pane and the timer below.
    await $.command.register({ name: COMMAND, description: 'Show the task queue pane' }).catch(() => {})
    const { value: isShown } = await $.state.get(SHOWN)
    if (isShown) void $.ui.open({ id: PANE, title: 'Task queue' })
    // Redraw when the queue file changes (checked every 3 s by its stamp, a cheap stat), and once
    // a minute for the idle minutes and the companion lines; a full redraw every 3 s was the pane's cost.
    let stamp = ''
    $.clock.every(3000, async () => {
      const st = await $.fs.stat(await queuePath($)).catch(() => undefined)
      const now = st ? `${st.mtimeMs}:${st.size}` : 'none'
      if (now !== stamp) {
        stamp = now
        $.ui.invalidate('ui.render')
      }
    })
    $.clock.every(60000, () => $.ui.invalidate('ui.render'))
    void refreshContexts($)
    $.clock.every(30000, () => { void refreshContexts($).then(() => $.ui.invalidate('ui.render')) })

    return next(e)
  })

  // A coordinator queue is named once at start, so a session resumed after a reboot relaunches its
  // watcher; the hook itself launches nothing.
  on('classic.SessionStart', async ($, e, next) => {
    const result = await next(e)
    const path = await queuePath($).catch(() => '')
    const coordinating = await (async () => {
      if (!path || !(await $.fs.exists(path))) return false
      return (JSON.parse(await $.fs.read(path)) as Queue).coordinator === true
    })().catch(() => false)
    if (!coordinating) return result
    return { ...result, additionalContext: [...(result.additionalContext ?? []), coordinatorReminder($.plugin.root, path)] }
  })

  on('command.run', { command: COMMAND }, async $ => {
    const wasOpen = (await $.ui.panes().catch(() => [])).some(pane => pane.id === PANE && pane.isPlaced)
    await $.state.set(SHOWN, true)
    await $.ui.open({ id: PANE, title: 'Task queue' })
    $.ui.invalidate('ui.render')

    // An empty queue is always filled: before /queue the instructions are not in Claude's prompt,
    // so a session's first pane was empty until somebody asked in words. A kept queue is refreshed
    // only by a second /queue with the pane open: the first one, typically in a session resumed
    // after a restart, shows it as it stands rather than wake Claude over a cache that may be cold.
    const path = await queuePath($)
    const filled = await (async () => (await $.fs.exists(path)) && ((JSON.parse(await $.fs.read(path)) as Queue).tasks ?? []).length > 0)().catch(() => false)
    // Not from here: a submit inside command.run would wait on the turn this hook holds.
    if (!filled || wasOpen) $.clock.after(0, () => void $.prompt.submit({ text: refreshPrompt(filled) }).catch(() => {}))

    return { text: `Task queue pane opened; Claude keeps ${await queuePath($)}.` }
  })

  // A turn that ends on a question to the person not put in the queue is sent back once:
  // the instruction alone was broken while in context. bin/unasked decides (exit 1 and its
  // one line); it is silent without a queue, on any error, and on the second Stop.
  on('classic.Stop', async ($, e, next) => {
    const result = await next(e)
    if (result.block) return result
    const line = await (async () => {
      // The final text rides the Stop input: the transcript may not hold it yet when Stop fires.
      const argv = ['python3', '-I', `${$.plugin.root}/bin/unasked`, '--transcript', e.transcript_path, '--file', await queuePath($), '--last-message-stdin']
      if (e.stop_hook_active) argv.push('--stop-hook-active')
      if (w.cliLang) argv.push('--lang', 'ru')
      const r = await $.process.run(argv, { stdin: e.last_assistant_message ?? '' })
      return r.exitCode === 1 ? r.stdout.trim() : ''
    })().catch(() => '')  // a failing check never holds a turn
    if (line) return { ...result, block: line }
    // Coordinator mode (`queue coordinator on`): the sessions this one coordinates that sit idle
    // with work, as bin/stalls reports them, each told once until it changes (bin/stalls keeps
    // what it told beside the queue), and once when no background `stalls --wait` watches this
    // queue: that watcher wakes a silent coordinator, the hook only one that stops.
    const stalled = await (async () => {
      const r = await $.process.run(['python3', '-I', `${$.plugin.root}/bin/stalls`, '--file', await queuePath($), '--coordinator'], { timeoutMs: 20000 })
      return r.exitCode === 1 ? r.stdout.trim() : ''
    })().catch(() => '')
    if (stalled) return { ...result, block: stalled }
    // A session past the /compact threshold that has not said what to resume with is told the
    // file once per five points (bin/compactready decides); it runs with or without a queue.
    const compact = await (async () => {
      const argv = ['python3', '-I', `${$.plugin.root}/bin/compactready`, '--transcript', e.transcript_path, '--session-id', await $.session.id()]
      if (e.stop_hook_active) argv.push('--stop-hook-active')
      if (w.cliLang) argv.push('--lang', 'ru')
      const r = await $.process.run(argv)
      return r.exitCode === 1 ? r.stdout.trim() : ''
    })().catch(() => '')
    return compact ? { ...result, block: compact } : result
  })

  // Until the pane is asked for, the session pays nothing for it.
  on('prompt.compose', async ($, e, next) => {
    const result = await next(e)
    const { value: isShown } = await $.state.get(SHOWN)
    if (!isShown || e.traits.includes('teammate') || e.traits.includes('analysis')) return result

    return {
      sections: [
        ...result.sections,
        { id: 'task-queue:instructions', text: instructions($.plugin.root, await queuePath($), w), scope: 'session' as const },
      ],
    }
  })

  on('tool.call', async ($, e, next) => {
    const result = await next(e)
    $.ui.invalidate('ui.render')

    return result
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text, Button } = $.ui.resolve(e)
    // A press puts a ready start of a message in the prompt box, after what is typed.
    const draft = (text: string) => async () => {
      const box = await $.prompt.read()
      await $.prompt.fill(box.text.trim() ? { text: `\n${text}`, mode: 'append' } : { text, mode: 'replace' })
    }
    // /btw only works at the start of the box, so it goes first and what was typed follows.
    const btw = (text: string) => async () => {
      const box = await $.prompt.read()
      await $.prompt.fill({ text: `/btw ${text}${box.text.trim()}`, mode: 'replace' })
    }
    const toggle = (n: number) => async () => {
      const { value = [] } = await $.state.get(EXPANDED)
      await $.state.set(EXPANDED, value.includes(n) ? value.filter(one => one !== n) : [...value, n])
    }
    // The body is a window over the tree, sized to the tree: height="100%" stops at the
    // last row. Docked, stretch the tree to the window's rows so the colour reaches the bottom.
    const frame = {
      flexDirection: 'column' as const,
      paddingX: 1,
      paddingY: 1,
      minHeight: e.props.placement === 'dock' ? e.props.scroll.bodyRows : undefined,
    }

    const path = await queuePath($)
    if (!(await $.fs.exists(path))) {
      return (
        <Box {...frame} backgroundColor={NORD.bg}>
          <Text bold>Task queue</Text>
          <Box marginTop={1}>
            <Text dimColor>Queue empty — Claude fills {path}</Text>
          </Box>
        </Box>
      )
    }

    let q: Queue
    try {
      q = JSON.parse(await $.fs.read(path)) as Queue
    } catch (err) {
      return (
        <Box {...frame} backgroundColor={NORD.bg}>
          <Text color={NORD.red}>queue: {err instanceof Error ? err.message : String(err)}</Text>
        </Box>
      )
    }

    const tasks = q.tasks ?? []
    // A question written by hand as a plain string is its text.
    const questions = (q.questions ?? []).map(one => (typeof one === 'string' ? { q: one } : one))
    const active = tasks.filter(t => t.status === 'active' || t.status === 'failed')
    const upcoming = tasks.filter(t => t.status === 'waiting')
    const done = tasks.filter(t => t.status === 'done')
    const barLen = 20
    const filled = tasks.length ? Math.round((done.length / tasks.length) * barLen) : 0
    const { value: expanded = [] } = await $.state.get(EXPANDED)
    // Row: padding 2, number 3, owner icon padded to a 2-cell target, a cell between.
    // The number column grows with the largest number, plus a cell before the text.
    const numWidth = Math.max(3, String(Math.max(0, ...tasks.map(t => t.n))).length + 1)
    const taskWidth = Math.max(8, e.props.bodyColumns - 5 - numWidth)
    const mark = claudeMark(await $.session.model(), icons)
    const roles = [...new Map(tasks.map(t => roleOf(t.owner, mark, icons)).map(r => [r.icon, r.icon === icons.session ? { ...r, label: 'other session' } : r])).values()]

    const section = (label: string, color: string | undefined, count: number) => (
      <Box marginTop={1}>
        <Text bold color={color}>{label}</Text>
        <Text dimColor> {count}</Text>
      </Box>
    )

    // Three press zones, since a press carries no modifier keys: the number asks a side
    // question (/btw), the text starts a message about the task, the owner unfolds a cut
    // name. Tasks in work always show in full.
    // A row whose text opens with its session's name shows the name in that session's colour.
    const sessionNames = [...new Set(tasks.filter(t => isOneSession(t.owner)).map(t => sessionName(t.owner)))]
    const nameColor = (name: string) => SESSION_COLORS[sessionNames.indexOf(name) % SESSION_COLORS.length]
    const leadName = (t: Task, text: string): string | undefined => {
      if (!isSession(t.owner)) return undefined
      const name = sessionName(t.owner)
      return name && text.startsWith(name) ? name : undefined
    }
    const named = (t: Task, text: string) => {
      if (!isSession(t.owner)) return text
      const name = sessionName(t.owner)
      if (!name || !text.startsWith(name)) return text
      return [<Text key="name" color={nameColor(name)} bold>{name}</Text>, text.slice(name.length)]
    }

    // A press on a session's name switches cmux to its tab, as a name does in the chat.
    const focus = (name: string) => () => { void $.process.run(['open', focusUrl(name)]).catch(() => {}) }

    // A session is listed for /compact when it is past the threshold or has said it is ready.
    const needsCompact = (n: string) => (contexts[n]?.pct ?? 0) >= COMPACT_AT || contexts[n]?.compact !== undefined
    // The press drafts `/compact <its text>` into that session's prompt in cmux, without Enter,
    // and switches to its tab: the command has to run there, and $.prompt reaches only this
    // session's box. The session reports back after the compact, so the coordinator knows it
    // is working again; its ready file is removed by bin/contexts once the transcript shows it.
    const copyCompact = (n: string) => async () => {
      const text = `${(contexts[n]?.compact ?? '').trim()}\n\n${w.afterCompact}`
      const drafted = await draftCompact($, n, text)
      // Without cmux and tabfolk, the way by hand: the argument on the clipboard (macOS pbcopy),
      // `/compact ` typed by the owner; with no clipboard either, the ready file holds the text.
      const copied = drafted !== true && (await $.process.run(['pbcopy'], { stdin: text }).catch(() => undefined))?.exitCode === 0
      void $.process.run(['open', focusUrl(n)]).catch(() => {})
      $.ui.toast(drafted === true
        ? `${n}: /compact draft is in its prompt — check it, then Enter`
        : copied
          ? `${n}: ${drafted}; copied instead — type /compact and a space, then paste`
          : `${n}: ${drafted}; nothing copied either — run /compact there with its text from the ready file`)
    }

    // What a cold session's live tasks wait on: an open question about one of them, or the
    // owner's choice to wait (parked).
    const liveOf = (n: string) => tasks.filter(t => t.status !== 'done' && isSession(t.owner) && sessionName(t.owner) === n)
    // The decision at a glance: ▶ allowed (the owner pressed wake-up, one message may go),
    // ? a question is open, ⏸ the owner chose to wait; nothing when no task waits on it.
    const coldMark = (n: string) => {
      // 💤 stalled: a live task, its turn ended 15–55 min ago, nothing asked (bin/stalls).
      if (contexts[n]?.stalled && !contexts[n]?.cold) return <Text><Text dimColor> · </Text><Text color={NORD.yellow}>💤</Text></Text>
      const state = contexts[n]?.allowed ? 'allowed' : coldState(n)
      if (state === 'allowed') return <Text><Text dimColor> · </Text><Text color={NORD.green}>▶</Text></Text>
      if (state === 'ask') return <Text><Text dimColor> · </Text><Text color={NORD.magenta}>?</Text></Text>
      if (state === 'parked') return <Text><Text dimColor> · </Text><Text color={NORD.yellow}>⏸</Text></Text>
      return null
    }
    // The cold · free box warns about sessions costly to wake, stalled or free; the companions list
    // under the progress line shows every session the queue knows.
    const inColdBox = (n: string) => contexts[n] !== undefined && (contexts[n].cold === true || contexts[n].stalled === true || liveOf(n).length === 0)
    // A cache older than the main conversation's hour is re-written by the next message.
    const expired = (n: string) => (contexts[n]?.idle_s ?? 0) >= 3600
    const companions = sessionNames.filter(n => contexts[n] !== undefined)
    const nFree = companions.filter(n => liveOf(n).length === 0).length
    const nCold = companions.filter(n => contexts[n]?.cold && liveOf(n).length > 0).length
    const nStalled = companions.filter(n => contexts[n]?.stalled && !contexts[n]?.cold).length
    // Working: a live task, a warm cache, not stalled.
    const isWorking = (n: string) => liveOf(n).length > 0 && !contexts[n]?.cold && !contexts[n]?.stalled
    const nWorking = companions.filter(isWorking).length
    const coldState = (n: string): 'ask' | 'parked' | undefined => {
      const live = liveOf(n)
      if (questions.some(one => (one.blocks ?? []).some(b => live.some(t => t.n === b)))) return 'ask'
      if (live.some(t => t.parked)) return 'parked'
      return undefined
    }
    // The owner's yes, by a press: the stale-cache guard then lets one message wake this
    // session within ten minutes. Agents are denied that command; a press is the person's.
    const wake = (n: string) => async () => {
      // bin/contexts is the one place that finds the guard (the sibling plugin, in the
      // repository's layout or the installed one).
      const r = await $.process.run(['sh', '-c', 'g=$(python3 -I "$1" --guard) && exec python3 -I "$g" --allow "$2"', 'wake', `${$.plugin.root}/bin/contexts`, n]).catch(() => undefined)
      const ok = r !== undefined && r.exitCode === 0
      $.ui.toast(ok ? `${n}: one message may wake it in the next 10 min` : `${n}: wake failed`)
      void refreshContexts($).then(() => $.ui.invalidate('ui.render'))
      // The press is the owner's yes but reaches no one by itself: put the message to this
      // session's Claude in the box, ready to send, while the ten minutes run.
      if (ok) {
        const ids = liveOf(n).map(t => `#${t.n}`).join(', ')
        await draft(w.wake(n, ids))()
      }
    }
    // An idle or cold session's other way back: compacted, it costs one re-read of its context
    // and then works from the summary; the guard counts it warm after the compact and lets the
    // coordinator's message through. With no argument written yet the press asks this session's
    // Claude for one: a warm session is asked to write its own (a message to it is cheap while
    // the cache lives), a cold one cannot without waking, so this session writes it for it.
    const compactOffer = (n: string) => contexts[n]?.compact !== undefined
      ? (
        <Button plain key={`compact-cold-${n}`} onPress={copyCompact(n)}>
          <Text color={NORD.green} hover={{ bold: true, underline: true }}>compact{contexts[n]?.compact_by ? ` (by ${contexts[n]?.compact_by})` : ''}</Text>
        </Button>
      )
      : (
        <Button plain key={`compact-ask-${n}`} onPress={draft(!contexts[n]?.cold ? w.compactAskWarm(n) : w.compactAskCold(n, $.plugin.root))}>
          <Text color={NORD.yellow} hover={{ bold: true, underline: true }}>compact?</Text>
        </Button>
      )
    // A row whose owner session's cache has expired: its owner icon becomes the orange session tile (the box
    // above says what waking it costs).
    const isCold = (t: Task) => isSession(t.owner) && contexts[sessionName(t.owner)]?.cold === true
    const row = (t: Task) => {
      const isFull = t.status === 'active' || t.status === 'failed' || (upOpen && t.status === 'waiting') || expanded.includes(t.n)
      const isDone = t.status === 'done'
      return (
        // marginRight -1 reaches into the frame's right padding, so the owner sits on the edge.
        <Box key={`t${t.n}`} flexDirection="row" marginRight={-1}>
          <Box width={numWidth} flexShrink={0}>
            <Button plain key={`btw-t${t.n}`} onPress={btw(w.aboutTask(t.n, t.task))}>
              <Text color={t.status === 'failed' ? NORD.red : undefined} dimColor={t.status !== 'failed'} hover={{ dimColor: false, color: NORD.cyan }}>{String(t.n).padStart(numWidth - 1)}</Text>
            </Button>
          </Box>
          <Box flexGrow={1} flexShrink={1} minWidth={8}>
            <Button plain key={`press-t${t.n}`} onPress={draft(w.aboutTask(t.n, t.task))}>
              <Text dimColor={isDone} hover={{ dimColor: false, bold: true }}>{named(t, isFull ? t.task : cut(t.task, taskWidth))}</Text>
            </Button>
          </Box>
          <Box width={3} flexShrink={0} justifyContent="flex-end">
            <Button plain key={`own-t${t.n}`} onPress={!isDone && isOneSession(t.owner) ? focus(sessionName(t.owner)) : toggle(t.n)}>
              {/* A cold session: the cold tile (icons.cold), in orange. */}
              <Text color={!isDone && isCold(t) ? NORD.orange : roleOf(t.owner, mark, icons).color} dimColor={isDone} hover={{ dimColor: false, bold: true }}>{`${!isDone && isCold(t) ? icons.cold : roleOf(t.owner, mark, icons).icon} `}</Text>
            </Button>
          </Box>
        </Box>
      )
    }

    return (
      <Box {...frame} backgroundColor={q.bg ?? NORD.bg}>
        <Box flexDirection="row" justifyContent="space-between">
          <Text bold>{q.title}</Text>
          <Text dimColor>{q.updated}</Text>
        </Box>
        {q.purpose && (
          <Box marginTop={1}>
            <Text italic dimColor>{q.purpose}</Text>
          </Box>
        )}
        {q.phase && (
          <Box marginTop={1} flexDirection="row">
            <Box flexShrink={0}>
              <Text backgroundColor={NORD.cyan} color={NORD.bg} bold> NOW </Text>
            </Box>
            <Box flexShrink={1} marginLeft={1}>
              <Text color={NORD.cyan}>{q.phase}</Text>
            </Box>
          </Box>
        )}

        {sessionNames.some(n => needsCompact(n)) && (
          <Box marginTop={1} flexDirection="column" borderStyle="round" borderColor={NORD.red} paddingX={1}>
            <Text bold color={NORD.red}>/compact</Text>
            {sessionNames.filter(n => needsCompact(n)).map(n => {
              const ctx = contexts[n]
              const ready = ctx?.compact !== undefined
              return (
                <Box key={`ctx-${n}`} flexDirection="row">
                  <Text color={ready ? NORD.green : NORD.yellow}>{ready ? '✓ ' : '… '}</Text>
                  <Button plain key={`focus-ctx-${n}`} onPress={focus(n)}>
                    <Text color={nameColor(n)} bold hover={{ underline: true }}>{n}</Text>
                  </Button>
                  <Text dimColor> {ctx?.pct ?? 0}%{ctx?.cold ? ' ⏸' : ''}{ctx?.compact_by ? ` · by ${ctx.compact_by}` : ''} · </Text>
                  {ready ? (
                    <Button plain key={`copy-ctx-${n}`} onPress={copyCompact(n)}>
                      <Text color={NORD.green} hover={{ bold: true }}>draft → tab</Text>
                    </Button>
                  ) : (
                    <Text dimColor>not ready yet</Text>
                  )}
                </Box>
              )
            })}
          </Box>
        )}

        {sessionNames.some(n => inColdBox(n)) && (
          // Sessions whose prompt cache has expired: a message wakes them and re-writes the
          // whole context at twice the input price (the stale-cache guard's estimate).
          <Box marginTop={1} flexDirection="column" borderStyle="round" borderColor={NORD.orange} paddingX={1}>
            <Text bold color={NORD.orange}>⏸ cold · free</Text>
            {sessionNames.filter(n => inColdBox(n)).map(n => {
              const ctx = contexts[n]
              const free = liveOf(n).length === 0
              const why = q.why?.[n]
              return (
                <Box key={`cold-${n}`} flexDirection="column">
                <Box key={`cold-row-${n}`} flexDirection="row">
                  {/* An idle session owes a reason: ▸ unfolds it; a yellow ▸ means none was written. */}
                  <Button plain key={`why-${n}`} onPress={() => { whyOpen.has(n) ? whyOpen.delete(n) : whyOpen.add(n); $.ui.invalidate('ui.render') }}>
                    <Text color={why ? undefined : NORD.yellow} dimColor={!!why} hover={{ dimColor: false, bold: true }}>{whyOpen.has(n) ? '▾ ' : '▸ '}</Text>
                  </Button>
                  <Button plain key={`focus-cold-${n}`} onPress={focus(n)}>
                    <Text color={nameColor(n)} bold hover={{ underline: true }}>{n}</Text>
                  </Button>
                  {/* Separate Texts in a row each shrink into a column; one Text of nested
                      spans wraps as a line. The wake-up cost is the wake button. */}
                  <Box flexShrink={1}>
                    <Text dimColor> {idleText(ctx.idle_s ?? 0)} · {Math.round(ctx.tokens / 1000)}k · </Text>
                  </Box>
                  {free && ctx.cold ? (
                    // Free (🕊) and cold: a new task for it is blocked by the guard like any
                    // message, so the owner's press is needed here too.
                    <Box key={`wake-free-${n}`} flexDirection="row">
                      <Button plain key={`wake-${n}`} onPress={wake(n)}>
                        <Text color={NORD.orange} hover={{ bold: true, underline: true }}>wake-up ~{(ctx.tokens * 2 / 1e6).toFixed(1)}M</Text>
                      </Button>
                      <Text dimColor> · </Text>
                      {compactOffer(n)}
                      <Text><Text dimColor> · </Text><Text color={NORD.ice}>🕊</Text></Text>
                    </Box>
                  ) : free ? (
                    // Free (🕊), warm or too small to be cold: a message reaches it freely.
                    <Box key={`free-${n}`} flexDirection="row">
                      {ctx.tokens >= COMPACT_IDLE_MIN && (
                        <Box key={`free-compact-${n}`} flexDirection="row">{compactOffer(n)}<Text dimColor> · </Text></Box>
                      )}
                      <Text>
                        <Text dimColor>{expired(n) ? `~${(ctx.tokens * 2 / 1e6).toFixed(1)}M · ` : ''}</Text>
                        <Text color={NORD.ice}>🕊</Text>
                      </Text>
                    </Box>
                  ) : !ctx.cold ? (
                    // Stalled with its cache alive (💤 from coldMark): a compact is cheapest now.
                    ctx.tokens >= COMPACT_IDLE_MIN ? compactOffer(n) : null
                  ) : (
                    <Box key={`wake-cold-${n}`} flexDirection="row">
                      <Button plain key={`wake-${n}`} onPress={wake(n)}>
                        <Text color={NORD.orange} hover={{ bold: true, underline: true }}>wake-up ~{(ctx.tokens * 2 / 1e6).toFixed(1)}M</Text>
                      </Button>
                      <Text dimColor> · </Text>
                      {compactOffer(n)}
                    </Box>
                  )}
                  {!free && coldMark(n)}
                </Box>
                {whyOpen.has(n) && (
                  <Box key={`why-text-${n}`} marginLeft={2}>
                    {why ? <Text dimColor>{why}</Text> : <Text color={NORD.yellow}>no reason recorded — ask the coordinator why it is idle</Text>}
                  </Box>
                )}
                </Box>
              )
            })}
          </Box>
        )}

        {questions.length > 0 && (
          <Box marginTop={1} flexDirection="column" borderStyle="round" borderColor={NORD.magenta} paddingX={1}>
            <Text bold color={NORD.magenta}>Needs your decision · {questions.length}</Text>
            {questions.map((one, i) => (
              // As in a task row: the number asks a side question about it (/btw), the text answers.
              // A /btw reply never reaches the main conversation, so it must not read as an answer.
              <Box key={`q${i}`} flexDirection="row" marginTop={i === 0 ? 0 : 1}>
                <Box width={3} flexShrink={0}>
                  <Button plain key={`btw-q${i}`} onPress={btw(w.aboutQuestion(one.q))}>
                    <Text color={NORD.magenta} bold hover={{ color: NORD.cyan }}>{`${i + 1}.`}</Text>
                  </Button>
                </Box>
                <Box flexDirection="column" flexShrink={1}>
                  <Button plain key={`press-q${i}`} onPress={draft(w.answer(one.q))}>
                    <Text>{one.q}</Text>
                  </Button>
                  {one.blocks && one.blocks.length > 0 && <Text dimColor>blocks #{one.blocks.join(', #')}</Text>}
                </Box>
              </Box>
            ))}
          </Box>
        )}

        {/* The companions: sessions that are cold, stalled or free, folded behind one button at the end
            of the progress line; its label counts each kind so a stall shows while folded. No empty
            spacer Box needed. The row has a key: a Text with hover needs a keyed Box around it, or the
            surface refuses the whole tree and the pane draws blank. */}
        <Box key="progress" marginTop={1} flexDirection="row" justifyContent="space-between">
          <Box flexDirection="row">
            <Text color={NORD.green}>{'━'.repeat(filled)}</Text>
            <Text dimColor>{'━'.repeat(barLen - filled)}</Text>
            <Text bold> {done.length}/{tasks.length}</Text>
          </Box>
          {companions.length > 0 && (
            <Button plain key="companions-toggle" onPress={() => { companionsOpen = !companionsOpen; $.ui.invalidate('ui.render') }}>
              <Text color={NORD.orange} hover={{ underline: true }}>
                {`companions${nWorking ? ` · ◐ ${nWorking}` : ''}${nFree ? ` · 🕊 ${nFree}` : ''}${nCold ? ` · ⏸ ${nCold}` : ''}${nStalled ? ` · 💤 ${nStalled}` : ''} ${companionsOpen ? '▾' : '▸'}`}
              </Text>
            </Button>
          )}
        </Box>


        {companionsOpen && companions.length > 0 && (
          // The companions: every session the queue knows, its name and one sign of its state.
          <Box key="companions-list" marginTop={1} flexDirection="column" paddingX={1}>
            {(() => {
              // Every row is name + leader + sign at one width; the lines share one centre, the
              // middle of the span between the longest name and the sign.
              const rowWidth = e.props.bodyColumns - 6
              const longest = Math.max(...companions.map(n => n.length))
              const centre = Math.floor((longest + 2 + rowWidth) / 2)
              return companions.map(n => {
              // Ask fm for a fresh line when the list opens or the old one has aged; the answer
              // redraws the pane, a failure keeps the old line (or none).
              const now = Date.now()
              if (now - (phraseAsked.get(n) ?? 0) > PHRASE_TTL) {
                phraseAsked.set(n, now)
                void $.process.run(['python3', '-I', `${$.plugin.root}/bin/phrase`, n], { timeoutMs: 30000 })
                  .then(r => { const text = r.stdout.trim(); if (text) phrases.set(n, { text, at: Date.now() }) })
                  .catch(() => {})
                  .finally(() => $.ui.invalidate('ui.render'))
              }
              // name · · · · sign: the dots fill the row so the sign sits on the right edge.
              // Two cells for a wide sign (💤, 🕊) and one spare, so the row never wraps.
              const dots = Math.max(3, e.props.bodyColumns - 2 - n.length - 6)
              // The line is written on the dots, as on a form's dotted line: dots, the line, dots.
              const line = phrases.get(n)?.text
              const start = line ? centre - Math.floor(line.length / 2) : 0
              const fits = line !== undefined && start - n.length - 2 >= 1 && dots - line.length - 2 - (start - n.length - 2) >= 1
              const said = fits ? line : undefined
              const left = said ? start - n.length - 2 : dots
              const right = said ? dots - said.length - 2 - left : 0
              return (
                <Box key={`companion-${n}`} flexDirection="column">
                  <Box key={`companion-row-${n}`} flexDirection="row">
                    <Button plain key={`focus-companion-${n}`} onPress={focus(n)}>
                      <Text color={nameColor(n)} bold hover={{ underline: true }}>{n}</Text>
                    </Button>
                    {/* Baseline dots, small and faint, as a leader rather than a rule. */}
                    <Text color={NORD.faint} wrap="truncate-end">{` ${'.'.repeat(left)} `}</Text>
                    {said && <Text dimColor italic>{said}</Text>}
                    {said && <Text color={NORD.faint}>{` ${'.'.repeat(right)} `}</Text>}
                    <Box key={`companion-sign-${n}`}>
                      {contexts[n]?.cold ? <Text color={NORD.orange}>⏸</Text>
                        : contexts[n]?.stalled ? <Text color={NORD.yellow}>💤</Text>
                        : isWorking(n) ? <Text color={NORD.green}>◐</Text>
                        : <Text color={NORD.ice}>🕊</Text>}
                    </Box>
                  </Box>
                </Box>
              )
              })
            })()}
          </Box>
        )}

        {active.length > 0 && section('IN PROGRESS', NORD.yellow, active.length)}
        {active.map(row)}
        {upcoming.length > 0 && (
          <Box marginTop={1} key="upnext-head">
            <Button plain key="upnext-toggle" onPress={() => { upOpen = !upOpen; $.ui.invalidate('ui.render') }}>
              <Text bold hover={{ underline: true }}>{upOpen ? '▾ UP NEXT' : '▸ UP NEXT'}</Text>
            </Button>
            <Text dimColor> {upcoming.length}</Text>
          </Box>
        )}
        {upcoming.map(row)}
        {done.length > 0 && (
          <Box marginTop={1} key="done-head">
            <Button plain key="done-toggle" onPress={() => { doneOpen = !doneOpen; $.ui.invalidate('ui.render') }}>
              <Text bold color={NORD.green} hover={{ underline: true }}>{doneOpen ? '▾ DONE' : '▸ DONE'}</Text>
            </Button>
            <Text dimColor> {done.length}{!doneOpen && done.length > DONE_TAIL ? ` · last ${DONE_TAIL}, press to show all` : ''}</Text>
          </Box>
        )}
        {(doneOpen ? done : done.slice(-DONE_TAIL)).map(row)}

        {q.note && (
          <Box marginTop={1} flexDirection="row">
            <Box width={2} flexShrink={0}>
              <Text color={NORD.blue}>ℹ</Text>
            </Box>
            <Box flexShrink={1}>
              <Text dimColor>{q.note}</Text>
            </Box>
          </Box>
        )}

        {roles.length > 0 && (
          <Box marginTop={1} flexDirection="row" flexWrap="wrap">
            {roles.map((r, i) => (
              <Box key={`role${i}`} marginRight={2}>
                <Text color={r.color}>{r.icon}</Text>
                <Text dimColor> {r.label}</Text>
              </Box>
            ))}
          </Box>
        )}
      </Box>
    )
  })
}
