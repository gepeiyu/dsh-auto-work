/**
 * Auto-work client plugin (host-authoritative edition): mounts the two
 * DOM surfaces over the REMOTE controller — the sidebar entry row and the
 * board view in the center column. All state lives in the host engine
 * (~/.dsh/auto-work/jobs.json); this half is a polled mirror + HTTP
 * command sender. The scheduler/execution core the browser used to own is
 * retired: the dsh web host process ticks and fires jobs with or without
 * this page open.
 *
 * Failure policy: DOM mounting problems are logged, never thrown — the web
 * shell fails the whole boot when a plugin apply throws, and an external
 * plugin must not take the GUI down.
 */
import { RemoteBoardController } from './remote-controller.ts'
import { sessionsFaceOf, type SessionsServiceShape, type WorkspaceNavigationShape } from './sessions-face.ts'
import { mountBoard } from './board-mount.tsx'
import { mountSidebarEntry } from './sidebar-entry.ts'
import { listTargetOptions } from './target-options.ts'

/** Required services (fiber inject waiting — the runtime must be up first). */
export const inject = ['slots', 'sessions', 'uiWorkspace']

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
  const ctxTyped = ctx as { sessions: SessionsServiceShape; uiWorkspace: WorkspaceNavigationShape }
  const sessionsFace = sessionsFaceOf(ctxTyped.sessions, ctxTyped.uiWorkspace)

  const controller = new RemoteBoardController(sessionsFace)
  controller.start()

  const disposers: Array<() => void> = []
  try {
    // Session-target dropdown data source: rebuilt on each modal open.
    const targetOptions = (): ReturnType<typeof listTargetOptions> => {
      try {
        return listTargetOptions(ctx as never)
      } catch (error) {
        console.warn('[dsh-auto-work] target-options failed, returning empty:', error)
        return Promise.resolve([])
      }
    }
    disposers.push(mountSidebarEntry(controller))
    disposers.push(mountBoard(controller, targetOptions))
  } catch (error) {
    // DOM failures degrade the board, never the GUI.
    console.error('[dsh-auto-work] mount failed:', error)
  }

  // Teardown: Cordis effect when available (client runtime), otherwise direct disposal.
  const effectFn = (ctxTyped as { effect?(setup: () => () => void, key: string): unknown }).effect
  if (typeof effectFn === 'function') {
    effectFn(() => {
      return () => {
        for (const dispose of disposers.splice(0)) dispose()
        controller.dispose()
      }
    }, 'dsh-auto-work: unmount')
  }
}
