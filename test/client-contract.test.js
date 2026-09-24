import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import vm from 'node:vm'

test('client bundle exposes the center-board DSH client contract', async () => {
  let descriptor
  const context = {
    window: { __ModuleLoader__: { load(value) { descriptor = value } } },
    console,
    setInterval,
    clearInterval,
    fetch,
    document: undefined,
  }
  vm.runInNewContext(await readFile(new URL('../lib/client.js', import.meta.url), 'utf8'), context)
  const module = descriptor.factory(() => ({}))
  assert.deepEqual(Array.from(module.inject), ['slots', 'sessions'])
  assert.doesNotThrow(() => module.apply({ effect() {} }))
})
