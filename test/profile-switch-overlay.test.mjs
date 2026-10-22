import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import vm from 'node:vm'
import ts from 'typescript'
import React from 'react'
import Renderer, { act } from 'react-test-renderer'

const require = createRequire(import.meta.url)
const deferred = () => {
  let resolve
  const promise = new Promise(done => { resolve = done })
  return { promise, resolve }
}
const text = node => typeof node === 'string' ? node : (node?.children ?? []).map(text).join('')

function harness({ snapshot = null, subscription } = {}) {
  const calls = []
  const timers = new Map()
  let timerId = 0
  let receive
  let unsubscribed = 0
  const cleanup = () => { unsubscribed++ }
  const source = ts.transpileModule(readFileSync('src/components/ProfileSwitchOverlay.tsx', 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020, jsx: ts.JsxEmit.ReactJSX },
  }).outputText
  const module = { exports: {} }
  vm.runInNewContext(source, {
    module, exports: module.exports,
    require(name) {
      if (name.endsWith('.css')) return {}
      if (name === '../runtimeLogging') return { logError: (...args) => { throw new Error(args.join(' ')) } }
      if (name === '@tauri-apps/api/event') return { listen: async (_event, callback) => {
        receive = callback
        if (subscription) await subscription
        return cleanup
      } }
      if (name === '@tauri-apps/api/core') return { invoke: async (command, args) => {
        calls.push({ command, args })
        return command === 'get_profile_switch_overlay' ? await snapshot : undefined
      } }
      return require(name)
    },
    setTimeout(callback, delay) { const id = ++timerId; timers.set(id, { callback, delay }); return id },
    clearTimeout(id) { timers.delete(id) },
  })
  let view
  return {
    calls, timers,
    async mount() { await act(async () => { view = Renderer.create(React.createElement(module.exports.ProfileSwitchOverlay)) }) },
    async emit(payload) { await act(async () => receive({ payload })) },
    async unmount() { await act(async () => view.unmount()) },
    content: () => text(view.toJSON()),
    unsubscribed: () => unsubscribed,
  }
}

test('first load recovers the pending switch and shows both profile names before starting its two-second timeout', async () => {
  const app = harness({ snapshot: { revision: 1, from: '工作', to: '游戏' } })
  await app.mount()
  try {
    assert.equal(app.content(), '配置已切换工作→游戏')
    assert.deepEqual(app.calls.map(call => call.command), ['get_profile_switch_overlay', 'reveal_profile_switch_overlay'])
    assert.equal(app.calls[1].args.revision, 1)
    const [timer] = app.timers.values()
    assert.equal(timer.delay, 2000)
    await act(async () => timer.callback())
    assert.equal(app.calls.at(-1).command, 'hide_profile_switch_overlay')
    assert.equal(app.calls.at(-1).args.revision, 1)
  } finally { await app.unmount() }
  assert.equal(app.unsubscribed(), 1)
})

test('rapid switches reset the lifetime and ignore older events and snapshots', async () => {
  const snapshot = deferred()
  const app = harness({ snapshot: snapshot.promise })
  await app.mount()
  try {
    await app.emit({ revision: 2, from: '游戏', to: '阅读' })
    const firstTimer = [...app.timers.keys()][0]
    await act(async () => snapshot.resolve({ revision: 1, from: '工作', to: '游戏' }))
    await app.emit({ revision: 1, from: '工作', to: '游戏' })
    assert.equal(app.content(), '配置已切换游戏→阅读')
    await app.emit({ revision: 3, from: '阅读', to: '工作' })
    assert.equal(app.content(), '配置已切换阅读→工作')
    assert.equal(app.timers.has(firstTimer), false)
    assert.equal(app.timers.size, 1)
    assert.deepEqual(app.calls.filter(call => call.command === 'reveal_profile_switch_overlay').map(call => call.args.revision), [2, 3])
  } finally { await app.unmount() }
  assert.equal(app.timers.size, 0)
})

test('unmounting during listener setup removes the late subscription without fetching or showing a notification', async () => {
  const subscription = deferred()
  const app = harness({ subscription: subscription.promise })
  await app.mount()
  await app.unmount()
  await act(async () => subscription.resolve())
  assert.equal(app.unsubscribed(), 1)
  assert.equal(app.calls.length, 0)
})
