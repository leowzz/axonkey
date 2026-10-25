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
const battery = compile('src/components/BatteryIndicator.tsx')
const { DeviceHub } = compile('src/devices/integration/DeviceHub.tsx', {
  'react-dom': { createPortal: node => node },
  '@tauri-apps/api/event': { listen: async () => () => {} },
  '../../components/RemoteControl': { RemoteControl: () => null },
  './InstanceWorkspace': { InstanceWorkspace: () => null },
  './instanceProfiles': { migrateLegacyProfiles: instance => instance },
  './IntegrationControls': controls,
  '../../components/SettingsHelp': { SettingsHelp: () => null },
  '../../components/BatteryIndicator': battery,
  '../xbox-controller/ControllerDiagram': { ControllerDiagram: () => null },
  '../xiaomi-remote/view': { xiaomiRemoteView: {} },
  '../cmiot-a15-remote/definition': { cmiotA15RemoteDevice: {} },
  './model': model,
})
const device = { id: 'paired-one', kind: 'xboxBluetooth', name: 'Controller', transport: 'Bluetooth', identityQuality: 'serial', vendorId: 1118, productId: 736, connected: false, paired: true }

test('the legacy battery reading belongs only to the sole connected RC003', () => {
  const remote = { ...device, id: 'remote-one', kind: 'rc003', connected: true }
  const offline = { ...remote, id: 'remote-two', connected: false }
  assert.equal(model.rc003BatteryForDevice(remote.id, [remote, offline, device], 78), 78)
  assert.equal(model.rc003BatteryForDevice(offline.id, [remote, offline], 78), null)
  assert.equal(model.rc003BatteryForDevice(null, [remote], 78), null)
  assert.equal(model.rc003BatteryForDevice(remote.id, [remote, { ...offline, connected: true }], 78), null)
  assert.equal(model.rc003BatteryForDevice(remote.id, [{ ...remote, identityQuality: 'ambiguous' }], 78), null)
})

test('RC003 discovery and saved cards show live battery values and clear them on disconnect', () => {
  const remote = { ...device, id: 'remote-one', kind: 'rc003', connected: true }
  const instance = { ...model.newInstance('rc003', remote.id), id: 'saved-remote' }
  const snapshot = { ...model.emptySnapshot(), discovered: [remote] }
  const props = { controller: { snapshot, error: '', busy: false }, native: true, platform: 'macos', permissions: {}, legacyProfiles: () => [], rc003BatteryLevel: 78 }
  let view
  act(() => { view = Renderer.create(React.createElement(DeviceHub, props)) })
  const indicator = () => view.root.findByType(battery.BatteryIndicator)
  try {
    assert.ok(text(indicator()).includes('78%'), 'discovered devices expose battery before integration')
    act(() => { snapshot.store.instances = [instance]; view.update(React.createElement(DeviceHub, props)) })
    assert.ok(text(indicator()).includes('78%'), 'integration preserves the reading')
    act(() => { props.rc003BatteryLevel = 0; view.update(React.createElement(DeviceHub, props)) })
    assert.ok(text(indicator()).includes('0%'))
    assert.equal(indicator().findByType('span').props['aria-label'], '0%，电量不足')
    act(() => { snapshot.discovered = [{ ...remote, connected: false }]; view.update(React.createElement(DeviceHub, props)) })
    assert.ok(text(indicator()).includes('电量未知'))
    act(() => { snapshot.discovered = [remote]; props.rc003BatteryLevel = 100; view.update(React.createElement(DeviceHub, props)) })
    assert.equal(indicator().findByType('span').props['aria-label'], '100%，已满电')
  } finally { act(() => view.unmount()) }
})

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

test('RC003 integration has one fixed capture mode and saves exclusive on every platform', async () => {
  assert.equal(model.newInstance('rc003', null).capture, 'exclusive')
  assert.equal(model.newInstance('xboxBluetooth', null).capture, 'shared')
  const old = { ...model.newInstance('rc003', null), capture: 'shared' }
  const upgraded = model.normalizeInstanceCapture(old)
  assert.equal(upgraded.capture, 'exclusive')
  assert.equal(upgraded.profiles, old.profiles)
  assert.equal(old.capture, 'shared')
  for (const platform of ['macos', 'windows']) {
    const remote = { ...device, kind: 'rc003', id: 'remote-one' }
    const snapshot = { ...model.emptySnapshot(), discovered: [remote] }
    let submitted
    let view
    const controller = { snapshot, error: '', busy: false, put: async instance => {
      submitted = instance
      return { ...snapshot, store: { ...snapshot.store, instances: [{ ...instance, id: 'saved-remote' }] } }
    } }
    act(() => { view = Renderer.create(React.createElement(DeviceHub, {
      controller, native: false, platform, permissions: {}, legacyProfiles: () => [],
    })) })
    act(() => view.root.find(node => node.type === 'button' && node.props.className === 'my-devices-card').props.onClick())
    const dialog = view.root.findByProps({ role: 'dialog' })
    assert.ok(text(dialog).includes('独占拦截'))
    assert.ok(!text(dialog).includes('共享监听'))
    assert.equal(dialog.findAllByType('input').filter(input => input.props.type === 'radio').length, 0)
    await act(async () => view.root.findByProps({ className: 'managed-primary' }).props.onClick())
    assert.equal(submitted.capture, 'exclusive')
    act(() => view.unmount())
  }
})
