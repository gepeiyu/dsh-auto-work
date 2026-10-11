/**
 * Auto-work client plugin (host-authoritative edition): registers a native
 * global page and sidebar entry over the REMOTE controller. All state lives in the host engine
 * (~/.dsh/auto-work/jobs.json); this half is a polled mirror + HTTP
 * command sender. The scheduler/execution core the browser used to own is
 * retired: the dsh web host process ticks and fires jobs with or without
 * this page open.
 *
 * Failure policy: registration problems are logged, never thrown — the web
 * shell fails the whole boot when a plugin apply throws, and an external
 * plugin must not take the GUI down.
 */
import { RemoteBoardController } from './remote-controller.ts'
import { sessionsFaceOf, type SessionsServiceShape, type WorkspaceNavigationShape } from './sessions-face.ts'
import { mountBoard, type SlotsServiceShape } from './board-mount.tsx'
import { mountSidebarEntry, type SidebarLocaleShape } from './sidebar-entry.tsx'
import { listTargetOptions } from './target-options.ts'
import { registerJapaneseLocale, type LocaleServiceShape } from './language-registration.ts'
import type { PanelNavigationShape } from './panel-navigation.ts'

/** Required services (fiber inject waiting — the runtime must be up first). */
export const inject = ['slots', 'sessions', 'uiWorkspace', 'locale', 'layout']

/**
 * Mount the auto-work board.
 * @param ctx - client root context (services: sessions and uiWorkspace).
 */
export function apply(ctx: unknown): void {
  // Resolve the sessions SERVICE once through the inject declaration. The
  // ctx object is a Cordis proxy where only `inject` names resolve — reading
  // service members (list/open/refresh) straight off it throws "cannot get
  // property ... without inject", and an eager read at apply time fails the
  // whole web boot. Everything downstream works on the plain service object.
  const ctxTyped = ctx as { slots: SlotsServiceShape; sessions: SessionsServiceShape; uiWorkspace: WorkspaceNavigationShape; locale: LocaleServiceShape & SidebarLocaleShape; layout: PanelNavigationShape }
  const sessionsFace = sessionsFaceOf(ctxTyped.sessions, ctxTyped.uiWorkspace)

  const controller = new RemoteBoardController(sessionsFace)
  controller.start()

  const disposers: Array<() => void> = []
  try {
    disposers.push(registerJapaneseLocale(ctxTyped.locale))
    // Session-target dropdown data source: rebuilt on each modal open.
    const targetOptions = (): ReturnType<typeof listTargetOptions> => {
      try {
        return listTargetOptions(ctx as never)
      } catch (error) {
        console.warn('[dsh-auto-work] target-options failed, returning empty:', error)
        return Promise.resolve([])
      }
    }
    disposers.push(mountBoard(ctxTyped.slots, ctxTyped.layout, controller, targetOptions))
    disposers.push(mountSidebarEntry(ctxTyped.slots, ctxTyped.locale))
  } catch (error) {
    // Registration failures degrade the board, never the GUI.
    console.error('[dsh-auto-work] mount failed:', error)
  }

  // Teardown: Cordis effect when available (client runtime), otherwise direct disposal.
  const effectFn = (ctxTyped as { effect?(setup: () => () => void, key: string): unknown }).effect
  if (typeof effectFn === 'function') {
    effectFn(() => {
      return () => {
        for (const dispose of disposers.splice(0).reverse()) dispose()
        controller.dispose()
      }
    }, 'dsh-auto-work: unmount')
  }
}
