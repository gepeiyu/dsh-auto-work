import { ownerOf } from './policy.js'

function json(res, status, value) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
  res.end(JSON.stringify(value))
}

async function body(req) {
  const chunks = []; let size = 0
  for await (const chunk of req) {
    size += chunk.byteLength
    if (size > 128 * 1024) throw Object.assign(new Error('request body too large'), { status: 413 })
    chunks.push(chunk)
  }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')) } catch {
    throw Object.assign(new Error('invalid JSON body'), { status: 400 })
  }
}

function query(req, key) {
  const url = new URL(req.url ?? '/', 'http://dsh.local')
  return url.searchParams.get(key) ?? undefined
}

function routeError(res, error) {
  const status = Number.isInteger(error?.status) ? error.status : error?.code === 'AUTH_REQUIRED' ? 401 : 400
  json(res, status, { error: error?.code ?? 'AUTO_WORK_ERROR', message: error?.message ?? String(error) })
}

export async function decorateTargets({ tenant, resources, identity }) {
  const registry = resources?.workspaceRegistry
  const workspaceRows = typeof registry?.list === 'function' ? registry.list() : []
  const workspaceById = new Map(workspaceRows.map(row => [row.id, row]))
  const workspaces = tenant.listOwnedWorkspaces ? tenant.listOwnedWorkspaces(identity).map(row => {
    const live = workspaceById.get(row.id)
    return { ...row, title: live?.title ?? live?.name ?? row.title ?? row.id, name: live?.title ?? live?.name ?? row.title ?? row.id, path: live?.path ?? row.path ?? '' }
  }) : []
  const sessionsService = resources?.sessions
  const persistence = resources?.sessionPersistence
  let summaries = []
  try {
    const listed = await resources?.sessionController?.list?.({}, undefined)
    summaries = listed?.items ?? []
  } catch {}
  const summaryById = new Map(summaries.map(row => [row.sessionId ?? row.id, row]))
  const sessions = tenant.listOwnedSessions ? await Promise.all(tenant.listOwnedSessions(identity).map(async row => {
    const live = sessionsService?.get?.(row.id)?.header
    const stored = live ? undefined : await persistence?.stat?.(row.id).catch?.(() => undefined)
    const header = live ?? stored?.header ?? {}
    const summary = summaryById.get(row.id)
    const workspace = workspaces.find(workspace => workspace.path && header.cwd && workspace.path === header.cwd)
    const title = summary?.projections?.values?.title || summary?.title || header.title || header.name || row.title || row.name || workspace?.title || (header.cwd ? header.cwd.split(/[\\/]/).pop() : '') || row.id
    return { ...row, title, name: title, workspaceId: workspace?.id ?? row.workspaceId ?? '', workdir: header.cwd ?? row.workdir ?? '' }
  })) : []
  const visibleSessions = tenant.canAccessSessionLocation
    ? (await Promise.all(sessions.map(async row => await tenant.canAccessSessionLocation(identity, row.id) ? row : undefined))).filter(Boolean)
    : sessions.filter(row => tenant.canAccessSession?.(identity, row.id))
  const visibleWorkspaces = tenant.canAccessWorkspaceLocation
    ? (await Promise.all(workspaces.map(async row => await tenant.canAccessWorkspaceLocation(identity, row.id) ? row : undefined))).filter(Boolean)
    : workspaces.filter(row => tenant.canAccessWorkspace?.(identity, row.id))
  return { sessions: visibleSessions, workspaces: visibleWorkspaces }
}

export function makeRoutes({ auth, tenant, engine, resources = {} }) {
  const withIdentity = (req, callback) => auth.runWithRequestIdentity(req, callback)
  const jobs = {
    kind: 'exact', path: '/api/dsh-auto-work/jobs',
    handler: async (req, res) => {
      try {
        await withIdentity(req, async () => {
          const identity = ownerOf(auth.currentIdentity())
          if (req.method === 'GET') return json(res, 200, { jobs: await engine.list(identity) })
          if (req.method === 'POST') return json(res, 201, { job: await engine.create(await body(req), identity) })
          if (req.method === 'PATCH') {
            const id = query(req, 'id'); if (!id) throw new Error('id is required')
            const job = await engine.update(id, await body(req), identity)
            if (!job) return json(res, 404, { error: 'job not found' })
            return json(res, 200, { job })
          }
          if (req.method === 'DELETE') {
            const id = query(req, 'id'); if (!id) throw new Error('id is required')
            if (!(await engine.remove(id, identity))) return json(res, 404, { error: 'job not found' })
            return json(res, 200, { ok: true })
          }
          res.setHeader?.('allow', 'GET, POST, PATCH, DELETE')
          return json(res, 405, { error: 'method not allowed' })
        })
      } catch (error) { routeError(res, error) }
    },
  }
  const run = {
    kind: 'exact', path: '/api/dsh-auto-work/jobs/run',
    handler: async (req, res) => {
      try {
        await withIdentity(req, async () => {
          const id = query(req, 'id'); if (!id) throw new Error('id is required')
          const input = req.method === 'POST' ? await body(req).catch(() => ({})) : {}
          const ok = await engine.run(id, ownerOf(auth.currentIdentity()), input.prompt ?? '')
          return json(res, ok ? 202 : 404, { ok })
        })
      } catch (error) { routeError(res, error) }
    },
  }
  const targets = {
    kind: 'exact', path: '/api/dsh-auto-work/targets',
    handler: async (req, res) => {
      try {
        await withIdentity(req, async () => {
          const identity = ownerOf(auth.currentIdentity())
          return json(res, 200, await decorateTargets({ tenant, resources, identity }))
        })
      } catch (error) { routeError(res, error) }
    },
  }
  return [jobs, run, targets]
}
