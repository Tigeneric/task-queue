export type Task = { n: number; task: string; owner: string; status: 'done' | 'active' | 'waiting' | 'failed'; parked?: boolean }
export type Question = { q: string; blocks?: number[] }
export type Queue = {
  title: string
  updated: string
  note?: string
  purpose?: string
  bg?: string
  phase?: string
  coordinator?: true // `queue coordinator on`: the Stop hook reports idle sessions of this queue
  why?: Record<string, string> // a companion session's bare name → why it is idle
  questions?: (Question | string)[] // a plain string: a question written by hand
  tasks: Task[]
}

declare module 'claude-code' {
  interface PluginState {
    'task-queue': { isShown: boolean; expanded: number[] }
  }
}
