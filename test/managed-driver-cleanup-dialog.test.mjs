import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import vm from 'node:vm'
import ts from 'typescript'
import React from 'react'
import Renderer, { act } from 'react-test-renderer'

const require = createRequire(import.meta.url)
const text = node => typeof node === 'string' ? node : (node?.children ?? []).map(text).join('')
const source = ts.transpileModule(readFileSync('src/components/ManagedDriverCleanupDialog.tsx', 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020, jsx: ts.JsxEmit.ReactJSX },
}).outputText
const instances = [
  { id: 'remote-111111', kind: 'rc003', name: '客厅遥控器', binding: 'hid-one', enabled: false },
  { id: 'remote-222222', kind: 'cmiotA15', name: '卧室遥控器', binding: 'hid-two', enabled: true },
  { id: 'remote-333333', kind: 'rc003', name: '未绑定遥控器', binding: null },
  { id: 'gamepad-444444', kind: 'xboxBluetooth', name: '手柄', binding: 'hid-gamepad' },
  { id: 'gamepad-555555', kind: 'xboxBluetooth', name: '未绑定手柄', binding: null },
]
const success = { deviceCount: 3, uninstalledCount: 3, unboundCount: 3, failures: [], rebootRequired: true }

async function mount(invoke) {
  const module = { exports: {} }
  let focused = 0, closed = 0, refreshed = 0
  class Element { isConnected = true; focus() { focused++ } }
  vm.runInNewContext(source, {
    module, exports: module.exports, document: { activeElement: new Element() }, HTMLElement: Element,
    require: name => name === '@tauri-apps/api/core' ? { invoke } : name.endsWith('.css') ? {} : require(name),
  })
  const modal = { opened: 0, closed: 0, showModal() { this.opened++ }, close() { this.closed++ } }
  let view
  await act(async () => {
    view = Renderer.create(React.createElement(module.exports.ManagedDriverCleanupDialog, {
      onClose: () => closed++, onDevicesChanged: () => refreshed++,
    }), { createNodeMock: node => node.type === 'dialog' ? modal : null })
  })
  return {
    view, modal, get closed() { return closed }, get refreshed() { return refreshed }, get focused() { return focused },
    button: label => view.root.findAllByType('button').find(button => text(button) === label),
    click: async label => act(async () => { view.root.findAllByType('button').find(button => text(button) === label).props.onClick() }),
    unmount: () => act(() => view.unmount()),
  }
}

test('opening only reads the real device list; cancel never uninstalls, and bound disabled devices remain in scope', async () => {
  const calls = []
  const h = await mount(async command => { calls.push(command); return { store: { instances } } })
  try {
    assert.equal(h.modal.opened, 1)
    assert.deepEqual(calls, ['device_snapshot'])
    const list = h.view.root.findByProps({ 'aria-label': '本次解绑设备' })
    assert.equal(list.findAllByType('li').length, 3)
    assert.match(text(list), /客厅遥控器RC003 · 111111/)
    assert.match(text(list), /卧室遥控器CMIOT A15 · 222222/)
    assert.match(text(list), /手柄Xbox 蓝牙手柄 · 444444/)
    assert.doesNotMatch(text(list), /未绑定遥控器|未绑定手柄/)
    assert.match(text(h.view.toJSON()), /映射配置会保留/)
    assert.equal(h.button('取消').props.autoFocus, true)
    await h.click('取消')
    assert.equal(h.closed, 1)
    assert.deepEqual(calls, ['device_snapshot'])
  } finally { h.unmount() }
  assert.equal(h.focused, 1)
})

test('only confirmation uninstalls; progress prevents closing and completion stays inside the dialog', async () => {
  const calls = []
  let resolveUninstall
  const h = await mount(command => {
    calls.push(command)
    return command === 'device_snapshot' ? Promise.resolve({ store: { instances } })
      : new Promise(resolve => { resolveUninstall = resolve })
  })
  try {
    await h.click('确认卸载并解绑')
    assert.deepEqual(calls, ['device_snapshot', 'uninstall_bound_device_drivers'])
    assert.match(text(h.view.toJSON()), /正在卸载驱动并解除绑定/)
    assert.equal(h.view.root.findByType('dialog').props['aria-busy'], true)
    assert(h.view.root.findAllByType('button').every(button => button.props.disabled))
    let prevented = false
    act(() => h.view.root.findByType('dialog').props.onCancel({ preventDefault() { prevented = true } }))
    const backdrop = {}
    act(() => h.view.root.findByType('dialog').props.onClick({ target: backdrop, currentTarget: backdrop }))
    assert.equal(prevented, true)
    assert.equal(h.closed, 0)
    await act(async () => resolveUninstall(success))
    assert.equal(h.refreshed, 1)
    assert.match(text(h.view.toJSON()), /卸载 3 台，解除绑定 3 台/)
    assert.match(text(h.view.toJSON()), /请重启 Windows/)
    assert.equal(h.button('确认卸载并解绑'), undefined)
    await h.click('关闭')
    assert.equal(h.closed, 1)
  } finally { h.unmount() }
})

test('partial failures show device names and recheck remaining bindings before asking to confirm again', async () => {
  const calls = []
  let remaining = instances
  const h = await mount(async command => {
    calls.push(command)
    if (command === 'device_snapshot') return { store: { instances: remaining } }
    remaining = [instances[1]]
    return { ...success, unboundCount: 1, failures: [{ instanceId: instances[1].id, error: '解绑失败' }] }
  })
  try {
    await h.click('确认卸载并解绑')
    assert.match(text(h.view.root.findByProps({ role: 'alert' })), /卧室遥控器 · 222222：解绑失败/)
    await h.click('重新检查')
    assert.deepEqual(calls, ['device_snapshot', 'uninstall_bound_device_drivers', 'device_snapshot'])
    const list = h.view.root.findByProps({ 'aria-label': '本次解绑设备' })
    assert.equal(list.findAllByType('li').length, 1)
    assert.doesNotMatch(text(list), /客厅/)
    assert.equal(h.button('确认卸载并解绑').props.disabled, false)
  } finally { h.unmount() }
})

test('a bound gamepad alone enables cleanup and reports its failure by name', async () => {
  const calls = []
  const h = await mount(async command => {
    calls.push(command)
    if (command === 'device_snapshot') return { store: { instances: [instances[3], instances[4]] } }
    return {
      deviceCount: 1, uninstalledCount: 0, unboundCount: 0, rebootRequired: false,
      failures: [{ instanceId: instances[3].id, error: '手柄驱动卸载失败' }],
    }
  })
  try {
    const list = h.view.root.findByProps({ 'aria-label': '本次解绑设备' })
    assert.equal(list.findAllByType('li').length, 1)
    assert.match(text(list), /Xbox 蓝牙手柄/)
    assert.equal(h.button('确认卸载并解绑').props.disabled, false)
    await h.click('确认卸载并解绑')
    assert.deepEqual(calls, ['device_snapshot', 'uninstall_bound_device_drivers'])
    assert.match(text(h.view.root.findByProps({ role: 'alert' })), /手柄 · 444444：手柄驱动卸载失败/)
    assert.equal(h.refreshed, 1)
  } finally { h.unmount() }
})

test('loading, empty lists and read errors never enable uninstall; reads can be retried', async () => {
  let resolveSnapshot
  const h = await mount(() => new Promise(resolve => { resolveSnapshot = resolve }))
  try {
    assert.equal(h.button('确认卸载并解绑').props.disabled, true)
    await act(async () => resolveSnapshot({ store: { instances: [] } }))
    assert.match(text(h.view.toJSON()), /当前没有需要解绑的设备/)
    assert.equal(h.button('确认卸载并解绑').props.disabled, true)
  } finally { h.unmount() }

  let attempts = 0
  const failed = await mount(async command => {
    assert.equal(command, 'device_snapshot')
    if (!attempts++) throw new Error('设备服务不可用')
    return { store: { instances } }
  })
  try {
    assert.match(text(failed.view.root.findByProps({ role: 'alert' })), /设备服务不可用/)
    assert.equal(failed.button('确认卸载并解绑'), undefined)
    await failed.click('重新检查')
    assert.equal(failed.button('确认卸载并解绑').props.disabled, false)
  } finally { failed.unmount() }
})

test('native uninstall rejection stays in the dialog and allows rechecking without another uninstall', async () => {
  const calls = []
  const h = await mount(async command => {
    calls.push(command)
    if (command === 'device_snapshot') return { store: { instances } }
    throw new Error('管理员授权取消')
  })
  try {
    await h.click('确认卸载并解绑')
    assert.match(text(h.view.root.findByProps({ role: 'alert' })), /管理员授权取消/)
    assert.equal(h.refreshed, 1)
    assert.equal(h.closed, 0)
    await h.click('重新检查')
    assert.equal(calls.filter(command => command === 'uninstall_bound_device_drivers').length, 1)
  } finally { h.unmount() }
})
