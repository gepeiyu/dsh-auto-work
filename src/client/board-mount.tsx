import type { ComponentType } from 'react'
import type { TargetGroup } from './target-options.ts'
import { listModelOptions, listPresetOptions } from './target-options.ts'
import type { BoardControllerFace } from './controller-face.ts'
import { TimerBoard } from './board/TimerBoard.tsx'
import { bindPanelNavigation, PANEL_ID, type PanelNavigationShape } from './panel-navigation.ts'

/** Native slot registration face; runtime imports stay inside the host. */
export interface SlotsServiceShape {
  inject(name: string, setup: () => (() => void) | Iterable<() => void>): () => void
  register<P extends object>(options: {
    name: string
    key?: string
    id?: string
    order?: number
    label?: () => string
    inject?: () => P
  }, component: ComponentType<P>): () => void
}

/** Register a global page like the official Plugins page. */
export function mountBoard(slots: SlotsServiceShape, layout: PanelNavigationShape, controller: BoardControllerFace, targetOptions: () => Promise<TargetGroup[]>): () => void {
  return slots.inject('main', function* () {
    yield slots.register({
      name: 'main',
      key: PANEL_ID,
      inject: () => ({ controller, targetOptions, modelOptions: listModelOptions, presetOptions: listPresetOptions }),
    }, TimerBoard)
    // The native key must be registered before navigation can select it.
    yield bindPanelNavigation(controller, layout)
  })
}
