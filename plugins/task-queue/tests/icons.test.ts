import { expect, mock, test } from 'claude-code/testing'

// The `icons` option: `plimsoll` draws the owner column and the legend with the
// private-use glyphs of plimsoll's "Statusline Icons" font and Nerd Font symbols; `plain`, the default, with
// ordinary Unicode any font has, so a terminal without those fonts draws no tofu.
const PRIVATE_USE = /[-]|[\u{F0000}-\u{10FFFF}]/u

const QUEUE = {
  title: 't',
  tasks: [
    { n: 1, task: 'a', owner: 'я', status: 'active' },
    { n: 2, task: 'b', owner: 'codex', status: 'active' },
    { n: 3, task: 'c', owner: 'ты', status: 'active' },
    { n: 4, task: 'd', owner: 'субагент', status: 'active' },
    { n: 5, task: 'e', owner: 'фон', status: 'active' },
    { n: 6, task: 'K: f', owner: 'сессия K', status: 'active' },
    { n: 7, task: 'W: g', owner: 'сессия W', status: 'active' },
  ],
}
const CONTEXTS = {
  K: { tokens: 501000, pct: 50, cold: true, idle_s: 4200 },
  W: { tokens: 200000, pct: 20, idle_s: 60 },
}

async function mountPane($: any, on: any) {
  on('session.id', () => ({ value: 'sess-1' }))
  on('session.model', () => ({ value: 'claude-opus-5-5' }))
  mock.env(on, { HOME: '/home/t' })
  mock.clock(on)
  on('session.start', () => ({ cwd: '/w' }))
  on('fs.exists', () => ({ value: true }))
  on('fs.read', () => ({ value: JSON.stringify(QUEUE) }))
  on('process.run', () => ({ value: { exitCode: 0, stdout: JSON.stringify(CONTEXTS), stderr: '' } }))
  on('command.run', () => ({ text: '' }))
  on('ui.open', () => ({ value: { isPlaced: true as const } }))
  await $.session.start({ cwd: '/w', surface: 'terminal' } as never)
  await $.command.run({ command: 'queue' })
  return $.ui.mount({
    plugin: 'task-queue', surface: 'terminal', component: 'Pane', requestId: 'task-queue',
    props: { title: 'q', isFocused: true, bodyColumns: 60, placement: 'dock', scroll: { offset: 0, bodyRows: 40 }, view: {} },
  })
}

// The owner column's glyph of each task row, by task number.
async function ownerGlyphs(ui: any): Promise<string[]> {
  const out: string[] = []
  for (const n of [1, 2, 3, 4, 5, 6, 7]) out.push(((await ui.find({ key: `own-t${n}` }))?.text ?? '').trim())
  return out
}

test('plimsoll keeps the font glyphs', { options: { icons: 'plimsoll' } }, async ($, on) => {
  const ui = await mountPane($, on)
  // Claude's Opus mark, Codex, you, subagent, background shell, the cold session tile, another session.
  expect(await ownerGlyphs(ui)).toEqual(['', '', '\u{F01A5}', '', '', '', ''])
  await ui.unmount()
})

test('plain, the default, draws no private-use glyph anywhere', async ($, on) => {
  const ui = await mountPane($, on)
  expect(await ownerGlyphs(ui)).toEqual(['✻', '◆', '★', '◎', '$', '⏸', '⇄'])
  const texts = (await ui.findAll({ type: 'Text' })).map((t: { text: string }) => t.text).join('\n')
  expect(texts).not.toMatch(PRIVATE_USE)
  // The legend still names each role once, other sessions under one label.
  expect(await ui.find({ type: 'Text', text: / other session$/ })).toBeDefined()
  await ui.unmount()
})
