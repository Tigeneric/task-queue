import { expect, mock, test } from 'claude-code/testing'

// The `language` option picks the words the person and Claude read: the injected
// instructions, the drafts a press puts in the prompt box, the text a compact press copies
// and the Stop hook's line. `ru` (the default) must stay exactly as it was; `en` must carry no
// Russian; owner words are read in both languages whichever is chosen.
const CYRILLIC = /[А-Яа-яЁё]/
const INPUT = { model: 'm', promptModel: 'm', surfaces: [], tools: [], outputStyle: null, traits: [] }

async function instructionsText($: any, on: any): Promise<string> {
  on('prompt.compose', () => ({ sections: [] }))
  on('command.run', () => ({ text: '' }))
  on('ui.open', () => ({ value: { isPlaced: true as const } }))
  on('session.id', () => ({ value: 'sess-1' }))
  mock.env(on, { HOME: '/home/t' })
  await $.command.run({ command: 'queue' })
  const r = await $.prompt.compose(INPUT)
  // The plugin's root is the engine's; put a fixed one in its place.
  const text: string = r.sections.find((s: { id: string }) => s.id === 'task-queue:instructions')?.text ?? ''
  const root = /`(\/\S+)\/bin\/queue /.exec(text)?.[1] ?? '<no root>'
  return text.split(root).join('ROOT')
}

const RU_INSTRUCTIONS = [
  "# Task queue pane",
  "The person watches a pane of this session's tasks. Keep it current with Bash `ROOT/bin/queue --file /home/t/.claude/task-queues/sess-1.json --lang ru …`, one call per change and never by editing the file: when a task is added, starts, finishes or fails, the phase changes, or a question for the person comes up or is answered.",
  "Commands: `new TITLE [--purpose \"what the session is for, one or two sentences\"]` (first); `add TASK [--owner WHO] [--status active]` (prints #n; a short label); `start|done|wait|fail N...`; `park|unpark N...` (a task left for later on purpose, or one of a cold session the owner chose not to wake: shown ⏸, never reported idle); `set N [--task T] [--owner WHO]`; `phase TEXT` (what is happening now; \"\" clears); `note TEXT`; `ask QUESTION [--blocks N...]` (prints ?k); `answer K...`; `why NAME TEXT` (why a companion session is idle; \"\" clears); `coordinator on|off` (see below); `show`.",
  "WHO: я (default) | ты | субагент … | codex … | фон (a background shell job) | сессия <name> (another Claude session).",
  "Every companion session (another Claude session working beside this one under the same coordinator) that is idle — free, cold or parked — owes a reason the person can read in the cold · free box: record it with `why NAME TEXT` when it goes idle (waiting for a decision, for another session, nothing left for it) and clear it when it gets work.",
  "Compact readiness: once this session's context passes 80 %, at the next clean point — no live subagent and no background shell of its own, its work committed, a resume note written to a durable file — write the /compact argument (what to resume with and where the note is) to `~/.claude/task-queues/compact-ready/<your bare roster name>.txt`. That file is what marks the session ready (✓) in the coordinator's pane and what its button drafts into your prompt; it is removed after the compact. Ask a session you coordinate to do the same. A coordinated session whose cache has expired cannot write it without being woken, so write it for that session with `queue compact-for NAME TEXT` — from its last messages and its rows here — and the pane offers its compact in place of the wake-up.",
  "In a task's or question's text, `#n` refers only to a task of this queue (the pane numbers rows that way); write another numbering without `#` — `N12`, `находка 12`, `ABC-123` — so a row never reads as two task numbers.",
  "Once the queue holds tasks of other sessions (`сессия <name>`), turn coordinator mode on with `ROOT/bin/queue --file /home/t/.claude/task-queues/sess-1.json --lang ru coordinator on` (`off` when no other session holds a live task). Then each time this session stops, the plugin's Stop hook runs `ROOT/bin/stalls --coordinator` and sends the turn back with what it found, each report once until it changes: «<name>: N min idle with #n» for a session idle 15–55 min with a live task, and «<name>: N min idle, next: #6, #7» for one idle with waiting rows of its own; a recorded `why` is shown beside a report and never silences it. It runs only when this session stops, so while coordinator mode is on also keep a background `ROOT/bin/stalls --file /home/t/.claude/task-queues/sess-1.json --wait` (run_in_background; exits on the first new report — launch it again after each): it is what wakes you during a stretch with no turns of your own, and the Stop hook says once when it is gone. Nudge with one line («ты в простое N мин с задачей #n — продолжай или скажи, что мешает», or «…, следующие: #6, #7 — бери следующую») while its cache is still warm. Waiting on a lock, a run or another session is not a reason to idle while the session has UP NEXT rows of its own; a row deliberately left for later gets `park`, and parked or question-blocked rows are never reported.",
].join('\n')

// ru is the text the plugin spoke before it had a language option; only the CLI is now told
// its language, since the CLIs speak English unless asked.
test('ru keeps the instructions word for word', { options: { language: 'ru' } }, async ($, on) => {
  expect(await instructionsText($, on)).toBe(RU_INSTRUCTIONS)
})

test('en, the default, carries no Russian and names the English owner words', async ($, on) => {
  const text = await instructionsText($, on)
  expect(text).not.toMatch(CYRILLIC)
  expect(text).toContain('WHO: me (default) | you | subagent … | codex … | bg (a background shell job) | session <name> (another Claude session).')
  // The CLI is told the language, so its own defaults and warnings are English too.
  expect(text).toContain('`ROOT/bin/queue --file /home/t/.claude/task-queues/sess-1.json …`')
  expect(text).toContain('finding 12')
})

// A pane over one queue: every argv (and stdin) the pane runs lands in `runs`, every
// prompt fill in `fills`.
async function mountPane($: any, on: any, queue: object, contexts: object, runs: { argv: string[]; stdin?: string }[], fills: string[]) {
  on('session.id', () => ({ value: 'sess-1' }))
  on('session.model', () => ({ value: 'claude-opus-5-5' }))
  mock.env(on, { HOME: '/home/t' })
  mock.clock(on)
  on('session.start', () => ({ cwd: '/w' }))
  on('fs.exists', () => ({ value: true }))
  on('fs.read', () => ({ value: JSON.stringify(queue) }))
  on('process.run', (_$: unknown, e: { argv: readonly string[]; init?: { stdin?: string } }) => {
    runs.push({ argv: [...e.argv], stdin: e.init?.stdin })
    return { value: { exitCode: 0, stdout: JSON.stringify(contexts), stderr: '' } }
  })
  on('prompt.read', () => ({ value: { text: '', cursor: 0 } }))
  on('prompt.fill', (_$: unknown, e: { text: string }) => { fills.push(e.text); return { isFilled: true } })
  on('ui.toast', () => ({ value: undefined }))
  on('command.run', () => ({ text: '' }))
  on('ui.open', () => ({ value: { isPlaced: true as const } }))
  await $.session.start({ cwd: '/w', surface: 'terminal' } as never)
  await $.command.run({ command: 'queue' })
  return $.ui.mount({
    plugin: 'task-queue', surface: 'terminal', component: 'Pane', requestId: 'task-queue',
    props: { title: 'q', isFocused: true, bodyColumns: 60, placement: 'dock', scroll: { offset: 0, bodyRows: 40 }, view: {} },
  })
}

const QUEUE = {
  title: 't',
  tasks: [
    { n: 1, task: 'mine', owner: 'я', status: 'active' },
    { n: 2, task: 'K: read', owner: 'сессия K', status: 'done' },
  ],
  questions: ['ship?'],
}
const CONTEXTS = { K: { tokens: 501000, pct: 85, cold: true, idle_s: 4200, compact: 'state' } }

async function pressEverything(ui: any) {
  await ui.press({ key: 'press-t1' })
  await ui.press({ key: 'btw-t1' })
  await ui.press({ key: 'press-q0' })
  await ui.press({ key: 'btw-q0' })
  await ui.press({ key: 'wake-K' })
  await ui.press({ key: 'copy-ctx-K' })
}

test('ru drafts and the compact text stay word for word', { options: { language: 'ru' } }, async ($, on) => {
  const runs: { argv: string[]; stdin?: string }[] = []
  const fills: string[] = []
  const ui = await mountPane($, on, QUEUE, CONTEXTS, runs, fills)
  await pressEverything(ui)
  expect(fills).toEqual([
    'Про #1 «mine»: ',
    '/btw Про #1 «mine»: ',
    'Ответ на «ship?»: ',
    '/btw Про вопрос «ship?»: ',
    'K: разбудить — отправь отложенное; разрешение действует 10 мин',
  ])
  expect(runs.find(r => r.argv[0] === 'pbcopy')?.stdin).toBe(
    'state\n\nПосле compact: одной строкой сообщи координатору, что compact готов и с чего начинаешь.')
  await ui.unmount()
})

test('en drafts, the default, and the compact text carry no Russian', async ($, on) => {
  const runs: { argv: string[]; stdin?: string }[] = []
  const fills: string[] = []
  const ui = await mountPane($, on, QUEUE, CONTEXTS, runs, fills)
  await pressEverything(ui)
  expect(fills).toEqual([
    'About #1 "mine": ',
    '/btw About #1 "mine": ',
    'Answer to "ship?": ',
    '/btw About the question "ship?": ',
    'K: wake up — send what was held back; the permission lasts 10 min',
  ])
  const copied = runs.find(r => r.argv[0] === 'pbcopy')?.stdin ?? ''
  expect(copied).not.toMatch(CYRILLIC)
  expect(copied).toContain('After compact: tell the coordinator')
  await ui.unmount()
})

// A queue written in Russian draws the same under en, and one written in English draws its
// sessions and roles under ru: owner words are read in both languages.
for (const language of ['ru', 'en']) {
  test(`under ${language} both languages' owner words are read`, { options: { language } }, async ($, on) => {
    const queue = {
      title: 't',
      tasks: [
        { n: 1, task: 'A: merge', owner: 'сессия A', status: 'active' },
        { n: 2, task: 'B: read', owner: 'session B🎻', status: 'active' },
        { n: 3, task: 'x', owner: 'me', status: 'waiting' },
        { n: 4, task: 'y', owner: 'you', status: 'waiting' },
        { n: 5, task: 'z', owner: 'bg', status: 'waiting' },
      ],
    }
    const contexts = { A: { tokens: 10000, pct: 1, idle_s: 60 }, B: { tokens: 10000, pct: 1, idle_s: 60 } }
    const ui = await mountPane($, on, queue, contexts, [], [])
    await ui.press({ key: 'companions-toggle' })
    expect(await ui.find({ key: 'companion-A' })).toBeDefined()
    expect(await ui.find({ key: 'companion-B' })).toBeDefined()
    // The legend names roles, not the raw owner words.
    expect(await ui.find({ type: 'Text', text: / Claude$/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: / you$/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: / background shell$/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: / me$/ })).toBeUndefined()
    await ui.unmount()
  })
}
