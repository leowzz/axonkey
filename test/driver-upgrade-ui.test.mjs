import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import vm from 'node:vm'
import ts from 'typescript'
import React from 'react'
import Renderer, { act } from 'react-test-renderer'

const require = createRequire(import.meta.url)
const source = ts.transpileModule(readFileSync('src/components/DriverUpgradeDialog.tsx', 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020, jsx: ts.JsxEmit.ReactJSX },
}).outputText
const text = node => typeof node === 'string' ? node : (node?.children ?? []).map(text).join('')

test('upgrade blocks dismissal while running, traps focus, then exposes error, close and retry', () => {
  const root = { inert: false }
  const document = { body: { style: { overflow: 'auto' } }, getElementById: () => root }
  class Element { isConnected = true; focus() { document.activeElement = this } }
  const previous = new Element()
  document.activeElement = previous
  const summary = new Element()
  const dialog = new Element()
  let controls = [summary]
  dialog.querySelectorAll = () => controls
  const module = { exports: {} }
  vm.runInNewContext(source, {
    module, exports: module.exports, document, HTMLElement: Element,
    require: name => name.endsWith('.css') ? {} : name === '@tauri-apps/api/core' ? {} : name === '../runtimeLogging' ? {} : require(name),
  })
  let closes = 0
  let retries = 0
  const props = {
    state: { status: 'running', stage: 'uninstalling', message: '正在卸载', devices: ['原设备'], rebootRequired: false, logPath: 'upgrade.log' },
    onClose: () => closes++, onRetry: () => retries++,
  }
  let view
  const render = () => act(() => {
    const element = React.createElement(module.exports.DriverUpgradeDialog, props)
    if (view) view.update(element)
    else view = Renderer.create(element, { createNodeMock: node => node.type === 'section' ? dialog : null })
  })
  const key = (name, shiftKey = false) => act(() => view.root.findByProps({ role: 'presentation' }).props.onKeyDown({ key: name, shiftKey, preventDefault() {}, stopPropagation() {} }))
  try {
    render()
    assert.equal(root.inert, true)
    assert.equal(document.activeElement, dialog)
    assert.equal(document.body.style.overflow, 'hidden')
    assert.equal(view.root.findAllByType('button').length, 0)
    key('Escape')
    assert.equal(closes, 0)
    document.activeElement = summary
    key('Tab')
    assert.equal(document.activeElement, summary)
    assert.match(text(view.toJSON()), /升级期间无法关闭窗口/)

    props.state = { ...props.state, status: 'failed', message: '已取消管理员授权', rebootRequired: true }
    controls = [new Element(), summary, new Element(), new Element()]
    render()
    assert.match(text(view.root.findByProps({ role: 'alert' })), /已取消管理员授权/)
    assert.match(text(view.toJSON()), /upgrade.log/)
    assert.match(text(view.toJSON()), /Windows 要求重启/)
    const button = label => view.root.findAllByType('button').find(node => text(node) === label)
    act(() => button('再次尝试升级').props.onClick())
    assert.equal(retries, 1)
    key('Escape')
    assert.equal(closes, 1)
    act(() => button('关闭窗口').props.onClick())
    assert.equal(closes, 2)
    document.activeElement = controls.at(-1)
    key('Tab')
    assert.equal(document.activeElement, controls[0])

    props.state = { ...props.state, status: 'running' }
    render()
    assert.equal(document.activeElement, dialog)
    assert.equal(view.root.findAllByType('button').length, 0)
    key('Escape')
    assert.equal(closes, 2)
  } finally { act(() => view?.unmount()) }
  assert.equal(root.inert, false)
  assert.equal(document.body.style.overflow, 'auto')
  assert.equal(document.activeElement, previous)
})

test('startup waits for the modal to paint, starts once, retries failure and closes on success', async () => {
  const root = { inert: false }
  const document = { body: { style: {} }, getElementById: () => root }
  class Element { isConnected = true; focus() { document.activeElement = this } }
  const dialog = new Element()
  dialog.querySelectorAll = () => []
  const timers = new Map()
  const frames = new Map()
  let nextId = 0
  let snapshot = { status: 'pending', stage: 'recorded', message: '设备已记录', devices: [], rebootRequired: false, logPath: null }
  let starts = 0
  let completed = 0
  const module = { exports: {} }
  const invoke = async command => {
    if (command === 'get_driver_upgrade_state') return { ...snapshot }
    if (command === 'start_driver_upgrade') { starts++; snapshot.status = 'running' }
  }
  vm.runInNewContext(source, {
    module, exports: module.exports, document, HTMLElement: Element,
    setTimeout: callback => { const id = ++nextId; timers.set(id, callback); return id },
    clearTimeout: id => timers.delete(id),
    requestAnimationFrame: callback => { const id = ++nextId; frames.set(id, callback); return id },
    cancelAnimationFrame: id => frames.delete(id),
    require: name => name.endsWith('.css') ? {} : name === '@tauri-apps/api/core' ? { invoke } : name === '../runtimeLogging' ? { logError() {} } : name === 'react-dom' ? { createPortal: element => element } : require(name),
  })
  const flush = async queue => {
    const entries = [...queue.values()]
    queue.clear()
    await act(async () => { for (const callback of entries) await callback() })
  }
  let view
  try {
    await act(async () => {
      view = Renderer.create(React.createElement(module.exports.StartupDriverUpgrade, { enabled: true, onComplete: () => completed++ }), { createNodeMock: node => node.type === 'section' ? dialog : null })
    })
    assert.equal(starts, 0)
    assert.equal(view.root.findAllByProps({ role: 'dialog' }).length, 1)
    await flush(frames)
    assert.equal(starts, 0)
    await flush(frames)
    assert.equal(starts, 1)
    await flush(timers)
    await flush(frames)
    assert.equal(starts, 1)
    snapshot = { ...snapshot, status: 'failed', stage: 'installing', message: '安装失败' }
    await flush(timers)
    assert.match(text(view.toJSON()), /安装失败/)
    const retry = view.root.findAllByType('button').find(button => text(button) === '再次尝试升级')
    await act(async () => retry.props.onClick())
    assert.equal(starts, 2)
    assert.equal(view.root.findAllByType('button').length, 0)
    snapshot = { ...snapshot, status: 'complete', stage: 'complete', rebootRequired: true }
    await flush(timers)
    assert.equal(view.root.findAllByProps({ role: 'dialog' }).length, 0)
    assert.match(text(view.toJSON()), /请重启 Windows/)
    assert.equal(completed, 1)
    assert.equal(root.inert, false)
    assert.equal(timers.size, 0)
    // An explicit install request must reopen observation after startup finished.
    snapshot = { ...snapshot, status: 'pending', stage: 'recorded', rebootRequired: false }
    await act(async () => view.update(React.createElement(module.exports.StartupDriverUpgrade, { key: 1, enabled: true, onComplete: () => completed++ })))
    assert.equal(view.root.findAllByProps({ role: 'dialog' }).length, 1)
    assert.doesNotMatch(text(view.toJSON()), /驱动升级已提交/)
    await flush(frames)
    await flush(frames)
    assert.equal(starts, 3, 'a later manual request starts a new upgrade')
  } finally { act(() => view?.unmount()) }
})

test('every manual install rechecks, hands legacy upgrades to the modal, and blocks double clicks or failed checks', async () => {
  let resolveCheck
  let rejectCheck
  let calls = 0
  const invoke = command => {
    assert.equal(command, 'check_driver_upgrade_before_install')
    calls++
    return new Promise((resolve, reject) => { resolveCheck = resolve; rejectCheck = reject })
  }
  const module = { exports: {} }
  vm.runInNewContext(source, {
    module, exports: module.exports,
    require: name => name.endsWith('.css') ? {} : name === '@tauri-apps/api/core' ? { invoke } : name === '../runtimeLogging' ? {} : require(name),
  })
  let guard
  function Host() { guard = module.exports.useDriverUpgradeCheck(); return null }
  let view
  act(() => { view = Renderer.create(React.createElement(Host)) })
  try {
    let result
    act(() => { result = guard.checkBeforeInstall() })
    assert.equal(guard.checking, true)
    assert.equal(await guard.checkBeforeInstall(), false)
    assert.equal(calls, 1, 'double click must not launch another check')
    await act(async () => resolveCheck(false))
    assert.equal(await result, true, 'no legacy driver continues normal install')
    assert.equal(guard.checking, false)
    assert.equal(guard.revision, 0)

    for (const revision of [1, 2]) {
      act(() => { result = guard.checkBeforeInstall() })
      await act(async () => resolveCheck(true))
      assert.equal(await result, false, 'legacy migration replaces normal install')
      assert.equal(guard.revision, revision, 'reopen the upgrade UI even after an earlier attempt')
    }
    act(() => { result = guard.checkBeforeInstall() })
    const rejected = assert.rejects(result, /check failed/)
    await act(async () => rejectCheck(new Error('check failed')))
    await rejected
    assert.equal(guard.checking, false)
    assert.equal(guard.revision, 2)
    assert.equal(calls, 4, 'explicit requests must never reuse a clear startup result')
  } finally { act(() => view?.unmount()) }
})
