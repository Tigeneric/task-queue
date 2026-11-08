import { expect, mock, test } from 'claude-code/testing'

// /queue opens the pane; it asks Claude to fill an empty queue, and to bring a kept one up to date
// only when the pane is already open. Before the command the instructions are not in Claude's
// prompt, so without the fill a session's first pane stays empty; a kept queue opened after a
// restart is shown as it stands, since waking a resumed session for it may re-write a cold cache.
const KEPT = { title: 't', tasks: [{ n: 1, task: 'x', owner: 'я', status: 'active' }] }

function wire(on: any, queue: unknown, isOpen: boolean, sent: string[]) {
  on('session.id', () => ({ value: 'sess-1' }))
  mock.env(on, { HOME: '/home/t' })
  const clock = mock.clock(on)
  on('session.start', () => ({ cwd: '/w' }))
  on('fs.exists', () => ({ value: queue !== undefined }))
  on('fs.read', () => ({ value: JSON.stringify(queue) }))
  on('process.run', () => ({ value: { exitCode: 0, stdout: '{}', stderr: '' } }))
  on('ui.open', () => ({ value: { isPlaced: true as const } }))
  on('ui.panes', () => ({
    value: isOpen ? [{ id: 'task-queue', title: 'Task queue', isShown: true, isFocused: false, isPlaced: true }] : [],
  }))
  on('prompt.submit', (_$: unknown, e: { text: string }) => {
    sent.push(e.text)
    return { text: e.text }
  })
  return clock
}

async function run($: any, on: any, queue: unknown, isOpen: boolean): Promise<string[]> {
  const sent: string[] = []
  const clock = wire(on, queue, isOpen, sent)
  await $.session.start({ cwd: '/w', surface: 'terminal' } as never)
  await $.command.run({ command: 'queue' })
  await clock.advance(1)
  return sent
}

test('/queue with the pane closed on a missing queue asks Claude to fill it', async ($, on) => {
  const sent = await run($, on, undefined, false)
  expect(sent.length).toBe(1)
  expect(sent[0]).toMatch(/queue is empty: fill it/)
})

test('/queue with the pane closed on a kept queue only opens the pane', async ($, on) => {
  const sent = await run($, on, KEPT, false)
  expect(sent).toEqual([])
})

test('/queue with the pane open on a kept queue asks Claude to bring it up to date', async ($, on) => {
  const sent = await run($, on, KEPT, true)
  expect(sent.length).toBe(1)
  expect(sent[0]).toMatch(/bring the queue up to date/)
})

test('/queue with the pane open on an empty queue asks Claude to fill it', async ($, on) => {
  const sent = await run($, on, { title: 't', tasks: [] }, true)
  expect(sent.length).toBe(1)
  expect(sent[0]).toMatch(/queue is empty: fill it/)
})
