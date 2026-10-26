import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import vm from 'node:vm'
import ts from 'typescript'
import { act } from 'react-test-renderer'

const require = createRequire(import.meta.url)
const source = ts.transpileModule(readFileSync('src/components/DriverMigrationDialog.tsx', 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020, jsx: ts.JsxEmit.ReactJSX },
}).outputText
export const text = node => typeof node === 'string' ? node : (node?.children ?? []).map(text).join('')

export function harness(invoke = async () => null) {
  const root = { inert: false }
  const document = { body: { style: { overflow: 'auto' } }, getElementById: () => root }
  class Element { isConnected = true; focus() { document.activeElement = this } }
  const previous = new Element()
  document.activeElement = previous
  const dialog = new Element()
  const summary = new Element()
  const action = new Element()
  dialog.contains = element => [dialog, summary, action].includes(element)
  dialog.querySelectorAll = () => [summary, action]
  const timers = new Map()
  let nextId = 0
  const module = { exports: {} }
  vm.runInNewContext(source, {
    module, exports: module.exports, document, HTMLElement: Element,
    window: { __TAURI_INTERNALS__: {} },
    setTimeout: callback => { const id = ++nextId; timers.set(id, callback); return id },
    clearTimeout: id => timers.delete(id),
    require: name => name.endsWith('.css') ? {} : name === '@tauri-apps/api/core' ? { invoke } : name === 'react-dom' ? { createPortal: element => element } : require(name),
  })
  const legacy = { exports: {} }
  vm.runInNewContext(ts.transpileModule(readFileSync('src/components/LegacyCleanupDialog.tsx', 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX },
  }).outputText, { module: legacy, exports: legacy.exports,
    require: name => name === './DriverMigrationDialog' ? module.exports : require(name),
  })
  return { ...module.exports, ...legacy.exports, root, document, previous, dialog, summary, action, timers,
    nodeMock: node => node.type === 'section' ? dialog : null,
    tick: async () => {
      const [id, callback] = timers.entries().next().value ?? []
      if (callback) { timers.delete(id); await act(async () => { await callback() }) }
    },
  }
}

