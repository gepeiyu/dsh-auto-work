import assert from 'node:assert/strict'
import { currentLocale, dictionary, en, formatDateTime, formatRelativeTime, ja, subscribeLocale, t, zh, type AutoWorkKey } from '../src/client/locales.ts'
import { registerJapaneseLocale } from '../src/client/language-registration.ts'

const placeholders = (text: string) => [...text.matchAll(/\{(\w+)\}/g)].map(match => match[1]).sort()
for (const dict of [en, ja]) {
  assert.deepEqual(Object.keys(dict).sort(), Object.keys(zh).sort())
  for (const key of Object.keys(zh) as AutoWorkKey[]) {
    assert.ok(dict[key].trim(), `missing translation: ${key}`)
    assert.deepEqual(placeholders(dict[key]), placeholders(zh[key]), `placeholder mismatch: ${key}`)
  }
}
console.log('ok - all three dictionaries have complete keys and matching placeholders')

const originalDocument = globalThis.document
const originalObserver = globalThis.MutationObserver
const html = { lang: 'zh-CN' }
let notify!: () => void
let disconnected = false
try {
  globalThis.document = { documentElement: html } as unknown as Document
  globalThis.MutationObserver = class {
    constructor(callback: () => void) { notify = callback }
    observe(target: unknown, options: unknown) {
      assert.equal(target, html)
      assert.deepEqual(options, { attributes: true, attributeFilter: ['lang'] })
    }
    disconnect() { disconnected = true }
  } as unknown as typeof MutationObserver
  for (const [tag, locale, expected] of [
    ['en-US', 'en', en], ['zh-CN', 'zh', zh], ['ZH_hans_CN', 'zh', zh],
    ['ja-JP', 'ja', ja], ['JA', 'ja', ja], ['fr-FR', 'en', en], ['', 'en', en],
  ] as const) {
    html.lang = tag
    assert.equal(currentLocale(), locale)
    assert.equal(dictionary(), expected)
    assert.ok(t('delete.confirm', { name: '作業 $& {other}' }).includes('作業 $& {other}'))
    const now = new Date(2026, 9, 10, 12).getTime()
    assert.equal(formatDateTime(now), new Date(now).toLocaleString(locale))
    assert.equal(formatRelativeTime(now, now), expected['time.justNow'])
    const formatter = new Intl.RelativeTimeFormat(locale, { style: 'short', numeric: 'always' })
    assert.equal(formatRelativeTime(now - 5 * 60_000, now), formatter.format(-5, 'minute'))
    assert.equal(formatRelativeTime(now + 2 * 3_600_000, now), formatter.format(2, 'hour'))
    assert.equal(formatRelativeTime(now - 2 * 86_400_000, now), new Date(now - 2 * 86_400_000).toLocaleDateString(locale))
  }
  html.lang = 'zh-CN'
  let notifications = 0
  const unsubscribe = subscribeLocale(() => { notifications++ })
  html.lang = 'ja-JP'
  notify()
  assert.equal(notifications, 1)
  assert.equal(t('entry.label'), '定期タスク')
  html.lang = 'ja'
  notify()
  assert.equal(notifications, 1, 'regional changes within a language should not churn renders')
  html.lang = 'en'
  notify()
  assert.equal(notifications, 2)
  unsubscribe()
  assert.ok(disconnected)
  console.log('ok - regional tags, fallback, interpolation, dates and reactive updates')
} finally {
  if (originalDocument === undefined) Reflect.deleteProperty(globalThis, 'document')
  else globalThis.document = originalDocument
  if (originalObserver === undefined) Reflect.deleteProperty(globalThis, 'MutationObserver')
  else globalThis.MutationObserver = originalObserver
}

let registrations = 0
let removals = 0
const locales = [{ id: 'en' }, { id: 'zh' }]
const dispose = registerJapaneseLocale({
  getSnapshot: () => ({ locales }),
  addLanguage(input) {
    assert.deepEqual(input, { id: 'ja', label: '日本語', fallback: 'en' })
    registrations++
    locales.push({ id: input.id })
    return () => { removals++ }
  },
})
registerJapaneseLocale({
  getSnapshot: () => ({ locales }),
  addLanguage() { throw new Error('must not overwrite an existing Japanese pack') },
})()
assert.equal(registrations, 1)
assert.equal(removals, 0)
dispose()
assert.equal(removals, 1)
console.log('ok - Japanese is selectable without replacing an existing language pack')
