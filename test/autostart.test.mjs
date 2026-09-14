import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import vm from 'node:vm'
import ts from 'typescript'
import React from 'react'
import Renderer, { act } from 'react-test-renderer'

const require = createRequire(import.meta.url)
async function setup({ supported = true, initial = false } = {}) {
  let enabled = initial, failRead = false, failWrite = false, reads = 0
  const writes = [], listeners = new Map()
  const module = { exports: {} }
  const source = ts.transpileModule(readFileSync('src/components/AutostartControl.tsx', 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX },
  }).outputText
  vm.runInNewContext(source, {
    module, exports: module.exports,
    require: name => name === '@tauri-apps/plugin-autostart' ? {
      isEnabled: async () => { reads++; if (failRead) throw new Error('read failed'); return enabled },
      enable: async () => { writes.push(true); if (failWrite) throw new Error('write failed'); enabled = true },
      disable: async () => { writes.push(false); if (failWrite) throw new Error('write failed'); enabled = false },
    } : require(name),
    window: { addEventListener: (name, fn) => listeners.set(name, fn), removeEventListener: name => listeners.delete(name) },
  })
  let renderer
  await act(async () => { renderer = Renderer.create(React.createElement(module.exports.AutostartControl, { supported })) })
  return {
    writes, get reads() { return reads },
    get toggle() { return renderer.root.findByProps({ role: 'switch' }) },
    get alerts() { return renderer.root.findAllByProps({ role: 'alert' }) },
    set enabled(value) { enabled = value },
    set failRead(value) { failRead = value },
    set failWrite(value) { failWrite = value },
    async click() { await act(async () => { this.toggle.props.onClick() }) },
    async focus() { await act(async () => { await listeners.get('focus')?.() }) },
    async close() { await act(async () => renderer.unmount()) },
  }
}

test('reads system state, toggles both ways and refreshes external changes', async () => {
  const app = await setup({ initial: true })
  try {
    assert.equal(app.toggle.props['aria-checked'], true)
    assert.deepEqual(app.writes, [])
    await app.click()
    assert.equal(app.toggle.props['aria-checked'], false)
    await app.click()
    assert.equal(app.toggle.props['aria-checked'], true)
    assert.deepEqual(app.writes, [false, true])
    app.enabled = false
    await app.focus()
    assert.equal(app.toggle.props['aria-checked'], false)
  } finally { await app.close() }
})

test('failed writes preserve actual state and permit retry', async () => {
  const app = await setup()
  try {
    app.failWrite = true
    await app.click()
    assert.equal(app.toggle.props['aria-checked'], false)
    assert.equal(app.toggle.props.disabled, false)
    assert.equal(app.alerts.length, 1)
    app.failWrite = false
    await app.click()
    assert.equal(app.toggle.props['aria-checked'], true)
    assert.equal(app.alerts.length, 0)
  } finally { await app.close() }
})

test('unsupported browser preview does not call native APIs', async () => {
  const app = await setup({ supported: false })
  try {
    assert.equal(app.toggle.props.disabled, true)
    assert.equal(app.reads, 0)
    assert.deepEqual(app.writes, [])
  } finally { await app.close() }
})
