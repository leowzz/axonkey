import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import vm from 'node:vm'
import ts from 'typescript'
import * as library from '../../src/cloud/behaviorLibrary.ts'
import * as relayClient from '../../src/cloud/relayClient.ts'

const require = createRequire(import.meta.url)
export function libraryHarness({ localStorage } = {}) {
  const modules = new Map()
  const timers = new Map()
  let timer = 0
  const window = {
    setTimeout(fn) { timers.set(++timer, fn); return timer },
    clearTimeout(id) { timers.delete(id) },
    ...(localStorage ? { localStorage } : {}),
  }
  function load(file) {
    if (modules.has(file)) return modules.get(file)
    const module = { exports: {} }
    const source = ts.transpileModule(readFileSync(`src/${file}`, 'utf8'), {
      compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020, jsx: ts.JsxEmit.ReactJSX },
    }).outputText
    vm.runInNewContext(source, { module, exports: module.exports, window, document: { body: {} },
      require(name) {
        if (name === 'react-dom') return { createPortal: node => node }
        if (name.endsWith('/behaviorLibrary') || name === './behaviorLibrary') return library
        if (name.endsWith('/BehaviorLibraryContext')) return load('cloud/BehaviorLibraryContext.tsx')
        if (name.endsWith('/useBehaviorLibrary')) return load('cloud/useBehaviorLibrary.ts')
        if (name.endsWith('/useLibraryRecommendations')) return load('cloud/useLibraryRecommendations.ts')
        if (name.endsWith('/relayClient') || name === './relayClient') return relayClient
        if (name === './BehaviorShareDialog') return load('components/BehaviorShareDialog.tsx')
        return require(name)
      },
    })
    modules.set(file, module.exports)
    return module.exports
  }
  return { load, tick() { for (const [id, callback] of timers) { timers.delete(id); callback() } } }
}
