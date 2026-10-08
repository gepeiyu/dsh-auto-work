import { spawn } from 'node:child_process'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { createJob, isDue, settleExecution, startExecution } from './core/model.js'
import { nextIntervalMs, nextRunAtMs } from './core/schedule.js'
import { assertTarget, ownerOf, sameOwner } from './policy.js'

function withIdentity(auth, identity, callback) {
  if (auth?.identityContext?.run) return auth.identityContext.run(identity, callback)
  return callback()
}

function sessionName(title, now) {
  const safe = title.toLowerCase().replace(/[^a-z0-9\u4e00-\u9fa5]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 24) || 'work'
  return `auto-${safe}-${new Date(now).toISOString().replace(/[-:TZ.]/g, '').slice(0, 14)}`
}

export class AutoWorkEngine {
  #ctx; #auth; #tenant; #store; #interval; #flights = new Map(); #disposed = false

  constructor({ ctx, auth, tenant, store, now = () => Date.now() }) {
    this.#ctx = ctx; this.#auth = auth; this.#tenant = tenant; this.#store = store; this.now = now
  }

  start() {
    if (this.#interval) return
    void this.tick()
    this.#interval = setInterval(() => void this.tick(), 30_000)
    this.#ctx.on?.('session/event', (session, event) => this.#onSessionEvent(session, event))
  }

  async dispose() {
    this.#disposed = true
    if (this.#interval) clearInterval(this.#interval)
    this.#interval = undefined
    for (const flight of this.#flights.values()) {
      try { flight.agent?.cancel?.({ kind: 'disposed' }) } catch {}
    }
    this.#flights.clear()
  }

  async create(input, identity) {
    const owner = ownerOf(identity)
    const target = await assertTarget(this.#tenant, owner, input.target)
    const job = createJob({ ...input, target, schedule: this.#scheduleFromInput(input) }, owner, this.now())
    const value = await this.#store.mutate(jobs => ({ jobs: [...jobs, job], value: job }))
    return value
  }

  async list(identity) { return this.#store.list(ownerOf(identity)) }

  async run(jobId, identity, extraPrompt = '') {
    const owner = ownerOf(identity)
    const result = await this.#store.mutate(jobs => {
      const job = jobs.find(item => item.id === jobId && sameOwner(item.owner, owner))
      if (!job || job.status === 'running' || job.status === 'archived') return undefined
      return this.#openRun(jobs, job, extraPrompt)
    })
    if (!result) return false
    void this.#execute(result.job, result.execution)
    return true
  }

  async remove(jobId, identity) {
    const owner = ownerOf(identity)
    return this.#store.mutate(jobs => {
      if (!jobs.some(item => item.id === jobId && sameOwner(item.owner, owner))) return undefined
      return { jobs: jobs.filter(item => !(item.id === jobId && sameOwner(item.owner, owner))), value: true }
    })
  }

  async update(jobId, changes, identity) {
    const owner = ownerOf(identity)
    let checkedTarget
    if (changes.target) checkedTarget = await assertTarget(this.#tenant, owner, changes.target)
    return this.#store.mutate(jobs => {
      const current = jobs.find(item => item.id === jobId && sameOwner(item.owner, owner))
      if (!current) return undefined
      const next = { ...current, updatedAt: this.now() }
      if (typeof changes.title === 'string' && changes.title.trim()) next.title = changes.title.trim()
      if (typeof changes.prompt === 'string' && changes.prompt.trim()) next.prompt = changes.prompt.trim()
      if (changes.kind === 'command' && typeof changes.command === 'string' && changes.command.trim()) {
        next.kind = 'command'; next.command = changes.command.trim(); next.args = typeof changes.args === 'string' ? changes.args.trim() : next.args ?? ''
      }
      if (changes.kind === 'agent') { delete next.kind; delete next.command; delete next.args }
      if (checkedTarget) next.target = checkedTarget
      if (changes.enabled === false && next.schedule) next.schedule = { ...next.schedule, enabled: false }
      if (changes.enabled === true && next.schedule) next.schedule = { ...next.schedule, enabled: true }
      if (changes.cron !== undefined) {
        const cron = typeof changes.cron === 'string' ? changes.cron.trim() : ''
        const nextRunAt = nextRunAtMs(cron, this.now())
        if (!cron || nextRunAt === undefined) throw new Error('invalid cron expression')
        next.schedule = { enabled: true, cron, nextRunAt }
      }
      return { jobs: jobs.map(item => item.id === jobId ? next : item), value: next }
    })
  }

  async tick() {
    if (this.#disposed) return 0
    const now = this.now(); let count = 0
    for (const job of await this.#store.loadAll()) {
      if (!isDue(job, now)) continue
      const fired = await this.#store.mutate(jobs => {
        const current = jobs.find(item => item.id === job.id)
        if (!current || !isDue(current, this.now())) return undefined
        const result = this.#openRun(jobs, current)
        const schedule = current.schedule
        const next = schedule?.intervalMinutes
          ? nextIntervalMs(schedule.nextRunAt, schedule.intervalMinutes, this.now())
          : schedule?.cron ? nextRunAtMs(schedule.cron, this.now()) : undefined
        const armed = { ...schedule, nextRunAt: next, lastTriggeredAt: this.now() }
        const opened = { ...result.value.job, schedule: armed }
        return { jobs: jobs.map(item => item.id === current.id ? opened : item), value: { ...result.value, job: opened } }
      })
      if (fired) { count += 1; void this.#execute(fired.job, fired.execution) }
    }
    return count
  }

  #scheduleFromInput(input) {
    const now = this.now()
    if (typeof input.runAt === 'number') return { enabled: true, nextRunAt: input.runAt }
    if (typeof input.intervalMinutes === 'number' && input.intervalMinutes > 0) {
      return { enabled: true, intervalMinutes: Math.round(input.intervalMinutes), nextRunAt: now + Math.round(input.intervalMinutes) * 60_000 }
    }
    if (typeof input.cron === 'string' && input.cron.trim()) {
      const cron = input.cron.trim(); const next = nextRunAtMs(cron, now)
      if (next === undefined) throw new Error('invalid cron expression')
      return { enabled: true, cron, nextRunAt: next }
    }
    throw new Error('one of cron, intervalMinutes, or runAt is required')
  }

  #openRun(jobs, job, extraPrompt = '') {
    const opened = startExecution(job, this.now())
    if (extraPrompt.trim()) opened.job.prompt = `${opened.job.prompt}\n\n${extraPrompt.trim()}`
    if (opened.job.schedule && !opened.job.schedule.cron && !opened.job.schedule.intervalMinutes) {
      opened.job.schedule = { ...opened.job.schedule, nextRunAt: undefined }
    }
    return { jobs: jobs.map(item => item.id === job.id ? opened.job : item), value: opened }
  }

  async #execute(job, execution) {
    const identity = ownerOf(job.owner)
    try {
      await assertTarget(this.#tenant, identity, job.target)
      const workdir = this.#workdirForTarget(job.target)
      if (job.kind === 'command') return await this.#executeCommand(job, execution, workdir)
      await withIdentity(this.#auth, identity, async () => {
        const agents = this.#ctx.agents
        let handle; let agent
        if (job.target.sessionId && agents.get?.(job.target.sessionId)) {
          agent = agents.get(job.target.sessionId)
          handle = { agent, dispose: async () => {} }
        } else if (job.target.sessionId) {
          const setup = await this.#presetSetupFor(job.target.sessionId)
          handle = await agents.resume({
            resumeSessionId: job.target.sessionId,
            ...this.#agentOptions(),
            ...(setup ? { setup } : {}),
          })
          agent = handle.agent
        } else {
          const preset = await this.#composePreset()
          handle = await agents.create({
            sessionId: sessionName(job.title, this.now()),
            ...this.#agentOptions(),
            ...(workdir || preset?.meta ? { meta: { ...(workdir ? { cwd: workdir } : {}), ...(preset?.meta ?? {}) } } : {}),
            ...(preset?.setup ? { setup: preset.setup } : {}),
          })
          agent = handle.agent
        }
        await this.#attachWorkspace(job.target, agent.session.id)
        await this.#store.mutate(jobs => {
          const current = jobs.find(item => item.id === job.id)
          if (!current) return undefined
          const executions = current.executions.map(item => item.id === execution.id ? { ...item, sessionId: agent.session.id } : item)
          return { jobs: jobs.map(item => item.id === job.id ? { ...item, executions, updatedAt: this.now() } : item), value: true }
        })
        const message = createUserMessage({ content: [{ type: 'text', text: job.prompt }], source: { kind: 'user' } })
        this.#flights.set(message.id, { jobId: job.id, executionId: execution.id, sessionId: agent.session.id, agent, handle })
        agent.followup(message)
      })
    } catch (error) {
      await this.#settle(job.id, execution.id, 'failed', error instanceof Error ? error.message : String(error))
    }
  }

  #workdirForTarget(target = {}) {
    if (target.workdir) return target.workdir
    if (!target.workspaceId) return ''
    const registry = this.#ctx.workspaceRegistry
    const workspace = registry?.get?.(target.workspaceId)
    if (workspace?.path) return workspace.path
    const rows = typeof registry?.list === 'function' ? registry.list() : []
    return rows.find(row => row?.id === target.workspaceId)?.path ?? ''
  }

  #agentOptions() {
    const selection = this.#ctx.agentDefaultModel?.currentSelection?.()
    if (!selection?.provider || !selection?.model) return {}
    return { agentOptions: { provider: selection.provider, model: selection.model, ...(selection.reasoningEffort ? { reasoningEffort: selection.reasoningEffort } : {}) } }
  }

  async #composePreset() {
    const presets = this.#ctx.agentPresets
    if (typeof presets?.resolve !== 'function' || typeof presets?.mount !== 'function') return undefined
    const resolved = await presets.resolve()
    if (!resolved?.id) return undefined
    return {
      meta: { agentPreset: resolved.id },
      setup: agentCtx => presets.mount(agentCtx, resolved.id),
    }
  }

  async #presetSetupFor(sessionId) {
    const presets = this.#ctx.agentPresets
    if (typeof presets?.resolve !== 'function' || typeof presets?.mount !== 'function') return undefined
    let recorded
    try {
      const query = this.#ctx.sessionQuery
      if (typeof query?.readSession === 'function') {
        const snapshot = await query.readSession(sessionId)
        for (const event of [...(snapshot?.events ?? [])].reverse()) {
          if (event?.type === 'agent-preset/selected' && typeof event.data?.agentPreset === 'string') {
            recorded = event.data.agentPreset
            break
          }
        }
        recorded ??= snapshot?.session?.agentPreset
      }
      if (!recorded) recorded = (await this.#ctx.sessionPersistence?.stat?.(sessionId))?.header?.agentPreset
    } catch {}
    try {
      const resolved = await presets.resolve(recorded)
      if (!resolved?.id) return undefined
      return agentCtx => presets.mount(agentCtx, resolved.id)
    } catch {
      return undefined
    }
  }

  async #attachWorkspace(target = {}, sessionId) {
    const registry = this.#ctx.workspaceRegistry
    if (!registry) return
    const workdir = this.#workdirForTarget(target)
    const workspace = (target.workspaceId ? registry.get?.(target.workspaceId) : undefined)
      ?? (workdir && typeof registry.resolveByPath === 'function' ? await registry.resolveByPath(workdir) : undefined)
      ?? (workdir && typeof registry.create === 'function' ? await registry.create(workdir) : undefined)
      ?? (typeof registry.list === 'function' ? registry.list().find(row => row?.id === target.workspaceId) : undefined)
    await workspace?.attachSession?.(sessionId)
  }

  async #executeCommand(job, execution, workdir = '') {
    const command = typeof job.command === 'string' ? job.command.trim() : ''
    if (!command) return await this.#settle(job.id, execution.id, 'failed', 'command is empty')
    const args = splitCommandArgs(job.args ?? '')
    const output = []
    await new Promise(resolve => {
      let child
      try { child = spawn(command, args, { cwd: workdir || undefined, env: process.env }) } catch (error) {
        void this.#settle(job.id, execution.id, 'failed', error instanceof Error ? error.message : String(error)).then(resolve); return
      }
      child.stdout?.on('data', chunk => output.push(String(chunk)))
      child.stderr?.on('data', chunk => output.push(String(chunk)))
      child.once('error', error => { void this.#settle(job.id, execution.id, 'failed', error.message, { output: output.join('').slice(-16_000) }).then(resolve) })
      child.once('close', code => { if (code === 0) void this.#settle(job.id, execution.id, 'succeeded', undefined, { exitCode: 0, output: output.join('').slice(-16_000) }).then(resolve); else void this.#settle(job.id, execution.id, 'failed', `command exited with code ${code}`, { exitCode: Number.isInteger(code) ? code : undefined, output: output.join('').slice(-16_000) }).then(resolve) })
    })
  }

  #onSessionEvent(session, event) {
    for (const [messageId, flight] of this.#flights) {
      if (flight.sessionId !== session.id) continue
      if (event.type === 'user/message' && event.data?.id === messageId) flight.consumed = true
      if (event.type === 'turn/end' && flight.consumed) {
        const failed = event.data?.reason?.kind === 'error'
        this.#flights.delete(messageId)
        void this.#settle(flight.jobId, flight.executionId, failed ? 'failed' : 'succeeded', failed ? event.data.reason.error?.message ?? 'turn failed' : undefined)
        if (flight.handle?.dispose) void flight.handle.dispose().catch(() => {})
      }
    }
  }

  async #settle(jobId, executionId, result, error, extra = {}) {
    await this.#store.mutate(jobs => {
      const job = jobs.find(item => item.id === jobId)
      if (!job || !job.executions.some(item => item.id === executionId && !item.endedAt)) return undefined
      return { jobs: jobs.map(item => item.id === jobId ? settleExecution(item, executionId, result, this.now(), error, extra) : item), value: true }
    })
  }
}

function splitCommandArgs(value) {
  const result = []; const pattern = /"([^"\\]*(?:\\.[^"\\]*)*)"|'([^']*)'|([^\s]+)/g; let match
  while ((match = pattern.exec(String(value))) !== null) result.push(match[1] ?? match[2] ?? match[3])
  return result
}
