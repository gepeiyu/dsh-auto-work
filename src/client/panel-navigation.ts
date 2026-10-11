import type { BoardControllerFace } from './controller-face.ts'

export const PANEL_ID = 'dsh-auto-work'

/** The native layout service owns global-panel selection and sidebar highlights. */
export interface PanelNavigationShape {
  selectPanel(id: string | null): void
  panelInfo: {
    getSnapshot(): { activePanelId: string | null }
    subscribe(fn: () => void): () => void
  }
}

/** Mirror native panel navigation in the board controller. */
export function bindPanelNavigation(controller: BoardControllerFace, layout: PanelNavigationShape): () => void {
  let boardOpen = false
  const syncBoard = (): void => {
    const next = controller.getSnapshot().boardOpen
    if (next === boardOpen) return
    boardOpen = next
    const activePanelId = layout.panelInfo.getSnapshot().activePanelId
    if (next && activePanelId !== PANEL_ID) layout.selectPanel(PANEL_ID)
    else if (!next && activePanelId === PANEL_ID) layout.selectPanel(null)
  }
  const syncPanel = (): void => {
    if (layout.panelInfo.getSnapshot().activePanelId === PANEL_ID) controller.openBoard()
    else controller.closeBoard()
  }
  const unsubscribeBoard = controller.subscribe(syncBoard)
  const unsubscribePanel = layout.panelInfo.subscribe(syncPanel)
  syncBoard()
  syncPanel()
  return () => {
    unsubscribeBoard()
    unsubscribePanel()
    if (layout.panelInfo.getSnapshot().activePanelId === PANEL_ID) layout.selectPanel(null)
  }
}
