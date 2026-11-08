import { expect, mock, test } from 'claude-code/testing'

// A turn that ends on a question to the owner not put in the queue is sent back once:
// bin/unasked decides (exit 1 + its one line), the Stop hook only carries the verdict.
function wire(on: any, verdict: { exitCode: number; stdout: string }, runs: string[][], stdins: (string | undefined)[] = []) {
  on('classic.Stop', () => ({}))  // the bottom: no settings hook beneath in a test
  on('session.id', () => ({ value: 'sess-1' }))
  mock.env(on, { HOME: '/home/t' })
  on('process.run', (_$: unknown, e: { argv: readonly string[]; init?: { stdin?: string } }) => {
    runs.push([...e.argv])
    stdins.push(e.init?.stdin)
    return { value: { ...verdict, stderr: '' } }
  })
}

test('an unqueued question blocks the stop with the detector line', async ($, on) => {
  const runs: string[][] = []
  wire(on, { exitCode: 1, stdout: 'вопрос оператору не в очереди: queue ask … --blocks …\n' }, runs)
  const r = await $.classic.Stop({ stop_hook_active: false, transcript_path: '/t/s.jsonl' } as never)
  expect(r.block).toBe('вопрос оператору не в очереди: queue ask … --blocks …')
  const argv = runs.find(a => a.some(x => x.endsWith('/bin/unasked')))!
  expect(argv).toContain('/t/s.jsonl')
  expect(argv).toContain('/home/t/.claude/task-queues/sess-1.json')
  expect(argv).not.toContain('--stop-hook-active')
})

test('a stop runs only its checks and writes nothing of its own', async ($, on) => {
  const runs: string[][] = []
  wire(on, { exitCode: 0, stdout: '' }, runs)
  await $.classic.Stop({ stop_hook_active: false, transcript_path: '/t/s.jsonl' } as never)
  const checks = ['unasked', 'stalls', 'compactready']
  expect(runs.filter(a => !checks.some(c => a.some(x => x.endsWith(`/bin/${c}`))))).toEqual([])
})

test('a clean turn stops, and a second stop passes the flag on', async ($, on) => {
  const runs: string[][] = []
  wire(on, { exitCode: 0, stdout: '' }, runs)
  const r = await $.classic.Stop({ stop_hook_active: true, transcript_path: '/t/s.jsonl' } as never)
  expect(r.block).toBeUndefined()
  expect(runs.find(a => a.some(x => x.endsWith('/bin/unasked')))).toContain('--stop-hook-active')
})

test('the final text from the Stop input goes to the detector on stdin', async ($, on) => {
  // The transcript may not hold the last message yet when Stop fires; the input does.
  const runs: string[][] = []
  const stdins: (string | undefined)[] = []
  wire(on, { exitCode: 0, stdout: '' }, runs, stdins)
  await $.classic.Stop({ stop_hook_active: false, transcript_path: '/t/s.jsonl', last_assistant_message: 'Сделать?' } as never)
  const i = runs.findIndex(a => a.some(x => x.endsWith('/bin/unasked')))
  expect(runs[i]).toContain('--last-message-stdin')
  expect(stdins[i]).toBe('Сделать?')
})

// Past the /compact threshold with no ready file, bin/compactready speaks (exit 1 + one line) and
// the Stop hook carries it — but only when the unqueued-question check had nothing to say.
function wireBoth(on: any, unasked: { exitCode: number; stdout: string }, compact: { exitCode: number; stdout: string }, runs: string[][]) {
  on('classic.Stop', () => ({}))
  on('session.id', () => ({ value: 'sess-1' }))
  mock.env(on, { HOME: '/home/t' })
  on('process.run', (_$: unknown, e: { argv: readonly string[] }) => {
    runs.push([...e.argv])
    const v = e.argv.some(x => x.endsWith('/bin/compactready')) ? compact : e.argv.some(x => x.endsWith('/bin/unasked')) ? unasked : { exitCode: 0, stdout: '' }
    return { value: { ...v, stderr: '' } }
  })
}

test('a session past the compact threshold without a ready file is told the file', async ($, on) => {
  const runs: string[][] = []
  wireBoth(on, { exitCode: 0, stdout: '' }, { exitCode: 1, stdout: 'контекст 82 %: … compact-ready/Noor.txt\n' }, runs)
  const r = await $.classic.Stop({ stop_hook_active: false, transcript_path: '/t/s.jsonl' } as never)
  expect(r.block).toBe('контекст 82 %: … compact-ready/Noor.txt')
  const argv = runs.find(a => a.some(x => x.endsWith('/bin/compactready')))!
  expect(argv).toContain('/t/s.jsonl')
  expect(argv).toContain('sess-1')
})

test('the unqueued-question line wins over the compact nudge', async ($, on) => {
  const runs: string[][] = []
  wireBoth(on, { exitCode: 1, stdout: 'вопрос оператору не в очереди: queue ask … --blocks …\n' }, { exitCode: 1, stdout: 'контекст 82 %' }, runs)
  const r = await $.classic.Stop({ stop_hook_active: false, transcript_path: '/t/s.jsonl' } as never)
  expect(r.block).toBe('вопрос оператору не в очереди: queue ask … --blocks …')
})

// Coordinator mode: bin/stalls --coordinator decides (silent unless the queue has the mode on,
// exit 1 + the untold reports); the Stop hook carries its lines after the unqueued question.
type Verdict = { exitCode: number; stdout: string }
function wireAll(on: any, verdicts: { unasked?: Verdict; stalls?: Verdict; compact?: Verdict }, runs: string[][]) {
  on('classic.Stop', () => ({}))
  on('session.id', () => ({ value: 'sess-1' }))
  mock.env(on, { HOME: '/home/t' })
  const quiet = { exitCode: 0, stdout: '' }
  on('process.run', (_$: unknown, e: { argv: readonly string[] }) => {
    runs.push([...e.argv])
    const is = (bin: string) => e.argv.some(x => x.endsWith(`/bin/${bin}`))
    const v = (is('stalls') ? verdicts.stalls : is('compactready') ? verdicts.compact : is('unasked') ? verdicts.unasked : undefined) ?? quiet
    return { value: { ...v, stderr: '' } }
  })
}

test('a coordinator stop is sent back with the stalls report', async ($, on) => {
  const runs: string[][] = []
  wireAll(on, { stalls: { exitCode: 1, stdout: 'Ivy: 20 min idle with #5\nOtto: 17 min idle, next: #6\n' } }, runs)
  const r = await $.classic.Stop({ stop_hook_active: false, transcript_path: '/t/s.jsonl' } as never)
  expect(r.block).toBe('Ivy: 20 min idle with #5\nOtto: 17 min idle, next: #6')
  const argv = runs.find(a => a.some(x => x.endsWith('/bin/stalls')))!
  expect(argv).toContain('--coordinator')
  expect(argv).toContain('/home/t/.claude/task-queues/sess-1.json')
})

test('a silent stalls run lets the stop through to the compact nudge', async ($, on) => {
  const runs: string[][] = []
  wireAll(on, { compact: { exitCode: 1, stdout: 'контекст 82 %' } }, runs)
  const r = await $.classic.Stop({ stop_hook_active: false, transcript_path: '/t/s.jsonl' } as never)
  expect(r.block).toBe('контекст 82 %')
  expect(runs.some(a => a.some(x => x.endsWith('/bin/stalls')))).toBe(true)
})

test('the unqueued-question line wins over a stalls report', async ($, on) => {
  const runs: string[][] = []
  wireAll(on, { unasked: { exitCode: 1, stdout: 'вопрос оператору не в очереди' }, stalls: { exitCode: 1, stdout: 'Ivy: 20 min idle with #5' } }, runs)
  const r = await $.classic.Stop({ stop_hook_active: false, transcript_path: '/t/s.jsonl' } as never)
  expect(r.block).toBe('вопрос оператору не в очереди')
})

// SessionStart names coordinator mode once and tells the session to launch its watcher; it launches nothing itself.
function wireStart(on: any, queue: unknown, runs: string[][]) {
  on('classic.SessionStart', () => ({}))
  on('session.id', () => ({ value: 'sess-1' }))
  mock.env(on, { HOME: '/home/t' })
  on('fs.exists', () => ({ value: queue !== undefined }))
  on('fs.read', () => ({ value: JSON.stringify(queue) }))
  on('process.run', (_$: unknown, e: { argv: readonly string[] }) => {
    runs.push([...e.argv])
    return { value: { exitCode: 0, stdout: '', stderr: '' } }
  })
}

test('a coordinator queue is named once at session start, with nothing launched', async ($, on) => {
  const runs: string[][] = []
  wireStart(on, { title: 't', coordinator: true, tasks: [] }, runs)
  const r = await $.classic.SessionStart({ source: 'resume' } as never)
  expect(r.additionalContext?.length).toBe(1)
  expect(r.additionalContext?.[0]).toContain('coordinator mode is on')
  expect(r.additionalContext?.[0]).toMatch(/launch a background `\/\S+\/bin\/stalls --file \/home\/t\/\.claude\/task-queues\/sess-1\.json --wait` now/)
  expect(runs.filter(a => a.some(x => x.includes('stalls')))).toEqual([])
})

test('a queue without coordinator mode, or no queue, adds nothing at start', async ($, on) => {
  const runs: string[][] = []
  wireStart(on, { title: 't', tasks: [] }, runs)
  const r = await $.classic.SessionStart({ source: 'startup' } as never)
  expect(r.additionalContext ?? []).toEqual([])
})

// The line is bin/unasked's, English unless asked; under ru the hook asks it for the Russian
// one, under en the argv carries no language.
test('under ru the detector is asked for its Russian line', { options: { language: 'ru' } }, async ($, on) => {
  const runs: string[][] = []
  wire(on, { exitCode: 0, stdout: '' }, runs)
  await $.classic.Stop({ stop_hook_active: false, transcript_path: '/t/s.jsonl' } as never)
  const argv = runs.find(a => a.some(x => x.endsWith('/bin/unasked')))!
  expect(argv.slice(-2)).toEqual(['--lang', 'ru'])
})

test('under en, the default, the detector argv carries no language', async ($, on) => {
  const runs: string[][] = []
  wire(on, { exitCode: 0, stdout: '' }, runs)
  await $.classic.Stop({ stop_hook_active: false, transcript_path: '/t/s.jsonl' } as never)
  expect(runs.find(a => a.some(x => x.endsWith('/bin/unasked')))).not.toContain('--lang')
})
