import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createJob, startExecution, withSchedule } from '../src/core/jobs.ts'
import { HostJobStore } from '../src/host/store.ts'
import { TimerRunner } from '../src/host/runner.ts'
import { turnErrorDetail } from '../src/host/contracts.ts'

const now = Date.now()
const temp = await mkdtemp(join(tmpdir(), 'dsh-auto-work-runner-'))
let passed = 0
const job = (id: string) => createJob({ title: id, description: '', prompt: 'scheduled prompt', target: { workdir: '', sessionId: 'pinned' } }, now, id)

function harness(store: HostJobStore, events: any[] = [], live?: any) {
  const listeners = new Map<string, Function[]>()
  const cleanups: Function[] = []
  const resumed: any[] = []
  const agent: any = { id: 'pinned', session: { id: 'pinned' }, cancel() {}, followup() {} }
  const emit = (name: string, ...args: any[]) => { for (const listener of listeners.get(name) ?? []) listener(...args) }
  const ctx: any = {
    agents: {
      get: () => live,
      withoutInitiator: (operation: Function) => operation(),
      resume: async (options: any) => { resumed.push(options); return { agent, dispose: async () => {} } },
    },
    sessions: { flush: async () => true },
    get: (name: string) => name === 'sessionQuery'
      ? { readSession: async () => ({ session: {}, events }) }
      : name === 'agentDefaultModel' ? { currentSelection: () => ({ provider: 'default-provider', model: 'default-model' }) } : undefined,
    effect: (setup: Function) => { cleanups.push(setup()); return () => {} },
    on: (name: string, listener: Function) => {
      listeners.set(name, [...(listeners.get(name) ?? []), listener])
      return () => { listeners.set(name, (listeners.get(name) ?? []).filter(fn => fn !== listener)) }
    },
  }
  const runner = new TimerRunner({ ctx, store, now: () => now })
  return { runner, agent, resumed, emit, cleanups }
}

async function waitFor(store: HostJobStore, predicate: (jobs: any[]) => boolean) {
  for (let i = 0; i < 100; i++) {
    const jobs = await store.load()
    if (predicate(jobs)) return jobs
    await new Promise(resolve => setTimeout(resolve, 10))
  }
  assert.fail('execution did not reach the expected state')
}

async function test(name: string, body: (store: HostJobStore) => Promise<void>) {
  await body(new HostJobStore(join(temp, `${passed}.json`)))
  passed++
  console.log(`ok - ${name}`)
}

try {
  await test('settles a claimed prompt that fails before user/message and restores the cold session model', async store => {
    await store.mutate(() => ({ jobs: [job('assembly-failure')], result: true }))
    const h = harness(store, [{ type: 'request/header', data: { header: { config: { provider: 'saved-provider', model: 'saved-model' } } } }])
    h.agent.followup = (message: any) => {
      h.emit('agent/inbox/claimed', { agent: h.agent, message, turn: 14 })
      h.emit('session/event', h.agent.session, { type: 'turn/end', data: { turn: 14, reason: { kind: 'error', error: { message: 'prompt assembly failed' } } } })
    }
    h.runner.start()
    try {
      assert.equal(await h.runner.requestRun('assembly-failure'), true)
      const [ended] = await waitFor(store, jobs => jobs[0].status === 'failed')
      assert.equal(ended.executions[0].error, 'prompt assembly failed')
      assert.equal(ended.executions[0].turn, 14)
      assert.ok(ended.executions[0].messageId)
      assert.deepEqual(h.resumed[0].agentOptions, { provider: 'saved-provider', model: 'saved-model' })
    } finally { await h.runner.dispose() }
  })

  await test('does not settle the wrong turn in a shared session', async store => {
    await store.mutate(() => ({ jobs: [job('shared-session')], result: true }))
    const h = harness(store)
    let delivery: any
    h.agent.followup = (message: any) => { delivery = message; h.emit('agent/inbox/claimed', { agent: h.agent, message, turn: 8 }) }
    h.runner.start()
    try {
      await h.runner.requestRun('shared-session')
      await waitFor(store, () => delivery !== undefined)
      assert.deepEqual(h.resumed[0].agentOptions, { provider: 'default-provider', model: 'default-model' })
      h.emit('session/event', h.agent.session, { type: 'turn/end', data: { turn: 7, reason: { kind: 'completed' } } })
      assert.equal((await store.load())[0].status, 'running')
      h.emit('session/event', h.agent.session, { type: 'turn/end', data: { turn: 8, reason: { kind: 'completed' } } })
      assert.equal((await waitFor(store, jobs => jobs[0].status === 'done'))[0].executions[0].result, 'succeeded')
    } finally { await h.runner.dispose() }
  })

  await test('settles discarded scheduled messages', async store => {
    await store.mutate(() => ({ jobs: [job('discarded')], result: true }))
    const h = harness(store)
    h.agent.followup = (message: any) => h.emit('agent/inbox/discarded', { agent: h.agent, message })
    h.runner.start()
    try {
      await h.runner.requestRun('discarded')
      await waitFor(store, jobs => jobs[0].status === 'failed')
    } finally { await h.runner.dispose() }
  })

  await test('recovers an orphan after restart without rerunning an overdue schedule', async store => {
    const scheduled = withSchedule(job('orphan'), { enabled: true, cron: '0 7 * * *', nextRunAt: now - 60_000 }, now)
    const opened = startExecution(scheduled, now - 60_000, 'lost-execution', 'specified-session').job
    await store.mutate(() => ({ jobs: [opened], result: true }))
    const h = harness(store)
    try {
      assert.equal(await h.runner.tick(), 0)
      const [recovered] = await store.load()
      assert.equal(recovered.status, 'failed')
      assert.match(recovered.executions[0].error!, /restart/)
      assert.ok(recovered.schedule!.nextRunAt! > now)
      assert.equal(h.resumed.length, 0)
    } finally { await h.runner.dispose() }
  })

  await test('recovers the exact persisted turn result and preserves other turn results', async store => {
    const opened = startExecution(job('recovered'), now - 60_000, 'recovered-execution', 'specified-session').job
    Object.assign(opened.executions[0], { sessionId: 'pinned', messageId: 'message', turn: 3 })
    await store.mutate(() => ({ jobs: [opened], result: true }))
    const h = harness(store, [
      { type: 'turn/end', time: now - 2000, data: { turn: 2, reason: { kind: 'completed' } } },
      { type: 'turn/end', time: now - 1000, data: { turn: 3, reason: { kind: 'error', error: { message: 'saved failure' } } } },
    ])
    try {
      await h.runner.tick()
      const [recovered] = await store.load()
      assert.equal(recovered.status, 'failed')
      assert.equal(recovered.executions[0].error, 'saved failure')
      assert.equal(recovered.executions[0].endedAt, now - 1000)
    } finally { await h.runner.dispose() }
  })

  for (const kind of ['aborted', 'blocked', 'max-tokens', 'interrupted']) {
    assert.notEqual(turnErrorDetail({ turn: 1, reason: { kind } }), '')
  }
  console.log(`\n${passed} runner regression checks passed`)
} finally { await rm(temp, { recursive: true, force: true }) }
