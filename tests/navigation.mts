import assert from 'node:assert/strict'
import { RemoteBoardController } from '../src/client/remote-controller.ts'
import { sessionsFaceOf } from '../src/client/sessions-face.ts'

const failedSession = 'session-54744fad-49a3-4c0b-b0fe-0d0bacda9e55'
const previousSession = 'session-92b731bb-cae8-4bb3-8b5a-29d3ded78cc4'
let current = previousSession
let refreshed = false
const catalog = {
  list: {
    getSnapshot: () => ({ byId: {
      [current]: { id: current, retainedBy: { mainView: 1 } },
    } }),
    subscribe: (_fn: () => void) => () => {},
  },
  async refresh() {
    assert.equal(this, catalog, 'refresh must keep its session-service receiver')
    refreshed = true
  },
  // DSH 0.2 deliberately has no sessions.open method.
}
const navigation = {
  openSession(id: string) {
    assert.equal(this, navigation, 'navigation must keep its uiWorkspace receiver')
    assert.equal(id, failedSession)
    current = id
  },
}
const face = sessionsFaceOf(catalog, navigation)
assert.equal(face.list.getSnapshot().current, previousSession)
await face.refresh!()
face.open(failedSession)
assert.equal(face.list.getSnapshot().current, failedSession)
assert.ok(refreshed)
console.log('ok - DSH 0.2 navigation opens the failed execution through uiWorkspace')

const originalFetch = globalThis.fetch
const originalAlert = globalThis.alert
const originalWarn = console.warn
globalThis.fetch = async () => new Response(JSON.stringify({ jobs: [] }))
try {
  let completeRefresh!: () => void
  let opened: string | undefined
  const controller = new RemoteBoardController({
    list: face.list,
    refresh: () => new Promise<void>(resolve => { completeRefresh = resolve }),
    open: id => { opened = id },
  })
  controller.openBoard()
  controller.openSession(failedSession)
  assert.equal(controller.getSnapshot().boardOpen, true)
  assert.equal(opened, undefined)
  completeRefresh()
  await Promise.resolve()
  assert.equal(opened, failedSession)
  assert.equal(controller.getSnapshot().boardOpen, false)
  controller.dispose()
  console.log('ok - the board stays visible until the exact target is selected')

  let notice = ''
  globalThis.alert = text => { notice = String(text) }
  console.warn = () => {}
  const broken = new RemoteBoardController({
    list: face.list,
    open: () => { throw new Error('unknown session') },
  })
  broken.openBoard()
  broken.openSession(failedSession)
  assert.equal(broken.getSnapshot().boardOpen, true)
  assert.ok(notice.includes(failedSession))
  broken.dispose()
  console.log('ok - a navigation failure keeps the board visible and identifies the target')

  opened = undefined
  const refreshFailure = new RemoteBoardController({
    list: face.list,
    refresh: async () => { throw new Error('catalog refresh failed') },
    open: id => { opened = id },
  })
  refreshFailure.openBoard()
  refreshFailure.openSession(failedSession)
  await Promise.resolve()
  assert.equal(opened, failedSession)
  assert.equal(refreshFailure.getSnapshot().boardOpen, false)
  refreshFailure.dispose()
  console.log('ok - refresh failure still permits opening an already known session')
} finally {
  globalThis.fetch = originalFetch
  globalThis.alert = originalAlert
  console.warn = originalWarn
}
