import { randomUUID } from 'node:crypto'

export function normalizeTarget(target = {}) {
  return {
    sessionId: typeof target.sessionId === 'string' ? target.sessionId.trim() : '',
    workspaceId: typeof target.workspaceId === 'string' ? target.workspaceId.trim() : '',
    workdir: typeof target.workdir === 'string' ? target.workdir.trim() : '',
  }
}

export function createJob(input, owner, now = Date.now()) {
  const title = typeof input.title === 'string' ? input.title.trim() : ''
  const prompt = typeof input.prompt === 'string' ? input.prompt.trim() : ''
  const kind = input.kind === 'command' ? 'command' : 'agent'
  const command = typeof input.command === 'string' ? input.command.trim() : ''
  if (!title) throw new Error('title is required')
  if (kind === 'agent' && !prompt) throw new Error('prompt is required')
  if (kind === 'command' && !command) throw new Error('command is required')
  return {
    id: randomUUID(), version: 1, owner: { ...owner }, title, prompt,
    ...(kind === 'command' ? { kind, command, args: typeof input.args === 'string' ? input.args.trim() : '' } : {}),
    target: normalizeTarget(input.target), status: 'idle',
    createdAt: now, updatedAt: now, executions: [],
    schedule: input.schedule ? { ...input.schedule } : undefined,
  }
}

export function isJob(value) {
  return Boolean(value && typeof value === 'object' && typeof value.id === 'string' &&
    value.owner && typeof value.owner.organizationId === 'string' &&
    typeof value.owner.userId === 'string' && typeof value.title === 'string' &&
    typeof value.prompt === 'string' && (value.kind !== 'command' || typeof value.command === 'string') && ['idle', 'running', 'done', 'failed', 'archived'].includes(value.status))
}

export function isDue(job, now = Date.now()) {
  return job.status !== 'archived' && job.status !== 'running' &&
    job.schedule?.enabled === true && Number.isFinite(job.schedule.nextRunAt) && job.schedule.nextRunAt <= now
}

export function startExecution(job, now = Date.now()) {
  const execution = {
    id: randomUUID(), sessionId: undefined, targeting: job.kind === 'command' ? 'command' : job.target?.sessionId ? 'specified-session' : 'new-session', startedAt: now,
    endedAt: undefined, result: undefined, error: undefined,
  }
  return { job: { ...job, status: 'running', updatedAt: now, executions: [...job.executions, execution] }, execution }
}

export function settleExecution(job, executionId, result, now = Date.now(), error, extra = {}) {
  const executions = job.executions.map(item => item.id === executionId
    ? { ...item, endedAt: now, result, ...(error ? { error } : {}), ...(Number.isInteger(extra.exitCode) ? { exitCode: extra.exitCode } : {}), ...(typeof extra.output === 'string' ? { output: extra.output } : {}) } : item)
  const oneShot = job.schedule && !job.schedule.cron && !job.schedule.intervalMinutes
  return {
    ...job,
    status: oneShot ? 'archived' : result === 'succeeded' ? 'done' : 'failed',
    updatedAt: now,
    executions,
  }
}
