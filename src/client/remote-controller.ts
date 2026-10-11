/**
 * Remote controller: the browser-side BoardController face over the host's
 * /api/dsh-auto-work routes. The host ledger is authoritative; this
 * controller keeps a polled mirror, forwards every mutation as a precise
 * HTTP call, and refreshes immediately after each one.
 *
 * Mutations return a confirmed result and report feedback to the shell.
 * `applyScheduleNextRun` is a deliberate no-op: schedule rolling
 * is host-owned now.
 */
import type {
  ControllerSnapshot, SessionsControllerFace,
} from '../core/controller.ts'
import type { JobModelSelection, JobRecord, NewJobInput, SessionTarget } from '../core/jobs.ts'
import type { OperationNotice } from './feedback.tsx'
import type { AutoWorkKey } from './locales.ts'

/** The navigation face (ctx.uiWorkspace.openSession for transcript jumps). */
export type { SessionsControllerFace }

/** Poll cadence for the ledger mirror. */
const POLL_MS = 5_000

/**
 * Browser controller over the host routes.
 */
export class RemoteBoardController {
  private jobs: JobRecord[] = []
  private boardOpen = false
  private selectedJobId: string | undefined
  private listeners = new Set<() => void>()
  private pollTimer: ReturnType<typeof setInterval> | undefined
  private refreshInFlight = false

  /**
   * @param sessions - navigation face (open a session transcript).
   */
  constructor(private readonly sessions: SessionsControllerFace, private readonly report: (notice: OperationNotice) => void = () => {}) {}

  // --- lifecycle -------------------------------------------------------------

  /** Start the polling mirror. */
  start(): void {
    void this.refresh()
    this.pollTimer = setInterval(() => { void this.refresh() }, POLL_MS)
  }

  /** Stop polling and drop listeners (idempotent). */
  dispose(): void {
    if (this.pollTimer !== undefined) clearInterval(this.pollTimer)
    this.pollTimer = undefined
    this.listeners.clear()
  }

  // --- snapshot / subscription ------------------------------------------------

  getSnapshot(): ControllerSnapshot {
    return {
      jobs: this.jobs,
      boardOpen: this.boardOpen,
      selectedJobId: this.selectedJobId,
    }
  }

  subscribe(fn: () => void): () => void {
    this.listeners.add(fn)
    return () => { this.listeners.delete(fn) }
  }

  // --- view state -------------------------------------------------------------

  openBoard(): void {
    if (this.boardOpen) return
    this.boardOpen = true
    this.notify()
    void this.refresh()
  }

  closeBoard(): void {
    if (!this.boardOpen) return
    this.boardOpen = false
    this.notify()
  }

  toggleBoard(): void {
    if (this.boardOpen) this.closeBoard()
    else this.openBoard()
  }

  openJob(id: string): void {
    if (this.jobs.some(job => job.id === id)) {
      this.selectedJobId = id
      this.notify()
    }
  }

  closeJob(): void {
    if (this.selectedJobId === undefined) return
    this.selectedJobId = undefined
    this.notify()
  }

  // --- job mutations (all forwarded to the host) -------------------------------

  async createJob(input: NewJobInput): Promise<JobRecord | undefined> {
    const title = input.title.trim()
    if (title === '') return undefined
    const schedule = this.pendingCreateSchedule
    const response = await this.fetchJson('POST', '/api/dsh-auto-work/jobs', {
      title,
      description: input.description,
      prompt: input.prompt,
      target: input.target,
      ...input.kind !== 'command' && input.preset !== undefined && input.preset.trim() !== ''
        ? { preset: input.preset }
        : {},
      ...input.modelSelection === undefined ? {} : { modelSelection: input.modelSelection },
      ...(schedule?.cron !== undefined ? { cron: schedule.cron } : {}),
      ...(schedule?.intervalMinutes !== undefined ? { intervalMinutes: schedule.intervalMinutes } : {}),
      // One-shot: no cron / interval staged, a runAt arms the host's nextRunAt.
      ...(input.runAt !== undefined ? { runAt: input.runAt } : {}),
      ...(input.kind === 'command'
        ? { kind: 'command', command: input.command ?? '', args: input.args ?? '' }
        : {}),
    })
    if (response?.job === null || typeof response?.job !== 'object' || typeof (response.job as JobRecord).id !== 'string') {
      this.report({ key: 'feedback.failed', success: false })
      return undefined
    }
    const created = response.job as JobRecord
    this.report({ key: 'feedback.created', success: true })
    await this.refresh()
    this.pendingCreateSchedule = undefined
    return created
  }

  /** Schedule to arm on the next create (the modal stages it; the API takes it at create). */
  private pendingCreateSchedule: { cron?: string; intervalMinutes?: number } | undefined

  /** Stage a cron/fixed-interval schedule for the next createJob call (NewJobModal's schedule field). */
  stageCreateSchedule(schedule: { cron?: string; intervalMinutes?: number } | undefined): void {
    this.pendingCreateSchedule = schedule
  }

  async updateJob(id: string, patch: Partial<Pick<JobRecord, 'title' | 'description' | 'prompt' | 'command' | 'args' | 'preset'>> & { target?: SessionTarget; cron?: string; intervalMinutes?: number; nextRunAt?: number; scheduleEnabled?: boolean; timeoutMinutes?: number; modelSelection?: JobModelSelection | null }): Promise<boolean> {
    const body: Record<string, unknown> = { ...patch }
    if (patch.timeoutMinutes !== undefined) body.timeoutMinutes = patch.timeoutMinutes
    // modelSelection: object pins a model, null clears it (host deletes the
    // field); omitting it leaves the stored selection untouched.
    if (patch.modelSelection === undefined) delete body.modelSelection
    return this.mutate(id, body, 'feedback.saved')
  }

  async deleteJob(id: string): Promise<boolean> {
    const response = await this.fetchJson('DELETE', `/api/dsh-auto-work/jobs?id=${encodeURIComponent(id)}`)
    const ok = response?.ok === true
    this.report({ key: ok ? 'feedback.deleted' : 'feedback.failed', success: ok })
    if (!ok) return false
    if (this.selectedJobId === id) this.closeJob()
    await this.refresh()
    return true
  }

  async resetJob(id: string): Promise<boolean> {
    return this.mutate(id, { resetStatus: true }, 'feedback.reset')
  }

  async archiveJob(id: string): Promise<boolean> {
    return this.mutate(id, { archived: true }, 'feedback.archived')
  }

  async restartJob(id: string): Promise<boolean> {
    return this.mutate(id, { restart: true }, 'feedback.restarted')
  }

  async setSchedule(id: string, patch: { enabled?: boolean; cron?: string; intervalMinutes?: number }): Promise<boolean> {
    const body: Record<string, unknown> = {}
    if (patch.cron !== undefined) body.cron = patch.cron
    if (patch.intervalMinutes !== undefined) body.intervalMinutes = patch.intervalMinutes
    if (patch.enabled !== undefined) body.scheduleEnabled = patch.enabled
    return this.mutate(id, body, 'feedback.saved')
  }

  /** Skip the next scheduled fire (host rolls nextRunAt one occurrence). */
  async skipNextRun(id: string): Promise<boolean> {
    return this.mutate(id, { skipNext: true }, 'feedback.skipped')
  }

  /** Host-owned now; kept for interface parity. */
  async applyScheduleNextRun(): Promise<void> {}

  /** Jump to an execution's session transcript. */
  openSession(sessionId: string): void {
    // A scheduled run's session is created headlessly and may not be in the
    // browser's catalog yet. Refresh before selecting it. Keep the board
    // visible on failure so the previous conversation cannot look like the
    // execution's target.
    const open = (): void => {
      try {
        this.sessions.open(sessionId)
        this.closeJob()
        this.closeBoard()
      } catch (error) {
        console.warn('[dsh-auto-work] open session failed:', sessionId, error)
        this.report({ key: 'detail.openSessionFailed', params: { sessionId }, success: false })
      }
    }
    const refresh = this.sessions.refresh
    if (refresh === undefined) {
      open()
      return
    }
    // Call the face's refresh WITHOUT redelivery of `this`: the adapter's
    // closure is already bound to the concrete service, while the service's
    // own refresh is a prototype method whose `this` must be the service —
    // refresh.call(this.sessions) crashes with "Cannot read properties of
    // undefined (reading 'manager')" and the open() below never runs.
    try {
      void Promise.resolve(refresh()).then(open, open)
    } catch {
      open()
    }
  }

  /** Fire now (host runs it in the background). */
  async runJob(id: string): Promise<boolean> {
    const response = await this.fetchJson('POST', `/api/dsh-auto-work/jobs/run?id=${encodeURIComponent(id)}`)
    const ok = response?.ok === true
    this.report({ key: ok ? 'feedback.started' : 'feedback.failed', success: ok })
    if (ok) await this.refresh()
    return ok
  }

  /** Re-run a settled job (same as runJob — status guard is host-side). */
  async rerunJob(id: string): Promise<boolean> {
    return this.runJob(id)
  }

  // --- internals ---------------------------------------------------------------

  private async mutate(id: string, body: unknown, key: AutoWorkKey): Promise<boolean> {
    const response = await this.fetchJson('PATCH', `/api/dsh-auto-work/jobs?id=${encodeURIComponent(id)}`, body)
    const ok = response?.job !== null && typeof response?.job === 'object' && (response.job as JobRecord).id === id
    this.report({ key: ok ? key : 'feedback.failed', success: ok })
    if (ok) await this.refresh()
    return ok
  }

  private async refresh(): Promise<void> {
    if (this.refreshInFlight) return
    this.refreshInFlight = true
    try {
      const response = await this.fetchJson('GET', '/api/dsh-auto-work/jobs')
      if (response !== undefined && Array.isArray(response.jobs)) {
        this.jobs = response.jobs as JobRecord[]
        this.notify()
      }
    } finally {
      this.refreshInFlight = false
    }
  }

  private async fetchJson(method: string, url: string, body?: unknown): Promise<Record<string, unknown> | undefined> {
    try {
      const response = await fetch(url, {
        method,
        ...(body !== undefined ? { body: JSON.stringify(body), headers: { 'content-type': 'application/json' } } : {}),
      })
      if (!response.ok) return undefined
      if (response.status === 204) return {}
      const data: unknown = await response.json()
      if (data === null || typeof data !== 'object' || Array.isArray(data)) return undefined
      const record = data as Record<string, unknown>
      return record.error === undefined ? record : undefined
    } catch (error) {
      // Degrade to the stale mirror; the next poll retries.
      console.warn('[dsh-auto-work] host route call failed:', method, url, error)
      return undefined
    }
  }

  private notify(): void {
    for (const fn of [...this.listeners]) fn()
  }
}
