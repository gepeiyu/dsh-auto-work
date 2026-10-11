import assert from 'node:assert/strict'
import { RemoteBoardController } from '../src/client/remote-controller.ts'
import { sessionsFaceOf } from '../src/client/sessions-face.ts'
import { bindPanelNavigation, PANEL_ID } from '../src/client/panel-navigation.ts'

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

  let activePanelId: string | null = 'plugins'
  let navigationCount = 0
  const panelListeners = new Set<() => void>()
  const selectNativePanel = (id: string | null): void => {
    activePanelId = id
    for (const listener of [...panelListeners]) listener()
  }
  const layout = {
    selectPanel(id: string | null) {
      assert.equal(this, layout, 'native layout selection keeps its receiver')
      navigationCount += 1
      selectNativePanel(id)
    },
    panelInfo: {
      getSnapshot: () => ({ activePanelId }),
      subscribe(fn: () => void) {
        panelListeners.add(fn)
        return () => { panelListeners.delete(fn) }
      },
    },
  }
  const panelController = new RemoteBoardController({ list: face.list, open() {} })
  const unbind = bindPanelNavigation(panelController, layout)
  assert.equal(activePanelId, 'plugins', 'mounting an inactive board preserves selection')
  panelController.openBoard()
  assert.equal(activePanelId, PANEL_ID, 'opening the board selects a real global panel')
  assert.notEqual(activePanelId, null, 'the native session tree suppresses selection for global panels')
  assert.equal(face.list.getSnapshot().current, failedSession, 'panel navigation preserves the remembered session')
  assert.equal(panelController.getSnapshot().boardOpen, true)
  await panelController.refresh()
  assert.equal(navigationCount, 1, 'job polling must not reset native navigation')
  selectNativePanel('plugins')
  assert.equal(panelController.getSnapshot().boardOpen, false, 'native navigation closes the board without a DOM click')
  assert.equal(activePanelId, 'plugins')
  panelController.openBoard()
  assert.equal(activePanelId, PANEL_ID, 'returning from Plugins selects the timed-jobs panel')
  assert.equal(navigationCount, 2)
  selectNativePanel(PANEL_ID)
  panelController.openBoard()
  assert.equal(panelController.getSnapshot().boardOpen, true, 'repeated selection keeps the panel open')
  assert.equal(navigationCount, 2)
  panelController.closeBoard()
  assert.equal(panelController.getSnapshot().boardOpen, false)
  assert.equal(activePanelId, null, 'Return to conversation selects the native conversation')
  assert.equal(navigationCount, 3)
  selectNativePanel(PANEL_ID)
  assert.equal(panelController.getSnapshot().boardOpen, true, 'the native sidebar opens the board controller')
  selectNativePanel(null)
  assert.equal(panelController.getSnapshot().boardOpen, false, 'opening a session closes the board')
  assert.equal(face.list.getSnapshot().current, failedSession)
  selectNativePanel(PANEL_ID)
  unbind()
  assert.equal(panelListeners.size, 0)
  assert.equal(activePanelId, null, 'unloading the selected panel returns to conversation')
  selectNativePanel('plugins')
  panelController.openBoard()
  assert.equal(activePanelId, 'plugins', 'unbinding removes the controller listener too')
  panelController.dispose()
  console.log('ok - native global panel selection suppresses session highlights and preserves session navigation')
} finally {
  globalThis.fetch = originalFetch
  globalThis.alert = originalAlert
  console.warn = originalWarn
}
