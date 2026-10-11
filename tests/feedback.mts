import assert from 'node:assert/strict'
import { RemoteBoardController } from '../src/client/remote-controller.ts'
import type { JobRecord } from '../src/core/jobs.ts'
import type { OperationNotice } from '../src/client/feedback.tsx'

const originalFetch = globalThis.fetch
const originalWarn = console.warn
const job: JobRecord = { id: 'feedback-job', title: 'Task', description: '', prompt: '', target: { workdir: '', sessionId: '' }, status: 'idle', createdAt: 1, updatedAt: 1, executions: [] }
const notices: OperationNotice[] = []
const controller = new RemoteBoardController({ list: () => [], open: () => {} }, notice => { notices.push(notice) })
let response = (): Response => new Response(JSON.stringify({ job }))
const requests: Array<{ method: string; body?: unknown }> = []
globalThis.fetch = async (_url, options) => {
  if (options?.method === 'GET') return new Response(JSON.stringify({ jobs: [job] }))
  requests.push({ method: options?.method ?? 'GET', body: options?.body === undefined ? undefined : JSON.parse(String(options.body)) })
  return response()
}
console.warn = () => {}
try {
  controller.stageCreateSchedule({ intervalMinutes: 10 })
  response = () => new Response(JSON.stringify({ job }), { status: 500 })
  assert.equal(await controller.createJob({ title: 'Task', description: '', prompt: '', target: job.target }), undefined)
  assert.equal(notices.at(-1)?.success, false)
  response = () => new Response(JSON.stringify({ job }))
  assert.equal((await controller.createJob({ title: 'Task', description: '', prompt: '', target: job.target }))?.id, job.id)
  assert.equal((requests.at(-1)?.body as { intervalMinutes: number }).intervalMinutes, 10)
  assert.equal(notices.at(-1)?.key, 'feedback.created')
  controller.openJob(job.id)
  const writes = [
    () => controller.updateJob(job.id, { prompt: 'draft' }),
    () => controller.deleteJob(job.id),
    () => controller.resetJob(job.id),
    () => controller.archiveJob(job.id),
    () => controller.restartJob(job.id),
    () => controller.setSchedule(job.id, { enabled: true }),
    () => controller.skipNextRun(job.id),
    () => controller.runJob(job.id),
  ]
  // A failing HTTP status must never be interpreted as success, even when the body resembles it.
  for (const write of writes) {
    response = () => new Response(JSON.stringify({ job, ok: true }), { status: 409 })
    assert.equal(await write(), false)
    assert.equal(notices.at(-1)?.key, 'feedback.failed')
    assert.equal(controller.getSnapshot().selectedJobId, job.id)
  }
  for (const bad of [null, [], { error: 'rejected' }, {}, { job: null }, { job: {} }]) {
    response = () => new Response(JSON.stringify(bad))
    assert.equal(await controller.updateJob(job.id, { prompt: 'draft' }), false)
  }
  response = () => { throw new TypeError('network unavailable') }
  assert.equal(await controller.updateJob(job.id, { prompt: 'draft' }), false)
  response = () => new Response('invalid JSON')
  assert.equal(await controller.updateJob(job.id, { prompt: 'draft' }), false)
  response = () => new Response(JSON.stringify({ job, ok: true }))
  const successKeys = ['feedback.saved', 'feedback.deleted', 'feedback.reset', 'feedback.archived', 'feedback.restarted', 'feedback.saved', 'feedback.skipped', 'feedback.started']
  for (const [index, write] of writes.entries()) {
    assert.equal(await write(), true)
    assert.equal(notices.at(-1)?.success, true)
    assert.equal(notices.at(-1)?.key, successKeys[index])
  }
  assert.equal(controller.getSnapshot().selectedJobId, undefined)
  console.log('ok - mutations report results, reject HTTP/network/JSON failures, preserve failed selection and retry drafts')
} finally {
  controller.dispose()
  globalThis.fetch = originalFetch
  console.warn = originalWarn
}
