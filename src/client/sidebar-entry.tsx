import type { SlotsServiceShape } from './board-mount.tsx'
import { en, ja, zh } from './locales.ts'
import { PANEL_ID } from './panel-navigation.ts'

export interface SidebarLocaleShape {
  register(namespace: string, dictionaries: Record<string, Record<string, string>>): () => void
  bind(namespace: string): (key: string) => string
}

function TimerPanelIcon({ size = 16 }: { size?: number }) {
  return (
    <svg viewBox="0 0 16 16" width={size} height={size} fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <circle cx="8" cy="8.5" r="5.5" />
      <path d="M8 5.5v3l2 1.5M5.5 1.5h5M8 1.5v1.5" />
    </svg>
  )
}

/** The shell renders the button and owns click, active, hover and collapsed states. */
export function mountSidebarEntry(slots: SlotsServiceShape, locale: SidebarLocaleShape): () => void {
  const namespace = 'dsh-auto-work'
  const unregisterLocale = locale.register(namespace, {
    en: { panel: en['entry.label'] },
    zh: { panel: zh['entry.label'] },
    ja: { panel: ja['entry.label'] },
  })
  const t = locale.bind(namespace)
  const unmount = slots.inject('sidebar.panellist', () => slots.register({
    name: 'sidebar.panellist',
    id: PANEL_ID,
    order: -1,
    label: () => t('panel'),
  }, TimerPanelIcon))
  return () => {
    unmount()
    unregisterLocale()
  }
}
