import type { BoardControllerFace } from './controller-face.ts'

/** The native layout service owns global-panel selection and sidebar highlights. */
export interface PanelNavigationShape {
  selectPanel(id: null): void
  panelInfo: {
    getSnapshot(): { activePanelId: string | null }
    subscribe(fn: () => void): () => void
  }
}

/** Keep the injected board and native global panels mutually exclusive. */
export function bindPanelNavigation(controller: BoardControllerFace, layout: PanelNavigationShape): () => void {
  let boardOpen = false
  const syncBoard = (): void => {
    const next = controller.getSnapshot().boardOpen
    const opening = next && !boardOpen
    boardOpen = next
    // Clear the native selection once on entry, so polling/job updates do not
    // reset navigation or leave the Plugins row highlighted under the board.
    if (opening) layout.selectPanel(null)
  }
  const syncPanel = (): void => {
    if (layout.panelInfo.getSnapshot().activePanelId !== null && controller.getSnapshot().boardOpen) {
      controller.closeBoard()
    }
  }
  const unsubscribeBoard = controller.subscribe(syncBoard)
  const unsubscribePanel = layout.panelInfo.subscribe(syncPanel)
  syncBoard()
  return () => {
    unsubscribeBoard()
    unsubscribePanel()
  }
}
