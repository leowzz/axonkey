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
function compile(path, imports = {}) {
  const source = ts.transpileModule(readFileSync(path, 'utf8').replaceAll('import.meta.url', JSON.stringify(`file://${process.cwd()}/${path}`)), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020, jsx: ts.JsxEmit.ReactJSX },
  }).outputText
  const module = { exports: {} }
  vm.runInNewContext(source, {
    module, exports: module.exports, URL,
    document: { getElementById: () => null, activeElement: null, body: {} }, HTMLElement: class {},
    require: name => imports[name] ?? (name.endsWith('.css') ? {} : require(name)),
  })
  return module.exports
}
const model = compile('src/devices/integration/model.ts', {
  '../xiaomi-remote/buttons': { xiaomiRemoteButtons: [] },
  '../xiaomi-remote/view': { xiaomiRemoteView: { artworkUrl: 'remote.svg' } },
  '../xbox-controller/xbox-controller.svg': { default: 'controller.svg' },
  '../cmiot-a15-remote/definition': { cmiotA15RemoteDevice: { remoteView: { artworkUrl: 'remote.svg' }, buttons: [] } },
})
const controls = compile('src/devices/integration/IntegrationControls.tsx')
const { DeviceHub } = compile('src/devices/integration/DeviceHub.tsx', {
  'react-dom': { createPortal: node => node },
  '@tauri-apps/api/event': { listen: async () => () => {} },
  '../../components/RemoteControl': { RemoteControl: () => null },
  './InstanceBehaviorEditor': { InstanceBehaviorEditor: () => null },
  './IntegrationControls': controls,
  '../../components/SettingsHelp': { SettingsHelp: () => null },
  '../xbox-controller/ControllerDiagram': { ControllerDiagram: () => null },
  '../xiaomi-remote/view': { xiaomiRemoteView: {} },
  '../cmiot-a15-remote/definition': { cmiotA15RemoteDevice: {} },
  './model': model,
})
const device = { id: 'paired-one', kind: 'xboxBluetooth', name: 'Controller', transport: 'Bluetooth', identityQuality: 'serial', vendorId: 1118, productId: 736, connected: false, paired: true }

test('paired offline cards survive refresh, update in place on reconnect, and leave when unpaired', () => {
  const snapshot = { ...model.emptySnapshot(), discovered: [device, { ...device, id: 'paired-two' }] }
  const controller = { snapshot, error: '', busy: false, refresh() {} }
  const props = { controller, native: true, platform: 'macos', permissions: { inputMonitoring: true, accessibility: true }, legacyProfiles: () => [] }
  let view
  act(() => { view = Renderer.create(React.createElement(DeviceHub, props)) })
  const cards = () => view.root.findAll(node => node.type === 'button' && node.props.className === 'my-devices-card')
  assert.equal(cards().length, 2)
  assert.ok(cards().every(card => text(card).includes('未连接')))
  const first = cards()[0]
  act(() => { snapshot.discovered = [{ ...device, connected: true }, { ...device, id: 'paired-two' }]; view.update(React.createElement(DeviceHub, props)) })
  assert.equal(cards()[0], first, 'reconnect updates the original card')
  assert.ok(text(cards()[0]).includes('点击集成'))
  act(() => { snapshot.discovered = [{ ...device, id: 'paired-two' }]; view.update(React.createElement(DeviceHub, props)) })
  assert.equal(cards().length, 1)
  act(() => view.unmount())
})

test('offline paired devices remain selectable for integration without claiming connected', () => {
  const snapshot = { ...model.emptySnapshot(), discovered: [device] }
  let view
  act(() => { view = Renderer.create(React.createElement(DeviceHub, {
    controller: { snapshot, error: '', busy: false }, native: true, platform: 'macos',
    permissions: { inputMonitoring: true, accessibility: true }, legacyProfiles: () => [],
  })) })
  const card = view.root.find(node => node.type === 'button' && node.props.className === 'my-devices-card')
  act(() => card.props.onClick())
  assert.ok(text(view.root.findByProps({ role: 'combobox' })).includes('未连接'))
  assert.equal(view.root.findByProps({ className: 'managed-primary' }).props.disabled, false)
  act(() => view.unmount())
})

test('saved offline instances keep their card and show connection state even when mapping is paused', () => {
  const instance = { ...model.newInstance('xboxBluetooth', device.id), id: 'saved-one', name: 'Desk controller', enabled: false }
  const snapshot = { ...model.emptySnapshot(), runtime: { [instance.id]: { state: 'paused' } } }
  snapshot.store.instances = [instance]
  assert.equal(model.instanceStatusLabel(instance, snapshot), '未连接')
  let view
  act(() => { view = Renderer.create(React.createElement(DeviceHub, {
    controller: { snapshot, error: '', busy: false }, native: true, platform: 'macos', permissions: {}, legacyProfiles: () => [],
  })) })
  const card = view.root.find(node => node.type === 'button' && node.props.className === 'my-devices-card')
  assert.ok(text(card).includes('Desk controller'))
  assert.ok(text(card).includes('未连接'))
  snapshot.discovered = [{ ...device, connected: true }]
  assert.equal(model.instanceStatusLabel(instance, snapshot), '已暂停')
  act(() => view.unmount())
})
