import { useSyncExternalStore } from 'react'
import { Toast } from '@deepseek-ai/dsh-client-ui-primitives'
import type { SlotsServiceShape } from './board-mount.tsx'
import { currentLocale, subscribeLocale, t, type AutoWorkKey } from './locales.ts'

export interface OperationNotice { key: AutoWorkKey; success: boolean; params?: Record<string, string> }

/** Keep feedback in the shell so navigating away from the board does not hide it. */
export function mountFeedback(slots: SlotsServiceShape): { report: (notice: OperationNotice) => void; dispose: () => void } {
  let sequence = 0
  let snapshot: (OperationNotice & { sequence: number }) | undefined
  const listeners = new Set<() => void>()
  const notify = (): void => { for (const listener of listeners) listener() }
  const subscribe = (listener: () => void): (() => void) => {
    listeners.add(listener)
    return () => { listeners.delete(listener) }
  }
  function Feedback() {
    useSyncExternalStore(subscribeLocale, currentLocale, currentLocale)
    const notice = useSyncExternalStore(subscribe, () => snapshot)
    return notice === undefined ? null : <Toast
      key={notice.sequence}
      text={t(notice.key, notice.params)}
      tone={notice.success ? 'success' : undefined}
      holdMs={notice.success ? 3_000 : 6_000}
      onDone={() => {
        if (snapshot?.sequence !== notice.sequence) return
        snapshot = undefined
        notify()
      }}
    />
  }
  const dispose = slots.inject('shell.overlay', () => slots.register({ name: 'shell.overlay', id: 'dsh-auto-work.feedback' }, Feedback))
  return {
    report(notice) { snapshot = { ...notice, sequence: ++sequence }; notify() },
    dispose() { dispose(); snapshot = undefined; listeners.clear() },
  }
}
