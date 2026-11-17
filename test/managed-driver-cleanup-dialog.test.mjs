import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import vm from 'node:vm'
import ts from 'typescript'
import React from 'react'
import Renderer, { act } from 'react-test-renderer'
import * as integrationModel from '../src/devices/integration/model.ts'
import { parseRuntimeDescriptorSvg } from '../src/devices/shared/descriptorSvg.ts'

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

test('bound TCL and projector remotes are included in driver cleanup with their own model names', async () => {
  const devices = [
    ['tclRc802a', 'TCL RC802A'],
    ['tclRc902n', 'TCL RC902N'],
    ['tclRc902v', 'TCL RC902V'],
    ['hisenseRcf3b65', 'Hisense RCF3B65'],
    ['phicommDb1R', '斐讯 DB1-R'],
    ['oneplusRc001a', 'OnePlus RC-001A'],
  ].map(([kind], index) => ({
    id: `remote-${index}`, name: `遥控器 ${index}`, kind, binding: `hid-${index}`,
  }))
  const h = await mount(async () => ({ store: { instances: devices } }))
  try {
    const list = h.view.root.findByProps({ 'aria-label': '本次解绑设备' })
    assert.equal(list.findAllByType('li').length, 6)
    for (const model of ['TCL RC802A', 'TCL RC902N', 'TCL RC902V', 'Hisense RCF3B65', '斐讯 DB1-R', 'OnePlus RC-001A']) {
      assert.ok(text(list).includes(model))
    }
  } finally { h.unmount() }
})

async function mount(invoke) {
  const module = { exports: {} }
  let focused = 0, closed = 0, refreshed = 0
  class Element { isConnected = true; focus() { focused++ } }
  vm.runInNewContext(source, {
    module, exports: module.exports, document: { activeElement: new Element() }, HTMLElement: Element,
    require: name =>
      name === '@tauri-apps/api/core'
        ? { invoke }
        : name === '../devices/integration/model'
          ? integrationModel
          : name.endsWith('.css')
            ? {}
            : require(name),
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

test('console-added Quarbor devices are included by dynamic model name while driverless vendor USB HID devices are excluded', async () => {
  const customBtSvg = `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" xmlns:ak="urn:axonkey:device:1" viewBox="0 0 240 240" data-ak-schema="axonkey.device/1" data-ak-device="acme.bt-pad" data-ak-revision="1" data-ak-status="active">
  <metadata>
    <ak:device schema="axonkey.device/1" id="acme.bt-pad" vendor="Acme" model="BP-01" revision="1" display-name="Acme 蓝牙小板" status="active">
      <ak:identity><ak:match transport="bluetooth-hid" vid="0x2B11" pid="0x9922" /></ak:identity>
      <ak:reports><ak:report id="r1" direction="input" report-id="0x01" length="3" encoding="bit-field" /></ak:reports>
      <ak:inputs><ak:input id="acme.bt-pad.k1" label="K1" short="K1" icon="center" kind="button" target="#k1"><ak:source report="r1" offset="1" bit="0" width="8" equals="0x01" /></ak:input></ak:inputs>
    </ak:device>
  </metadata>
  <g id="k1"><rect x="20" y="20" width="80" height="80" /></g>
  <path data-ak-region="acme.bt-pad.k1" data-ak-anchor="60 60" d="M20 20h80v80h-80z" />
</svg>`
  const parsed = parseRuntimeDescriptorSvg(customBtSvg, { kind: 'acmeBtPad', name: 'Acme 蓝牙小板', model: 'BP-01' })
  integrationModel.setRuntimeSupportPackages([parsed.supportPackage])
  try {
    const h = await mount(async () => ({
      store: {
        instances: [
          { id: 'bt-pad-778899', kind: 'acmeBtPad', name: '书桌蓝牙板', binding: 'hid-bt-1', enabled: true },
          { id: 'kivo-112233', kind: 'kivoK18Lite', name: 'Kivo 键盘', binding: 'usb-kivo-1', enabled: true },
        ],
      },
    }))
    try {
      const list = h.view.root.findByProps({ 'aria-label': '本次解绑设备' })
      assert.equal(list.findAllByType('li').length, 1)
      assert.match(text(list), /书桌蓝牙板Acme 蓝牙小板 · 778899/)
      assert.doesNotMatch(text(list), /Kivo/)
    } finally {
      h.unmount()
    }
  } finally {
    integrationModel.resetRuntimeSupportPackages()
  }
})
