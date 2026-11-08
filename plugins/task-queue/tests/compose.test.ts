import { expect, mock, test } from 'claude-code/testing'

// The section costs tokens on every request, so it must appear only once the
// person has asked for the pane.
const INPUT = { model: 'm', promptModel: 'm', surfaces: [], tools: [], outputStyle: null, traits: [] }

test('the instructions section appears only after /queue', async ($, on) => {
  on('prompt.compose', () => ({ sections: [{ id: 'intro', text: 'base', scope: 'shared' as const }] }))
  on('command.run', () => ({ text: '' }))
  on('ui.open', () => ({ value: { isPlaced: true as const } }))
  on('session.id', () => ({ value: 'sess-1' }))
  mock.env(on, { HOME: '/home/t' })

  const before = await $.prompt.compose(INPUT)
  expect(before.sections.map(s => s.id)).toEqual(['intro'])

  await $.command.run({ command: 'queue' })

  const after = await $.prompt.compose(INPUT)
  expect(after.sections.map(s => s.id)).toEqual(['intro', 'task-queue:instructions'])
  const text = after.sections[1]?.text ?? ''
  // Claude is told the CLI with this session's file, not the JSON schema.
  expect(text).toMatch(/`\/\S+\/bin\/queue --file \/home\/t\/\.claude\/task-queues\/sess-1\.json …`/)
  expect(text).toContain('start|done|wait|fail N...')
  expect(text).not.toContain('"status"')
  // #n in a row means a queue task; another numbering in a task's text reads as one.
  expect(text).toMatch(/#n.*only.*this queue/)
  // An idle companion session owes a reason, recorded for the cold · free box.
  expect(text).toContain('`why NAME TEXT`')
  expect(text).toMatch(/Every companion session/)
  expect(text).not.toMatch(/swarm/)
  // A coordinator turns coordinator mode on for its own queue: the Stop hook watches, not a
  // background job that dies with its shell. Its limit is said: it checks only when this session stops.
  expect(text).toMatch(/`\/\S+\/bin\/queue --file \/home\/t\/\.claude\/task-queues\/sess-1\.json coordinator on`/)
  expect(text).toMatch(/runs only when this session stops/)
  // stalls --wait stays beside it whenever the mode is on: it wakes a silent coordinator.
  expect(text).toMatch(/background `\/\S+\/bin\/stalls --file \/home\/t\/\.claude\/task-queues\/sess-1\.json --wait`/)
  expect(text).not.toMatch(/keep a background Bash run of/)
  expect(text).toMatch(/while coordinator mode is on also keep a background/)
  expect(text).toMatch(/says once when it is gone/)
  // It reports idle sessions with waiting work too, and a recorded reason does not excuse idling with UP NEXT rows.
  expect(text).toContain('next: #')
  expect(text).toMatch(/not a reason to idle/)
})
