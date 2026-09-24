import { mkdir, readFile, writeFile } from 'node:fs/promises'

const source = (await readFile(new URL('../src/client.js', import.meta.url), 'utf8'))
  .replace(/^export const inject = .*\n/m, '')
  .replace('export function apply(', 'function apply(')

await mkdir(new URL('../lib/', import.meta.url), { recursive: true })
const lines = [
  'window.__ModuleLoader__.load({',
  '  id: "dsh-auto-work",',
  '  factory: (require) => {',
  '    var module = { exports: {} };',
  '    var exports = module.exports;',
    ...source.split('\n').map(line => `    ${line}`),
    '    exports.apply = apply;',
    '    exports.inject = ["slots", "sessions"];',
  '    return module.exports;',
  '  }',
  '});',
  '',
]
await writeFile(new URL('../lib/client.js', import.meta.url), lines.join('\n'))
