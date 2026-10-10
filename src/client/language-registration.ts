/** Minimal DSH locale face, avoiding a runtime import in the browser bundle. */
export interface LocaleServiceShape {
  getSnapshot(): { locales: readonly { id: string }[] }
  addLanguage(input: { id: string; label: string; fallback: string }): () => void
}

/** Expose Japanese in DSH settings unless another language pack already owns it. */
export function registerJapaneseLocale(locale: LocaleServiceShape): () => void {
  if (locale.getSnapshot().locales.some(item => item.id.toLowerCase() === 'ja')) return () => {}
  return locale.addLanguage({ id: 'ja', label: '日本語', fallback: 'en' })
}
