import { expect, mock, test } from 'claude-code/testing'

// The pane must draw on the terminal with sessions in the companions box; a tree the surface
// refuses leaves the pane blank, which no other test sees.
const QUEUE = {
  title: 't',
  tasks: [
    { n: 1, task: 'Ada: merge', owner: 'сессия Ada', status: 'active' },
    { n: 2, task: 'S: read', owner: 'сессия S', status: 'done' },
    { n: 3, task: 'W: write', owner: 'сессия W', status: 'active' },
    { n: 4, task: 'K: read', owner: 'сессия K', status: 'done' },
  ],
}
const CONTEXTS = {
  Ada: { tokens: 647000, pct: 65, cold: true, idle_s: 20000 },
  S: { tokens: 300000, pct: 30, idle_s: 4000 },
  W: { tokens: 200000, pct: 20, idle_s: 60 },
  K: { tokens: 501000, pct: 50, cold: true, idle_s: 4200 },
}

// Mounts the pane over a queue and the contexts bin/contexts would print; every argv the
// pane runs lands in `runs`.
async function mountPane($: any, on: any, queue: object, contexts: object, runs: string[][] = []) {
  on('session.id', () => ({ value: 'sess-1' }))
  on('session.model', () => ({ value: 'claude-opus-5-5' }))
  mock.env(on, { HOME: '/home/t' })
  mock.clock(on)
  on('session.start', () => ({ cwd: '/w' }))
  on('fs.exists', () => ({ value: true }))
  on('fs.read', () => ({ value: JSON.stringify(queue) }))
  on('process.run', (_$: unknown, e: { argv: readonly string[] }) => {
    runs.push([...e.argv])
    return { value: { exitCode: 0, stdout: JSON.stringify(contexts), stderr: '' } }
  })
  on('command.run', () => ({ text: '' }))
  on('ui.open', () => ({ value: { isPlaced: true as const } }))
  await $.session.start({ cwd: '/w', surface: 'terminal' } as never)
  await $.command.run({ command: 'queue' })
  return $.ui.mount({
    plugin: 'task-queue', surface: 'terminal', component: 'Pane', requestId: 'task-queue',
    props: { title: 'q', isFocused: true, bodyColumns: 60, placement: 'dock', scroll: { offset: 0, bodyRows: 40 }, view: {} },
  })
}

// The wake press asks bin/contexts where the guard is (one rule for both layouts) and runs
// its --allow there; no other copy of the guard is looked for.
test('the wake press finds the guard through bin/contexts', async ($, on) => {
  const runs: string[][] = []
  on('ui.toast', () => ({ value: undefined }))
  on('prompt.read', () => ({ value: { text: '' } }))
  on('prompt.fill', () => ({ isFilled: true }))
  const ui = await mountPane($, on, QUEUE, CONTEXTS, runs)
  await ui.press({ key: 'wake-K' })
  const wake = runs.find(a => a[0] === 'sh' && a.includes('K'))!
  expect(wake.slice(-2)).toEqual([expect.stringMatching(/\/bin\/contexts$/), 'K'])
  expect(wake[2]).toContain('--guard')
  expect(runs.some(a => a.join(' ').includes('.claude/hooks'))).toBe(false)
  await ui.unmount()
})

test('the pane draws all companions: cold, free and working', async ($, on) => {
  const ui = await mountPane($, on, QUEUE, CONTEXTS)
  expect(await ui.find({ type: 'Text', text: /\d+\/4/ })).toBeDefined()
  // The companions show: in the box, or folded behind its button.
  expect(await ui.find({ type: 'Text', text: /Ada/ })).toBeDefined()
  // The cold · free warning shows without a press; W works, so it is not in it.
  expect(await ui.find({ type: 'Text', text: /cold · free/ })).toBeDefined()
  expect(await ui.find({ key: 'companion-W' })).toBeUndefined()
  // A free session whose cache expired still needs the owner's press before a new task can reach it.
  expect(await ui.find({ key: 'wake-K' })).toBeDefined()
  // Neighbouring sessions under one coordinator are companions, not a swarm (a pile of autonomous agents).
  expect(await ui.find({ type: 'Text', text: /^companions · / })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /swarm/ })).toBeUndefined()
  // The companions list, unfolded, names every session the queue knows, the working one too.
  await ui.press({ key: 'companions-toggle' })
  expect(await ui.find({ key: 'companion-W' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /◐/ })).toBeDefined()
  await ui.unmount()
})

// An owner written with its roster badge is the same session bin/contexts keys without it:
// the companions list, the cold box and the focus press all find it, and focus goes to the bare name.
test('a session owner written with its badge stays among the companions', async ($, on) => {
  const runs: string[][] = []
  const queue = { title: 't', tasks: [{ n: 1, task: 'Mary Ann: merge', owner: 'сессия Mary Ann🗡️', status: 'active' }] }
  const contexts = { 'Mary Ann': { tokens: 647000, pct: 65, cold: true, idle_s: 20000 } }
  const ui = await mountPane($, on, queue, contexts, runs)
  expect(await ui.find({ key: 'cold-Mary Ann' })).toBeDefined()
  await ui.press({ key: 'companions-toggle' })
  expect(await ui.find({ key: 'companion-Mary Ann' })).toBeDefined()
  await ui.press({ key: 'focus-companion-Mary Ann' })
  expect(runs.filter(argv => argv[0] === 'open')).toEqual([['open', 'tabfolk://focus/Mary%20Ann']])
  await ui.press({ key: 'own-t1' })
  expect(runs.filter(argv => argv[0] === 'open').at(-1)).toEqual(['open', 'tabfolk://focus/Mary%20Ann'])
  await ui.unmount()
})

// A question written as a plain string is its text, not a blank numbered row.
test('a question written as a plain string shows its text', async ($, on) => {
  const queue = { title: 't', tasks: [], questions: ['plain question?'] }
  const ui = await mountPane($, on, queue, {})
  expect(await ui.find({ type: 'Text', text: /plain question\?/ })).toBeDefined()
  await ui.unmount()
})

test('a press on UP NEXT unfolds its cut rows and folds them back', async ($, on) => {
  const long = 'Waiting: ' + 'a long waiting task text that cannot fit the pane width '.repeat(3) + 'END'
  const ui = await mountPane($, on, { title: 't', tasks: [{ n: 1, task: long, owner: 'я', status: 'waiting' }] }, {})
  expect(await ui.find({ type: 'Text', text: /END/ })).toBeUndefined()
  await ui.press({ key: 'upnext-toggle' })
  expect(await ui.find({ type: 'Text', text: /END/ })).toBeDefined()
  await ui.press({ key: 'upnext-toggle' })
  expect(await ui.find({ type: 'Text', text: /END/ })).toBeUndefined()
  await ui.unmount()
})

test('an idle session in the cold · free box unfolds to why it is idle, or says nobody wrote it', async ($, on) => {
  const queue = {
    title: 't',
    tasks: [
      { n: 1, task: 'F: done', owner: 'сессия F', status: 'done' },
      { n: 2, task: 'G: done', owner: 'сессия G', status: 'done' },
    ],
    why: { F: 'ждёт решения владельца по метке' },
  }
  const ui = await mountPane($, on, queue, { F: { tokens: 100000, pct: 10, idle_s: 300 }, G: { tokens: 100000, pct: 10, idle_s: 300 } })
  expect(await ui.find({ type: 'Text', text: /ждёт решения владельца/ })).toBeUndefined()
  await ui.press({ key: 'why-F' })
  expect(await ui.find({ type: 'Text', text: /ждёт решения владельца по метке/ })).toBeDefined()
  await ui.press({ key: 'why-G' })
  expect(await ui.find({ type: 'Text', text: /no reason recorded/ })).toBeDefined()
  await ui.unmount()
})

test('the companions list puts each sign on the right, dots before it, and the fm line written on the dots', async ($, on) => {
  on('session.id', () => ({ value: 'sess-1' }))
  on('session.model', () => ({ value: 'claude-opus-5-5' }))
  mock.env(on, { HOME: '/home/t' })
  mock.clock(on)
  on('session.start', () => ({ cwd: '/w' }))
  on('fs.exists', () => ({ value: true }))
  on('fs.read', () => ({ value: JSON.stringify({ title: 't', tasks: [{ n: 1, task: 'W: write', owner: 'сессия W', status: 'active' }] }) }))
  on('process.run', (_$: unknown, e: { argv: readonly string[] }) => {
    const phrase = e.argv.some(a => a.endsWith('/bin/phrase'))
    return { value: { exitCode: 0, stdout: phrase ? 'Ветер над болотом\n' : JSON.stringify({ W: { tokens: 1, pct: 1, idle_s: 5 } }), stderr: '' } }
  })
  on('command.run', () => ({ text: '' }))
  on('ui.open', () => ({ value: { isPlaced: true as const } }))
  await $.session.start({ cwd: '/w', surface: 'terminal' } as never)
  await $.command.run({ command: 'queue' })
  const ui = await $.ui.mount({
    plugin: 'task-queue', surface: 'terminal', component: 'Pane', requestId: 'task-queue',
    props: { title: 'q', isFocused: true, bodyColumns: 60, placement: 'dock', scroll: { offset: 0, bodyRows: 40 }, view: {} },
  })
  await ui.press({ key: 'companions-toggle' })
  await ui.press({ key: 'companions-toggle' })
  await ui.press({ key: 'companions-toggle' })
  expect(await ui.find({ key: 'companion-sign-W' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /^ \.{3,} $/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /Ветер над болотом/ })).toBeDefined()
  // The line sits on the dots, as writing on a form's dotted line, not on a row of its own.
  expect(await ui.find({ key: 'companion-line-W' })).toBeUndefined()
  await ui.unmount()
})

test('companion lines share one centre whatever the name length', async ($, on) => {
  on('session.id', () => ({ value: 'sess-1' }))
  on('session.model', () => ({ value: 'claude-opus-5-5' }))
  mock.env(on, { HOME: '/home/t' })
  mock.clock(on)
  on('session.start', () => ({ cwd: '/w' }))
  on('fs.exists', () => ({ value: true }))
  const tasks = [{ n: 1, task: 'A: a', owner: 'сессия A', status: 'active' }, { n: 2, task: 'Bbbbbbb: b', owner: 'сессия Bbbbbbb', status: 'active' }]
  on('fs.read', () => ({ value: JSON.stringify({ title: 't', tasks }) }))
  on('process.run', (_$: unknown, e: { argv: readonly string[] }) => {
    const phrase = e.argv.some(a => a.endsWith('/bin/phrase'))
    const ctx = { A: { tokens: 1, pct: 1, idle_s: 5 }, Bbbbbbb: { tokens: 1, pct: 1, idle_s: 5 } }
    return { value: { exitCode: 0, stdout: phrase ? 'Same line\n' : JSON.stringify(ctx), stderr: '' } }
  })
  on('command.run', () => ({ text: '' }))
  on('ui.open', () => ({ value: { isPlaced: true as const } }))
  await $.session.start({ cwd: '/w', surface: 'terminal' } as never)
  await $.command.run({ command: 'queue' })
  const ui = await $.ui.mount({
    plugin: 'task-queue', surface: 'terminal', component: 'Pane', requestId: 'task-queue',
    props: { title: 'q', isFocused: true, bodyColumns: 60, placement: 'dock', scroll: { offset: 0, bodyRows: 40 }, view: {} },
  })
  await ui.press({ key: 'companions-toggle' })
  await ui.press({ key: 'companions-toggle' })
  await ui.press({ key: 'companions-toggle' })
  // The line starts at the same column in both rows: name + its leading dots is one width.
  // Each row draws its dots before the line and after it, rows in order: A's left, A's right, B's left, B's right.
  const dots = (await ui.findAll({ type: 'Text', text: /^ \.+ $/ })).map(d => String(d.text ?? '').length)
  expect(dots).toHaveLength(4)
  expect('A'.length + dots[0]).toBe('Bbbbbbb'.length + dots[2])
  await ui.unmount()
})

test('the pane redraws when the queue file changes, not on every tick', async ($, on) => {
  let reads = 0
  let mtimeMs = 1000
  on('session.id', () => ({ value: 'sess-1' }))
  on('session.model', () => ({ value: 'claude-opus-5-5' }))
  mock.env(on, { HOME: '/home/t' })
  const clock = mock.clock(on)
  on('session.start', () => ({ cwd: '/w' }))
  on('fs.exists', () => ({ value: true }))
  on('fs.stat', () => ({ value: { kind: 'file' as const, size: 10, mtimeMs, isLink: false } }))
  on('fs.read', () => { reads++; return { value: JSON.stringify({ title: 't', tasks: [{ n: 1, task: 'x', owner: 'я', status: 'active' }] }) } })
  on('process.run', () => ({ value: { exitCode: 0, stdout: '{}', stderr: '' } }))
  on('command.run', () => ({ text: '' }))
  on('ui.open', () => ({ value: { isPlaced: true as const } }))
  await $.session.start({ cwd: '/w', surface: 'terminal' } as never)
  await $.command.run({ command: 'queue' })
  const ui = await $.ui.mount({
    plugin: 'task-queue', surface: 'terminal', component: 'Pane', requestId: 'task-queue',
    props: { title: 'q', isFocused: true, bodyColumns: 60, placement: 'dock', scroll: { offset: 0, bodyRows: 40 }, view: {} },
  })
  await clock.advance(3000)
  const settled = reads
  await clock.advance(9000)
  expect(reads).toBe(settled)          // nothing changed: no redraw, no read
  mtimeMs = 2000
  await clock.advance(3000)
  expect(reads).toBeGreaterThan(settled)  // the file changed: one redraw
  await ui.unmount()
})

// The /compact box's press drafts `/compact <text>` into the ready session's own prompt in cmux:
// tabfolk names its panel, `cmux send` types `/compact ` (refused over a draft), the paste adds
// the argument, nothing presses Enter, and the tab is focused. Any failure falls back to the clipboard.
const READY_QUEUE = { title: 't', tasks: [{ n: 1, task: 'Rhea: review', owner: 'сессия Rhea', status: 'active' }] }
const READY_CONTEXTS = { Rhea: { tokens: 850000, pct: 85, compact: 'keep the review state', idle_s: 30 } }

type Run = { argv: string[]; stdin?: string }
async function pressCompact($: any, on: any, answer: (argv: readonly string[]) => { exitCode: number; stdout?: string; stderr?: string }, key = 'copy-ctx-Rhea', contexts: object = READY_CONTEXTS) {
  const runs: Run[] = []
  const toasts: string[] = []
  on('session.id', () => ({ value: 'sess-1' }))
  on('session.model', () => ({ value: 'claude-opus-5-5' }))
  mock.env(on, { HOME: '/home/t' })
  mock.clock(on)
  on('session.start', () => ({ cwd: '/w' }))
  on('fs.exists', () => ({ value: true }))
  on('fs.read', () => ({ value: JSON.stringify(READY_QUEUE) }))
  on('process.run', (_$: unknown, e: { argv: readonly string[]; init?: { stdin?: string } }) => {
    runs.push({ argv: [...e.argv], stdin: e.init?.stdin })
    if (e.argv[0].endsWith('/bin/contexts')) return { value: { exitCode: 0, stdout: JSON.stringify(contexts), stderr: '' } }
    return { value: { stdout: '', stderr: '', ...answer(e.argv) } }
  })
  on('ui.toast', (_$: unknown, e: { text: string }) => { toasts.push(e.text); return { value: undefined } })
  on('command.run', () => ({ text: '' }))
  on('ui.open', () => ({ value: { isPlaced: true as const } }))
  await $.session.start({ cwd: '/w', surface: 'terminal' } as never)
  await $.command.run({ command: 'queue' })
  const ui = await $.ui.mount({
    plugin: 'task-queue', surface: 'terminal', component: 'Pane', requestId: 'task-queue',
    props: { title: 'q', isFocused: true, bodyColumns: 60, placement: 'dock', scroll: { offset: 0, bodyRows: 40 }, view: {} },
  })
  await ui.press({ key })
  await ui.unmount()
  return { runs: runs.filter(r => !r.argv[0].endsWith('/bin/contexts')), toasts }
}

const PANEL = ['--workspace', 'WS-1', '--surface', 'SF-1']
const resolved = (argv: readonly string[]) => argv.includes('--print-surface') ? { exitCode: 0, stdout: 'WS-1 SF-1\n' } : { exitCode: 0 }

test('the compact press types /compact, pastes the text into that session and focuses it, unsent', async ($, on) => {
  const { runs, toasts } = await pressCompact($, on, resolved)
  expect(runs.map(r => r.argv)).toEqual([
    ['/usr/bin/python3', '-I', '-B', '/home/t/projects/tabfolk/tabfolk/focus.py', '--print-surface', 'Rhea'],
    ['cmux', 'send', ...PANEL, '--', '/compact '],
    ['cmux', 'paste', '--force', ...PANEL, '-'],
    ['open', 'tabfolk://focus/Rhea'],
  ])
  expect(runs[2].stdin?.startsWith('keep the review state\n\nAfter compact:')).toBe(true)
  // Never submitted: no --submit, no Enter key, nothing on the clipboard.
  expect(runs.some(r => r.argv.includes('--submit') || r.argv.includes('send-key') || r.argv[0] === 'pbcopy')).toBe(false)
  expect(toasts).toEqual(['Rhea: /compact draft is in its prompt — check it, then Enter'])
})

test('the compact press falls back to the clipboard when tabfolk finds no panel', async ($, on) => {
  const { runs, toasts } = await pressCompact($, on, argv => argv.includes('--print-surface') ? { exitCode: 1, stderr: 'tabfolk: the session is not open in cmux\n' } : { exitCode: 0 })
  expect(runs.some(r => r.argv[0] === 'cmux')).toBe(false)
  expect(runs.filter(r => r.argv[0] === 'pbcopy').map(r => r.stdin?.startsWith('keep the review state'))).toEqual([true])
  expect(runs.at(-1)?.argv).toEqual(['open', 'tabfolk://focus/Rhea'])
  expect(toasts).toEqual(['Rhea: its cmux tab was not found; copied instead — type /compact and a space, then paste'])
})

test('with no clipboard either, the compact press says the text was not copied', async ($, on) => {
  const { toasts } = await pressCompact($, on, argv => argv.includes('--print-surface') ? { exitCode: 1 } : argv[0] === 'pbcopy' ? { exitCode: 127 } : { exitCode: 0 })
  expect(toasts).toEqual(['Rhea: its cmux tab was not found; nothing copied either — run /compact there with its text from the ready file'])
})

test('the compact press leaves a prompt that already has text alone and copies instead', async ($, on) => {
  const { runs, toasts } = await pressCompact($, on, argv => argv[1] === 'send'
    ? { exitCode: 1, stderr: 'Error: send: the agent prompt in surface:9 holds text someone is typing, so nothing was sent.' }
    : resolved(argv))
  expect(runs.some(r => r.argv[1] === 'paste')).toBe(false)
  expect(runs.filter(r => r.argv[0] === 'pbcopy')).toHaveLength(1)
  expect(toasts).toEqual(['Rhea: its prompt already has text; copied instead — type /compact and a space, then paste'])
})

// A cold session can be compacted instead of woken: the guard counts it warm after the compact.
// Its argument may be written by the coordinator (`queue compact-for`), and the pane says so.
const COLD_READY = { Rhea: { tokens: 520000, pct: 52, cold: true, idle_s: 9000, compact: 'resume from NOTE.md', compact_by: 'Urra' } }

test('a cold session with an argument offers its compact beside the wake-up and names who wrote it', async ($, on) => {
  const ui = await mountPane($, on, READY_QUEUE, COLD_READY)
  expect(await ui.find({ key: 'wake-Rhea' })).toBeDefined()
  expect(await ui.find({ key: 'compact-cold-Rhea' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /^compact \(by Urra\)$/ })).toBeDefined()
  expect(await ui.find({ key: 'compact-ask-Rhea' })).toBeUndefined()
  await ui.unmount()
})

test('the /compact box names who wrote an argument', async ($, on) => {
  const ui = await mountPane($, on, READY_QUEUE, COLD_READY)
  expect(await ui.find({ type: 'Text', text: /· by Urra ·/ })).toBeDefined()
  await ui.unmount()
})

test('a session that wrote its own argument shows no author', async ($, on) => {
  const ui = await mountPane($, on, READY_QUEUE, { Rhea: { ...COLD_READY.Rhea, compact_by: undefined } })
  expect(await ui.find({ type: 'Text', text: /^compact$/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /by Urra/ })).toBeUndefined()
  await ui.unmount()
})

test('the cold compact press drafts /compact with the written argument into that session', async ($, on) => {
  const { runs } = await pressCompact($, on, resolved, 'compact-cold-Rhea', COLD_READY)
  expect(runs.map(r => r.argv[1])).toContain('send')
  expect(runs.find(r => r.argv[1] === 'paste')?.stdin?.startsWith('resume from NOTE.md\n\nAfter compact:')).toBe(true)
})

test('a cold session with no argument asks this session to write one for it', async ($, on) => {
  const filled: string[] = []
  on('prompt.read', () => ({ value: { text: '' } }))
  on('prompt.fill', (_$: unknown, e: { text: string }) => { filled.push(e.text); return { isFilled: true } })
  const cold = { Rhea: { tokens: 520000, pct: 52, cold: true, idle_s: 9000 } }
  const ui = await mountPane($, on, READY_QUEUE, cold)
  expect(await ui.find({ key: 'compact-cold-Rhea' })).toBeUndefined()
  await ui.press({ key: 'compact-ask-Rhea' })
  expect(filled).toHaveLength(1)
  expect(filled[0]).toMatch(/^Rhea: its cache has expired — write its \/compact argument for it: `.*\/bin\/queue compact-for 'Rhea' "…"`/)
  await ui.unmount()
})

// Idle but still warm: a compact now re-reads the context at a tenth of the price, so the box offers
// it to a stalled or free session of 200k or more, and the press asks this session to have it write
// its own argument while a message to it is still cheap.
const IDLE_QUEUE = { title: 't', tasks: [
  { n: 1, task: 'Rhea: review', owner: 'сессия Rhea', status: 'active' },
  { n: 2, task: 'Tess: done', owner: 'сессия Tess', status: 'done' },
  { n: 3, task: 'Wren: write', owner: 'сессия Wren', status: 'active' },
  { n: 4, task: 'Pip: small', owner: 'сессия Pip', status: 'active' },
] }
const IDLE = {
  Rhea: { tokens: 300000, pct: 30, idle_s: 1500, stalled: true },
  Tess: { tokens: 260000, pct: 26, idle_s: 1500 },
  Wren: { tokens: 300000, pct: 30, idle_s: 60 },
  Pip: { tokens: 150000, pct: 15, idle_s: 1500, stalled: true },
}

test('a stalled warm session of 200k or more is offered a compact', async ($, on) => {
  const ui = await mountPane($, on, IDLE_QUEUE, IDLE)
  expect(await ui.find({ key: 'compact-ask-Rhea' })).toBeDefined()
  await ui.unmount()
})

test('a free warm session of 200k or more is offered a compact', async ($, on) => {
  const ui = await mountPane($, on, IDLE_QUEUE, IDLE)
  expect(await ui.find({ key: 'compact-ask-Tess' })).toBeDefined()
  await ui.unmount()
})

test('a working session, or an idle one under 200k, is not offered a compact', async ($, on) => {
  const ui = await mountPane($, on, IDLE_QUEUE, IDLE)
  expect(await ui.find({ key: 'compact-ask-Wren' })).toBeUndefined()
  expect(await ui.find({ key: 'compact-ask-Pip' })).toBeUndefined()
  await ui.unmount()
})

test('the press for a warm idle session asks to have it write its own argument', async ($, on) => {
  const filled: string[] = []
  on('prompt.read', () => ({ value: { text: '' } }))
  on('prompt.fill', (_$: unknown, e: { text: string }) => { filled.push(e.text); return { isFilled: true } })
  const ui = await mountPane($, on, IDLE_QUEUE, IDLE)
  await ui.press({ key: 'compact-ask-Rhea' })
  expect(filled).toHaveLength(1)
  expect(filled[0]).toMatch(/^Rhea: idle, its cache still warm — ask it to write its \/compact argument .* to ~\/\.claude\/task-queues\/compact-ready\/Rhea\.txt/)
  await ui.unmount()
})
