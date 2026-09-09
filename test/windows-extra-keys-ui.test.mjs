import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { resolve, dirname, extname } from 'node:path'
import vm from 'node:vm'
import ts from 'typescript'
import React from 'react'
import Renderer, { act } from 'react-test-renderer'

const require = createRequire(import.meta.url)
const cancelled = { state: 'error', message: '已取消管理员授权。这三个按键尚未启用，可点击重新授权。', step: 0 }

function environment({ reject = false } = {}) {
  const storage = new Map([['axonkey.extra-keys.v1', 'true']])
  const timers = new Map(), requests = [], modules = new Map()
  let nextTimer = 0, attempted = false, dialogs = 0
  let status = { state: 'disabled', message: '', step: 0 }
  const window = {
    localStorage: { getItem: key => storage.get(key) ?? null, setItem: (key, value) => storage.set(key, value) },
    setInterval: callback => { timers.set(++nextTimer, callback); return nextTimer },
    clearInterval: id => timers.delete(id),
  }
  async function invoke(command, args) {
    if (command === 'get_extra_keys_status') return { ...status }
    assert.equal(command, 'set_extra_keys_enabled')
    requests.push(args)
    if (!args.enabled) { status = { state: 'disabled', message: '', step: 0 }; return }
    if (args.automatic && attempted) return
    attempted = true
    dialogs++
    if (reject) throw cancelled.message
    status = { state: 'authorizing', message: '等待 Windows 授权', step: 0 }
  }
  function load(file) {
    file = resolve(file)
    if (modules.has(file)) return modules.get(file).exports
    const module = { exports: {} }
    modules.set(file, module)
    const source = ts.transpileModule(readFileSync(file, 'utf8'), { compilerOptions: {
      module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020, jsx: ts.JsxEmit.ReactJSX,
    } }).outputText
    const localRequire = name => {
      if (name === '@tauri-apps/api/core') return { invoke }
      if (name === '@tauri-apps/plugin-log') return { error: async () => {}, info: async () => {}, warn: async () => {} }
      if (name.startsWith('.')) {
        const path = resolve(dirname(file), name)
        return load(extname(path) ? path : path + '.ts')
      }
      return require(name)
    }
    vm.runInNewContext(source, { module, exports: module.exports, require: localRequire, window, console }, { filename: file })
    return module.exports
  }
  const { useExtraKeys } = load('src/hooks/useExtraKeys.ts')
  const { ExtraKeysControl } = load('src/components/ExtraKeysControl.tsx')
  const { AppErrorBoundary } = load('src/components/AppErrorBoundary.tsx')
  let ready = false, failOnce = false, control
  function Harness() {
    control = useExtraKeys(true, true, true, ready)
    const [count, setCount] = React.useState(0)
    if (failOnce && control.status.state === 'error') {
      failOnce = false
      throw new Error('Should have a queue. Reproduce a stale development hook tree.')
    }
    return React.createElement('main', null,
      React.createElement('button', { id: 'other-controls', onClick: () => setCount(count + 1) }, `其他功能 ${count}`),
      React.createElement(ExtraKeysControl, { control }),
    )
  }
  let renderer
  const tree = () => React.createElement(React.StrictMode, null,
    React.createElement(AppErrorBoundary, null, React.createElement(Harness)))
  return {
    requests, storage,
    get dialogs() { return dialogs },
    get control() { return control },
    get renderer() { return renderer },
    async mount() { await act(async () => { renderer = Renderer.create(tree()) }) },
    async restore() { ready = true; await act(async () => { renderer.update(tree()) }) },
    async cancel(crash = false) { failOnce = crash; status = { ...cancelled }; await this.poll() },
    async poll() { await act(async () => { await Promise.all([...timers.values()].map(refresh => refresh())) }) },
    async close() { await act(async () => { renderer.unmount() }) },
  }
}

test('UAC No keeps the interface usable and permits manual retry without repeated prompts', async () => {
  const app = environment()
  try {
    await app.mount()
    assert.equal(app.dialogs, 0, 'native settings must be restored before requesting UAC')
    await app.restore()
    assert.equal(app.dialogs, 1)
    assert.equal(app.requests[0].automatic, true)
    await app.cancel()
    for (let n = 0; n < 3; n++) await app.poll()
    assert.equal(app.dialogs, 1)
    assert.equal(app.control.status.message, cancelled.message)
    assert.equal(app.storage.get('axonkey.extra-keys.v1'), 'true')
    const other = app.renderer.root.findByProps({ id: 'other-controls' })
    await act(async () => { other.props.onClick() })
    assert.deepEqual(other.children, ['其他功能 1'])
    const retry = app.renderer.root.findAllByType('button').find(button => button.children[0] === '管理员授权')
    assert.ok(retry)
    await act(async () => { retry.props.onClick() })
    assert.equal(app.dialogs, 2)
    assert.equal(app.requests.at(-1).automatic, false)
    assert.equal(app.control.busy, false)
  } finally { await app.close() }
})

test('a rejected authorization command is rendered as a message, not a blank screen', async () => {
  const app = environment({ reject: true })
  try {
    await app.mount()
    await app.restore()
    assert.equal(app.control.status.message, cancelled.message)
    assert.equal(app.control.busy, false)
    assert.ok(app.renderer.root.findByProps({ id: 'other-controls' }))
  } finally { await app.close() }
})

test('a damaged React tree remounts after cancellation without requesting another UAC dialog', async () => {
  const app = environment()
  const originalError = console.error
  console.error = () => {} // React intentionally reports the injected render failure.
  try {
    await app.mount()
    await app.restore()
    await app.cancel(true)
    await app.poll()
    assert.equal(app.dialogs, 1)
    assert.equal(app.control.status.message, cancelled.message)
    assert.ok(app.renderer.root.findByProps({ id: 'other-controls' }))
  } finally { console.error = originalError; await app.close() }
})
