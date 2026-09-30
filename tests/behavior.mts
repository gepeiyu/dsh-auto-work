import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  createJob,
  settleExecution,
  startExecution,
  withSchedule,
} from '../src/core/jobs.ts'
import {
  intervalNextMs,
  isValidCron,
  nextRunAtMs,
  parseCron,
} from '../src/core/schedule.ts'
import { HostJobStore } from '../src/host/store.ts'
import { registerTimerTool } from '../src/host/tools.ts'

let passed = 0

function check(name: string, condition: unknown): void {
  assert.ok(condition, name)
  passed++
  console.log(`ok - ${name}`)
}

const now = new Date(2026, 0, 2, 8, 59, 0, 0).getTime()
const nextNine = nextRunAtMs('0 9 * * *', now)
check('parses a five-field cron expression', parseCron('*/15 9-17 * * 1-5') !== null)
check('rejects an invalid cron expression', !isValidCron('not a cron'))
check('computes the next cron slot', nextNine === new Date(2026, 0, 2, 9, 0, 0, 0).getTime())
check('computes a fixed interval from an anchor', intervalNextMs(now, 30, now) === now + 30 * 60_000)

const agentJob = createJob({
  title: 'agent job',
  description: '',
  prompt: 'run the scheduled work',
  target: { workdir: '', sessionId: '' },
}, now, 'job-agent')
const running = startExecution(agentJob, now, 'execution-agent', 'new-session')
const done = settleExecution(running.job, running.execution.id, 'succeeded', now + 1_000, undefined)
check('starts an execution in running state', running.job.status === 'running')
check('settles a recurring execution as done', done.status === 'done' && done.executions[0].result === 'succeeded')

const oneShot = withSchedule(
  createJob({
    title: 'one shot',
    description: '',
    prompt: 'run once',
    target: { workdir: '', sessionId: '' },
  }, now, 'job-once'),
  { enabled: true, cron: '', nextRunAt: now + 60_000 },
  now,
)
const oneShotRun = startExecution(oneShot, now, 'execution-once', 'new-session')
const archived = settleExecution(oneShotRun.job, oneShotRun.execution.id, 'failed', now + 1_000, 'expected test failure')
check('archives a consumed one-shot after failure', archived.status === 'archived')

const temp = await mkdtemp(join(tmpdir(), 'dsh-auto-work-behavior-'))
try {
  const store = new HostJobStore(join(temp, 'jobs.json'))
  await store.mutate(jobs => ({ jobs: [...jobs, agentJob], result: true }))
  const loaded = await store.load()
  check('persists and reloads the job ledger', loaded.length === 1 && loaded[0].id === 'job-agent')

  const registrations: any[] = []
  const disposer = registerTimerTool({
    register(def: unknown) {
      registrations.push(def)
      return () => {}
    },
  }, {
    store,
    runner: { requestRun: async () => true } as any,
    now: () => now,
  })
  check('registers the auto_work tool', registrations.length === 1 && registrations[0].name === 'auto_work')

  const tool = registrations[0]
  const created = await tool.execute({
    action: 'create',
    name: 'tool job',
    prompt: 'created through the tool',
    schedule: '0 9 * * *',
  })
  check('creates a scheduled job through auto_work', created.kind === 'create' && created.job?.title === 'tool job')

  const listed = await tool.execute({ action: 'list' })
  check('lists persisted jobs through auto_work', listed.kind === 'list' && listed.jobs.length === 2)
  disposer()
} finally {
  await rm(temp, { recursive: true, force: true })
}

console.log(`\n${passed} behavior checks passed`)
