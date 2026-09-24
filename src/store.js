import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { isJob } from './core/model.js'

export function defaultStorePath() {
  return join(homedir(), '.dsh', 'auto-work', 'jobs.json')
}

function ownerKey(owner) { return `${owner.organizationId}:${owner.userId}` }

export class JobStore {
  #file
  #chain = Promise.resolve()

  constructor(file = defaultStorePath()) { this.#file = file }

  async loadAll() {
    try {
      const raw = await readFile(this.#file, 'utf8')
      const value = JSON.parse(raw)
      return Array.isArray(value) ? value.filter(isJob) : []
    } catch { return [] }
  }

  async list(owner) {
    const key = ownerKey(owner)
    return (await this.loadAll()).filter(job => ownerKey(job.owner) === key)
  }

  async mutate(mutator) {
    const run = async () => {
      const current = await this.loadAll()
      const result = await mutator(current)
      if (!result) return undefined
      await this.#save(result.jobs)
      return result.value
    }
    const next = this.#chain.then(run, run)
    this.#chain = next.catch(() => undefined)
    return next
  }

  async #save(jobs) {
    await mkdir(dirname(this.#file), { recursive: true })
    const temp = `${this.#file}.tmp-${process.pid}-${Date.now()}`
    await writeFile(temp, `${JSON.stringify(jobs, null, 2)}\n`, 'utf8')
    await rename(temp, this.#file)
  }
}
