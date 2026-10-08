import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { JobStore } from '../src/store.js'
import { AutoWorkEngine } from '../src/engine.js'
import { isValidCron, nextIntervalMs, nextRunAtMs } from '../src/core/schedule.js'
import { assertTarget } from '../src/policy.js'
import { apply } from '../src/index.js'
import { decorateTargets } from '../src/routes.js'
import { registerAutoWorkTool } from '../src/tools.js'

test('schedule parser supports cron and interval without replaying current minute', () => {
  assert.equal(isValidCron('0 9 * * *'), true)
  assert.equal(isValidCron('bad expression'), false)
  const now = new Date(2026, 0, 1, 8, 30, 0, 0).getTime()
  assert.equal(new Date(nextRunAtMs('0 9 * * *', now)).getHours(), 9)
  assert.equal(nextIntervalMs(now, 10, now), now + 10 * 60_000)
})

test('store lists only the requested owner', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-auto-work-'))
  const store = new JobStore(join(dir, 'jobs.json'))
  const alice = { organizationId: 'org', userId: 'alice' }
  const bob = { organizationId: 'org', userId: 'bob' }
  await store.mutate(() => ({ jobs: [{ id: 'a', owner: alice, title: 'a', prompt: 'a', status: 'idle' }, { id: 'b', owner: bob, title: 'b', prompt: 'b', status: 'idle' }], value: true }))
  assert.deepEqual((await store.list(alice)).map(job => job.id), ['a'])
  assert.deepEqual((await store.list(bob)).map(job => job.id), ['b'])
  await rm(dir, { recursive: true, force: true })
})

test('target validation delegates to tenant policy', async () => {
  const calls = []
  const tenant = {
    assertSessionLocation(identity, id) { calls.push(['session', identity.userId, id]) },
    assertWorkspaceLocation(identity, id) { calls.push(['workspace', identity.userId, id]); return { id } },
    assertWorkspacePath(identity, path) { calls.push(['path', identity.userId, path]); return `/owned/${identity.userId}/${path.split('/').pop()}` },
  }
  const target = await assertTarget(tenant, { organizationId: 'org', userId: 'alice' }, { sessionId: 's1', workspaceId: 'w1', workdir: '/tmp/project' })
  assert.equal(target.workdir, '/owned/alice/project')
  assert.deepEqual(calls, [['session', 'alice', 's1'], ['workspace', 'alice', 'w1'], ['path', 'alice', '/tmp/project']])
})

test('target projection includes tenant-scoped workspace and session names', async () => {
  const identity = { organizationId: 'org', userId: 'alice' }
  const tenant = {
    listOwnedWorkspaces: () => [{ id: 'w1' }],
    listOwnedSessions: () => [{ id: 's1' }],
    canAccessWorkspaceLocation: async () => true,
    canAccessSessionLocation: async () => true,
  }
  const result = await decorateTargets({ tenant, identity, resources: {
    workspaceRegistry: { list: () => [{ id: 'w1', title: '项目一', path: '/work/project' }] },
    sessions: { get: () => ({ header: { title: '每日报告', cwd: '/work/project' } }) },
    sessionController: { list: async () => ({ items: [{ sessionId: 's1', projections: { values: { title: '销售报告会话' } } }] }) },
  } })
  assert.equal(result.workspaces[0].title, '项目一')
  assert.equal(result.sessions[0].title, '销售报告会话')
  assert.equal(result.sessions[0].workspaceId, 'w1')
})

test('engine rejects a cross-owner run and creates scoped work', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-auto-work-'))
  const store = new JobStore(join(dir, 'jobs.json'))
  const tenant = { assertWorkspacePath: (_identity, path) => path }
  const ctx = { agents: { create: async () => { throw new Error('must not execute') } } }
  const engine = new AutoWorkEngine({ ctx, auth: {}, tenant, store, now: () => 1_700_000_000_000 })
  const owner = { organizationId: 'org', userId: 'alice' }
  const job = await engine.create({ title: 'private', prompt: 'run', runAt: 1_700_000_060_000, target: { workdir: '/tmp/a' } }, owner)
  assert.equal((await engine.list(owner)).length, 1)
  assert.equal(await engine.run(job.id, { organizationId: 'org', userId: 'bob' }), false)
  await engine.dispose()
  await rm(dir, { recursive: true, force: true })
})

test('scheduled agent execution is settled from session events', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-auto-work-'))
  const store = new JobStore(join(dir, 'jobs.json'))
  const events = []
  let agent
  const ctx = {
    on(_name, handler) { events.push(handler) },
    agents: {
      async create() {
        agent = { session: { id: 'session-created' }, followup(message) {
          events[0]?.({ id: 'session-created' }, { type: 'user/message', data: { id: message.id } })
          events[0]?.({ id: 'session-created' }, { type: 'turn/end', data: { reason: { kind: 'completed' } } })
        } }
        return { agent, dispose: async () => {} }
      },
    },
  }
  const auth = { identityContext: { run(_identity, callback) { return callback() } } }
  const tenant = { assertWorkspacePath: (_identity, path) => path }
  const engine = new AutoWorkEngine({ ctx, auth, tenant, store, now: () => 1_700_000_000_000 })
  const owner = { organizationId: 'org', userId: 'alice' }
  engine.start()
  try {
    const job = await engine.create({ title: 'scheduled', prompt: 'do it', runAt: 1_699_999_999_000, target: {} }, owner)
    assert.equal(await engine.tick(), 1)
    await new Promise(resolve => setTimeout(resolve, 20))
    const saved = (await engine.list(owner)).find(item => item.id === job.id)
    assert.equal(saved.status, 'archived')
    assert.equal(saved.executions[0].result, 'succeeded')
  } finally {
    await engine.dispose()
    await rm(dir, { recursive: true, force: true })
  }
})

test('new agent runs persist the selected DSH 0.2 preset and model options', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-auto-work-'))
  const store = new JobStore(join(dir, 'jobs.json'))
  const created = []
  const mounted = []
  const ctx = {
    agentDefaultModel: { currentSelection: () => ({ provider: 'deepseek', model: 'deepseek-chat', reasoningEffort: 'high' }) },
    agentPresets: {
      resolve: async (id) => ({ id: id ?? 'web' }),
      mount: async (_agentCtx, id) => { mounted.push(id) },
    },
    agents: {
      async create(options) {
        created.push(options)
        return { agent: { session: { id: 'session-preset' }, followup() {} }, dispose: async () => {} }
      },
    },
  }
  const auth = { identityContext: { run(_identity, callback) { return callback() } } }
  const tenant = { assertWorkspacePath: (_identity, path) => path }
  const engine = new AutoWorkEngine({ ctx, auth, tenant, store, now: () => 1_700_000_000_000 })
  const owner = { organizationId: 'org', userId: 'alice' }
  try {
    const job = await engine.create({ title: 'preset', prompt: 'run', runAt: 1_699_999_999_000, target: {} }, owner)
    assert.equal(await engine.run(job.id, owner), true)
    await new Promise(resolve => setTimeout(resolve, 20))
    assert.equal(created.length, 1)
    assert.deepEqual(created[0].meta, { agentPreset: 'web' })
    assert.deepEqual(created[0].agentOptions, { provider: 'deepseek', model: 'deepseek-chat', reasoningEffort: 'high' })
    assert.equal(typeof created[0].setup, 'function')
    await created[0].setup({})
    assert.deepEqual(mounted, ['web'])
  } finally {
    await engine.dispose()
    await rm(dir, { recursive: true, force: true })
  }
})

test('resumed sessions restore the preset recorded in the DSH 0.2 session log', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-auto-work-'))
  const store = new JobStore(join(dir, 'jobs.json'))
  const resumed = []
  const mounted = []
  const ctx = {
    sessionQuery: { readSession: async () => ({ session: {}, events: [{ type: 'agent-preset/selected', data: { agentPreset: 'coding' } }] }) },
    agentPresets: {
      resolve: async (id) => ({ id: id ?? 'web' }),
      mount: async (_agentCtx, id) => { mounted.push(id) },
    },
    agents: {
      async resume(options) {
        resumed.push(options)
        return { agent: { session: { id: 'session-existing' }, followup() {} }, dispose: async () => {} }
      },
    },
  }
  const auth = { identityContext: { run(_identity, callback) { return callback() } } }
  const tenant = { assertSessionLocation() {} }
  const engine = new AutoWorkEngine({ ctx, auth, tenant, store, now: () => 1_700_000_000_000 })
  const owner = { organizationId: 'org', userId: 'alice' }
  try {
    const job = await engine.create({ title: 'resume', prompt: 'continue', runAt: 1_699_999_999_000, target: { sessionId: 'session-existing' } }, owner)
    assert.equal(await engine.run(job.id, owner), true)
    await new Promise(resolve => setTimeout(resolve, 20))
    assert.equal(resumed.length, 1)
    assert.equal(resumed[0].resumeSessionId, 'session-existing')
    assert.equal(typeof resumed[0].setup, 'function')
    await resumed[0].setup({})
    assert.deepEqual(mounted, ['coding'])
  } finally {
    await engine.dispose()
    await rm(dir, { recursive: true, force: true })
  }
})

test('command jobs execute directly and retain output', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-auto-work-'))
  const store = new JobStore(join(dir, 'jobs.json'))
  const tenant = { assertWorkspacePath: (_identity, path) => path }
  const engine = new AutoWorkEngine({ ctx: {}, auth: {}, tenant, store, now: () => 1_700_000_000_000 })
  const owner = { organizationId: 'org', userId: 'alice' }
  try {
    const job = await engine.create({ title: 'command', kind: 'command', command: '/bin/sh', args: '-c "printf migrated"', runAt: 1_699_999_999_000, target: {} }, owner)
    assert.equal(await engine.tick(), 1)
    await new Promise(resolve => setTimeout(resolve, 40))
    const saved = (await engine.list(owner)).find(item => item.id === job.id)
    assert.equal(saved.status, 'archived')
    assert.equal(saved.executions[0].result, 'succeeded')
    assert.match(saved.executions[0].output, /migrated/)
  } finally {
    await engine.dispose()
    await rm(dir, { recursive: true, force: true })
  }
})

test('auto_work tool creates command jobs without an Agent prompt', async () => {
  let created
  const registered = []
  registerAutoWorkTool({ register(tool) { registered.push(tool); return () => {} } }, {
    auth: { currentIdentity: () => ({ organizationId: 'org', userId: 'alice' }) },
    engine: { create: async (input, identity) => { created = { input, identity }; return { id: 'command-job', ...input } } },
  })
  assert.deepEqual(registered[0].parameters.required, ['action'])
  const result = await registered[0].execute({ action: 'create', title: '同步文件', kind: 'command', command: '/bin/sh', args: '-c "echo ok"', cron: '0 9 * * *' })
  assert.equal(result.kind, 'created')
  assert.equal(created.input.kind, 'command')
  assert.equal(created.input.prompt, undefined)
  assert.equal(created.input.command, '/bin/sh')
  assert.equal(created.input.args, '-c "echo ok"')
})

test('plugin bootstrap resolves host services through Cordis injection', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-auto-work-'))
  const registeredRoutes = []
  const registeredTools = []
  const sections = []
  const disposers = []
  const services = {
    webServer: { register(route) { registeredRoutes.push(route); return () => {} } },
    tools: { register(tool) { registeredTools.push(tool); return () => {} } },
    agents: {},
    workosAuth: { currentIdentity: () => ({ organizationId: 'org', userId: 'alice' }) },
    tenantPolicy: {},
    systemPrompt: { section(value) { sections.push(value); return () => {} } },
  }
  const ctx = {
    inject(names, callback) {
      assert.deepEqual(names, ['webServer', 'tools', 'agents', 'workosAuth', 'tenantPolicy', 'systemPrompt'])
      callback(services)
    },
    effect(callback) { disposers.push(callback()) },
  }
  try {
    apply(ctx, { storePath: join(dir, 'jobs.json') })
    assert.equal(registeredRoutes.length, 3)
    assert.equal(registeredTools.length, 1)
    assert.equal(sections.length, 1)
  } finally {
    for (const dispose of disposers) await dispose?.()
    await rm(dir, { recursive: true, force: true })
  }
})
