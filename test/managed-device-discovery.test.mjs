import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import vm from 'node:vm'
import ts from 'typescript'
import React from 'react'
import Renderer, { act } from 'react-test-renderer'
import * as reiconReact from 'reicon-react'
import { parseDescriptorSvg } from '../scripts/generate-device-descriptors.mjs'

const require = createRequire(import.meta.url)
const text = node => typeof node === 'string' ? node : (Array.isArray(node) ? node : node?.children ?? []).map(text).join('')
function compile(path, imports = {}, globals = {}) {
  const source = ts.transpileModule(readFileSync(path, 'utf8').replaceAll('import.meta.url', JSON.stringify(`file://${process.cwd()}/${path}`)), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020, jsx: ts.JsxEmit.ReactJSX },
  }).outputText
  const module = { exports: {} }
  vm.runInNewContext(source, {
    module, exports: module.exports, URL,
    setTimeout: (...args) => globalThis.setTimeout(...args), clearTimeout: (...args) => globalThis.clearTimeout(...args),
    setInterval: (...args) => globalThis.setInterval(...args), clearInterval: (...args) => globalThis.clearInterval(...args),
    document: { getElementById: () => null, activeElement: null, body: {} }, HTMLElement: class {},
    ...globals,
    require: name => imports[name] ?? (name === 'reicon-react' ? reiconReact : name.endsWith('.css') ? {} : require(name)),
  })
  return module.exports
}
const xboxDefinition = compile('src/devices/xbox-controller/definition.ts', {
  './xbox-controller.svg': { default: 'controller.svg' },
  './inputs.ts': require('../src/devices/xbox-controller/inputs.ts'),
})
const modelImports = {
  '../../appStorage.ts': require('../src/appStorage.ts'),
  '../xiaomi-remote/definition.ts': require('../src/devices/xiaomi-remote/definition.ts'),
  '../cmiot-a15-remote/definition.ts': require('../src/devices/cmiot-a15-remote/definition.ts'),
  '../xm-bt-29-remote/definition.ts': require('../src/devices/xm-bt-29-remote/definition.ts'),
  '../rc-313-remote/definition.ts': require('../src/devices/rc-313-remote/definition.ts'),
  '../obe-rcu-r5-remote/definition.ts': require('../src/devices/obe-rcu-r5-remote/definition.ts'),
  '../tcl-rc802a-remote/definition.ts': require('../src/devices/tcl-rc802a-remote/definition.ts'),
  '../tcl-rc902n-remote/definition.ts': require('../src/devices/tcl-rc902n-remote/definition.ts'),
  '../tcl-rc902v-remote/definition.ts': require('../src/devices/tcl-rc902v-remote/definition.ts'),
  '../hisense-rcf3b65-remote/definition.ts': require('../src/devices/hisense-rcf3b65-remote/definition.ts'),
  '../phicomm-db1-r-remote/definition.ts': require('../src/devices/phicomm-db1-r-remote/definition.ts'),
  '../kivo-k18-lite/definition.ts': require('../src/devices/kivo-k18-lite/definition.ts'),
  '../g17-touch/definition.ts': require('../src/devices/g17-touch/definition.ts'),
  '../xbox-controller/index.ts': xboxDefinition,
}
const model = compile('src/devices/integration/model.ts', modelImports)
const controls = compile('src/devices/integration/IntegrationControls.tsx')
const battery = compile('src/components/BatteryIndicator.tsx')
const behaviorLibraryContext = compile('src/cloud/BehaviorLibraryContext.tsx')
const useDeviceModelCatalog = compile('src/cloud/useDeviceModelCatalog.ts', {
  './deviceModelCatalog.ts': require('../src/cloud/deviceModelCatalog.ts'),
})
const modelMarkdown = compile('src/devices/integration/ModelMarkdown.tsx', {
  '../../openExternalUrl': require('../src/openExternalUrl.ts'),
})
const { DeviceHub: ControlledDeviceHub, DeviceDiscoverySection } = compile('src/devices/integration/DeviceHub.tsx', {
  'react-dom': { createPortal: node => node },
  '@tauri-apps/api/event': { listen: async () => () => {} },
  '../../appStorage': require('../src/appStorage.ts'),
  '../../cloud/BehaviorLibraryContext': behaviorLibraryContext,
  '../../cloud/useDeviceModelCatalog': useDeviceModelCatalog,
  './InstanceWorkspace': { InstanceWorkspace: props => React.createElement('instance-workspace', props) },
  './IntegrationControls': controls,
  './ModelMarkdown': modelMarkdown,
  '../../components/SettingsHelp': { SettingsHelp: () => null },
  '../../components/BatteryIndicator': battery,
  './model': model,
}, {
  window: new EventTarget(),
})
function DeviceHub(props) {
  const [selectedInstanceId, onSelectInstance] = React.useState(null)
  return React.createElement(ControlledDeviceHub, { selectedInstanceId, onSelectInstance, ...props })
}
const device = { id: 'paired-one', kind: 'xboxBluetooth', name: 'Controller', transport: 'Bluetooth', identityQuality: 'serial', vendorId: 1118, productId: 736, connected: false, paired: true }
const { managedDriverInstallMessage } = compile('src/systemState.ts')

test('binding dropdown stays inside its modal dialog and still works outside a dialog', () => {
  for (const inDialog of [true, false]) {
    const body = {}, dialog = {}, portals = [], selected = []
    const { DeviceBindingPicker } = compile('src/devices/integration/IntegrationControls.tsx', {
      'react-dom': { createPortal: (node, target) => { portals.push(target); return node } },
    }, {
      document: { body, addEventListener() {}, removeEventListener() {} },
      window: { innerHeight: 800, addEventListener() {}, removeEventListener() {} },
    })
    function Host() {
      const [value, setValue] = React.useState('')
      return React.createElement(DeviceBindingPicker, {
        labelledBy: 'binding-label', value, devices: [device],
        onChange: id => { selected.push(id); setValue(id) },
      })
    }
    let view
    act(() => { view = Renderer.create(React.createElement(Host), { createNodeMock: node =>
      node.type === 'button' ? {
        closest: selector => { assert.equal(selector, 'dialog'); return inDialog ? dialog : null },
        getBoundingClientRect: () => ({ left: 20, top: 100, bottom: 160, width: 320 }),
      } : { children: [] },
    }) })
    try {
      const trigger = () => view.root.findByProps({ role: 'combobox' })
      act(() => trigger().props.onClick())
      assert.ok(portals.length > 0)
      assert.ok(portals.every(target => target === (inDialog ? dialog : body)))
      const options = view.root.findAllByProps({ role: 'option' })
      assert.equal(options.length, 2)
      act(() => options[0].props.onClick())
      assert.deepEqual(selected, [device.id])
      assert.equal(view.root.findAllByProps({ role: 'listbox' }).length, 0)
      assert.match(text(trigger()), /Controller/)
      act(() => trigger().props.onClick())
      let prevented = false, stopped = false
      act(() => trigger().props.onKeyDown({ key: 'Escape', preventDefault() { prevented = true }, stopPropagation() { stopped = true } }))
      assert.equal(prevented, true)
      assert.equal(stopped, true)
      assert.equal(view.root.findAllByProps({ role: 'listbox' }).length, 0)
    } finally { act(() => view.unmount()) }
  }
})

test('parent selection opens the exact integrated device and back returns to the device list', () => {
  const first = { ...model.newInstance('rc003', 'one'), id: 'first' }
  const second = { ...model.newInstance('cmiotA15', 'two'), id: 'second' }
  const duplicateRc = { ...model.newInstance('rc003', 'three'), id: 'third-abcd' }
  const snapshot = model.emptySnapshot()
  snapshot.store.instances = [first, second, duplicateRc]
  const legacyCalls = []
  let select, view
  function Host() {
    const [selectedInstanceId, onSelectInstance] = React.useState(null)
    select = onSelectInstance
    return React.createElement(ControlledDeviceHub, { selectedInstanceId, onSelectInstance,
      onLegacy: id => legacyCalls.push(id),
      controller: { snapshot, error: '', busy: false }, native: false, platform: 'windows', permissions: {},
    })
  }
  act(() => { view = Renderer.create(React.createElement(Host)) })
  try {
    assert.equal(view.root.findAllByType('instance-workspace').length, 0)
    act(() => select('second'))
    const workspace = () => view.root.findByType('instance-workspace')
    assert.equal(workspace().props.instance.id, 'second')
    assert.deepEqual(
      Array.from(workspace().props.deviceOptions, item => [item.id, item.detail ?? null]),
      [['first', 'RC003 · irst'], ['second', null], ['third-abcd', 'RC003 · abcd'], ['system-mouse', null]],
    )
    act(() => workspace().props.onSelectDevice('first'))
    assert.equal(workspace().props.instance.id, 'first')
    act(() => workspace().props.onSelectDevice('system-mouse'))
    assert.deepEqual(legacyCalls, ['mouse'])
    act(() => workspace().props.onBack())
    assert.equal(view.root.findAllByType('instance-workspace').length, 0)
    assert.ok(text(view.toJSON()).includes('我的设备'))
  } finally { act(() => view.unmount()) }
})

test('saved unbound devices are highlighted until bound, including in browser preview', () => {
  for (const native of [true, false]) {
    const pending = { ...model.newInstance('rc003', null), id: 'pending' }
    const offline = { ...model.newInstance('cmiotA15', 'offline-device'), id: 'offline' }
    const snapshot = { ...model.emptySnapshot(), discovered: [device] }
    snapshot.store.instances = [pending, offline]
    const props = { controller: { snapshot, error: '', busy: false }, native, platform: 'windows', permissions: {} }
    let view
    act(() => { view = Renderer.create(React.createElement(DeviceHub, props)) })
    try {
      const highlighted = view.root.findAll(node => node.type === 'button' && node.props['data-unbound'])
      assert.equal(highlighted.length, 1, 'offline, system mouse and discovery cards are not marked unbound')
      assert.equal(text(highlighted[0].findByProps({ className: 'my-devices-unbound-badge' })), '未绑定')
      assert.equal(highlighted[0].findAllByType(battery.BatteryIndicator).length, 0)
      act(() => { pending.binding = 'remote-one'; view.update(React.createElement(DeviceHub, props)) })
      assert.equal(view.root.findAllByProps({ className: 'my-devices-unbound-badge' }).length, 0)
      assert.equal(view.root.findAll(node => node.type === 'button' && node.props['data-unbound']).length, 0)
    } finally { act(() => view.unmount()) }
  }
})

test('manual recording controller updates only the requested instance after HID success and preserves state on failure', async () => {
  const snapshot = model.emptySnapshot()
  snapshot.runtime = { one: { state: 'exclusive', recording: false }, two: { state: 'exclusive', recording: true } }
  let complete, fail, controller
  const calls = []
  const { useDeviceInstances } = compile('src/devices/integration/useDeviceInstances.ts', {
    './model': model,
    '@tauri-apps/api/core': { invoke: (command, args) => {
      if (command === 'device_snapshot') return Promise.resolve(snapshot)
      calls.push([command, args])
      return new Promise((resolve, reject) => { complete = resolve; fail = reject })
    } },
  })
  function Host() { controller = useDeviceInstances(true); return null }
  let view
  await act(async () => { view = Renderer.create(React.createElement(Host)) })
  try {
    let operation
    act(() => { operation = controller.toggleRecording('one') })
    assert.equal(controller.snapshot.runtime.one.recording, false)
    await act(async () => { complete(true); await operation })
    assert.equal(controller.snapshot.runtime.one.recording, true)
    assert.equal(controller.snapshot.runtime.two.recording, true)
    act(() => { operation = controller.toggleRecording('one') })
    await act(async () => { fail(new Error('HID write failed')); await assert.rejects(operation, /HID write failed/) })
    assert.equal(controller.snapshot.runtime.one.recording, true)
    assert.match(controller.error, /HID write failed/)
    act(() => { operation = controller.toggleRecording('one') })
    await act(async () => { complete(false); await operation })
    assert.equal(controller.snapshot.runtime.one.recording, false)
    assert.equal(controller.snapshot.runtime.two.recording, true)
    assert.equal(controller.error, '')
    assert.deepEqual(JSON.parse(JSON.stringify(calls)), Array.from({ length: 3 }, () => ['toggle_device_recording', { instanceId: 'one' }]))
  } finally { act(() => view.unmount()) }
})

test('installation feedback distinguishes submitted installs from reboot before installation', () => {
  const result = { logPath: 'driver.log', rebootRequired: false, installationState: 'installed' }
  assert.match(managedDriverInstallMessage(result), /已安装/)
  assert.match(managedDriverInstallMessage({ ...result, installationState: 'reinstalled' }), /已重新安装/)
  assert.match(managedDriverInstallMessage({ ...result, rebootRequired: true }), /已提交安装.*重启/)
  assert.match(managedDriverInstallMessage({ ...result, rebootRequired: true, installationState: 'reinstalled' }), /已提交重新安装.*重启/)
  const pending = managedDriverInstallMessage({ ...result, rebootRequired: true, installationState: 'restart_before_install' })
  assert.match(pending, /尚未执行新安装.*重启 Windows 后再次安装/)
  assert.doesNotMatch(pending, /已安装|已提交/)
})

test('discovery help opens without toggling the device list and routes Bluetooth settings', () => {
  for (const [platform, native, system] of [['windows', true, 'Windows 设置'], ['macos', true, 'macOS 系统设置'], ['windows', false, 'Windows 设置']]) {
    let opened = 0, closed = 0, settingsOpened = 0, deviceManagerOpened = 0
    const modal = { showModal() { opened++ }, close() { closed++ } }
    const props = {
      controller: { snapshot: model.emptySnapshot(), error: '', busy: false },
      native, platform, permissions: {},
      onOpenBluetoothSettings: () => settingsOpened++,
      onOpenDeviceManager: () => deviceManagerOpened++,
    }
    let view
    act(() => { view = Renderer.create(React.createElement(DeviceHub, props), { createNodeMock: node => node.type === 'dialog' ? modal : null }) })
    try {
      const summary = view.root.findByProps({ className: 'managed-discovered-summary' })
      const help = summary.findByProps({ className: 'managed-discovery-help' })
      assert.equal(text(help), '找不到设备？')
      let prevented = false, stopped = false
      const clickHelp = () => act(() => help.props.onClick({ preventDefault() { prevented = true }, stopPropagation() { stopped = true } }))
      clickHelp()
      assert.equal(prevented && stopped, true)
      assert.equal(view.root.findByType('details').props.open, true)
      assert.equal(opened, 1)
      const dialog = view.root.findByType('dialog')
      assert.ok(text(dialog).includes(`蓝牙设备需要先在 ${system}中进行蓝牙配对。`))
      const buttons = dialog.findAllByType('button')
      assert.deepEqual(
        buttons.map(text),
        platform === 'windows'
          ? ['设备无法连接排查', '打开设备管理器', '打开系统蓝牙设置', '关闭']
          : ['设备无法连接排查', '打开系统蓝牙设置', '关闭'],
      )
      assert.equal(buttons[0].props.disabled, undefined)
      const bluetoothButtonIndex = platform === 'windows' ? 2 : 1
      if (platform === 'windows') {
        assert.equal(buttons[1].props.disabled, !native)
        if (native) {
          act(() => buttons[1].props.onClick())
          assert.equal(deviceManagerOpened, 1)
        }
      }
      assert.equal(buttons[bluetoothButtonIndex].props.disabled, !native)
      assert.equal(settingsOpened, 0, 'opening help does not open system settings')
      if (native) {
        act(() => buttons[bluetoothButtonIndex].props.onClick())
        assert.equal(settingsOpened, 1)
        assert.equal(view.root.findAllByType('dialog').length, 1)
      }
      act(() => buttons[buttons.length - 1].props.onClick())
      assert.equal(view.root.findAllByType('dialog').length, 0)
      assert.equal(closed, 1)
      clickHelp()
      act(() => view.root.findByType('dialog').props.onCancel())
      assert.equal(view.root.findAllByType('dialog').length, 0)
      assert.equal(closed, 2)
    } finally { act(() => view.unmount()) }
  }
})

test('RC003 readings are scoped to each physical device', () => {
  const remote = { ...device, id: 'remote-one', kind: 'rc003', connected: true, deviceInfo: { status: 'ready', batteryLevel: 78 } }
  const offline = { ...remote, id: 'remote-two', connected: false }
  assert.equal(model.batteryForDevice(remote.id, [remote, offline, device]), 78)
  assert.equal(model.batteryForDevice(offline.id, [remote, offline]), null)
  assert.equal(model.batteryForDevice(null, [remote]), null)
  assert.equal(model.batteryForDevice(remote.id, [remote, { ...offline, connected: true }]), 78)
  assert.equal(model.batteryForDevice(remote.id, [{ ...remote, identityQuality: 'ambiguous' }]), null)
})

test('A15 and RC003 batteries belong to physical devices', () => {
  const first = { ...device, id: 'a15-one', kind: 'cmiotA15', connected: true, deviceInfo: { status: 'ready', batteryLevel: 0 } }
  const second = { ...first, id: 'a15-two', deviceInfo: { status: 'ready', batteryLevel: 100 } }
  const remote = { ...first, id: 'rc003', kind: 'rc003', deviceInfo: { status: 'ready', batteryLevel: 78 } }
  const discovered = [first, second, remote]
  assert.equal(model.batteryForDevice(first.id, discovered), 0)
  assert.equal(model.batteryForDevice(second.id, discovered), 100)
  assert.equal(model.batteryForDevice(remote.id, discovered), 78)
  assert.equal(model.batteryForDevice(first.id, [{ ...first, connected: false }]), null)
  assert.equal(model.batteryForDevice(first.id, [{ ...first, identityQuality: 'ambiguous' }]), null)
  assert.equal(model.batteryForDevice(first.id, [{ ...first, deviceInfo: { status: 'error', batteryLevel: null } }]), null)
})

test('A15 discovery and saved cards show battery updates, low/full states and disconnects', () => {
  const remote = { ...device, id: 'a15-one', kind: 'cmiotA15', connected: true, deviceInfo: { status: 'ready', batteryLevel: 56 } }
  const instance = { ...model.newInstance('cmiotA15', remote.id), id: 'saved-a15' }
  const snapshot = { ...model.emptySnapshot(), discovered: [remote] }
  const props = { controller: { snapshot, error: '', busy: false }, native: true, platform: 'windows', permissions: {} }
  let view
  act(() => { view = Renderer.create(React.createElement(DeviceHub, props)) })
  const indicator = () => view.root.findByType(battery.BatteryIndicator)
  try {
    assert.ok(text(indicator()).includes('56%'))
    act(() => { snapshot.store.instances = [instance]; view.update(React.createElement(DeviceHub, props)) })
    assert.ok(text(indicator()).includes('56%'))
    for (const [batteryLevel, label] of [[0, '0%，电量不足'], [100, '100%，已满电']]) {
      act(() => { snapshot.discovered = [{ ...remote, deviceInfo: { status: 'ready', batteryLevel } }]; view.update(React.createElement(DeviceHub, props)) })
      assert.equal(indicator().findByType('span').props['aria-label'], label)
    }
    act(() => { snapshot.discovered = [{ ...remote, connected: false }]; view.update(React.createElement(DeviceHub, props)) })
    assert.ok(text(indicator()).includes('电量未知'))
  } finally { act(() => view.unmount()) }
})

test('RC003 discovery and saved cards show live battery values and clear them on disconnect', () => {
  const remote = { ...device, id: 'remote-one', kind: 'rc003', connected: true, deviceInfo: { status: 'ready', batteryLevel: 78 } }
  const instance = { ...model.newInstance('rc003', remote.id), id: 'saved-remote' }
  const snapshot = { ...model.emptySnapshot(), discovered: [remote] }
  const props = { controller: { snapshot, error: '', busy: false }, native: true, platform: 'macos', permissions: {} }
  let view
  act(() => { view = Renderer.create(React.createElement(DeviceHub, props)) })
  const indicator = () => view.root.findByType(battery.BatteryIndicator)
  try {
    assert.ok(text(indicator()).includes('78%'), 'discovered devices expose battery before integration')
    act(() => { snapshot.store.instances = [instance]; view.update(React.createElement(DeviceHub, props)) })
    assert.ok(text(indicator()).includes('78%'), 'integration preserves the reading')
    act(() => { remote.deviceInfo.batteryLevel = 0; view.update(React.createElement(DeviceHub, props)) })
    assert.ok(text(indicator()).includes('0%'))
    assert.equal(indicator().findByType('span').props['aria-label'], '0%，电量不足')
    act(() => { snapshot.discovered = [{ ...remote, connected: false }]; view.update(React.createElement(DeviceHub, props)) })
    assert.ok(text(indicator()).includes('电量未知'))
    act(() => { snapshot.discovered = [remote]; remote.deviceInfo.batteryLevel = 100; view.update(React.createElement(DeviceHub, props)) })
    assert.equal(indicator().findByType('span').props['aria-label'], '100%，已满电')
  } finally { act(() => view.unmount()) }
})

test('paired offline cards survive refresh, update in place on reconnect, and leave when unpaired', () => {
  const snapshot = { ...model.emptySnapshot(), discovered: [device, { ...device, id: 'paired-two' }] }
  const controller = { snapshot, error: '', busy: false, refresh() {} }
  const props = { controller, native: true, platform: 'macos', permissions: { inputMonitoring: true, accessibility: true } }
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
    permissions: { inputMonitoring: true, accessibility: true },
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
    controller: { snapshot, error: '', busy: false }, native: true, platform: 'macos', permissions: {},
  })) })
  const card = view.root.find(node => node.type === 'button' && node.props.className === 'my-devices-card')
  assert.ok(text(card).includes('Desk controller'))
  assert.ok(text(card).includes('未连接'))
  snapshot.discovered = [{ ...device, connected: true }]
  assert.equal(model.instanceStatusLabel(instance, snapshot), '已暂停')
  snapshot.runtime[instance.id] = { state: 'exclusive' }
  assert.equal(model.instanceStatusLabel(instance, snapshot), '拦截中')
  act(() => view.update(React.createElement(DeviceHub, {
    controller: { snapshot, error: '', busy: false }, native: true, platform: 'macos', permissions: {},
  })))
  const updatedCard = view.root.find(node => node.type === 'button' && node.props.className === 'my-devices-card')
  assert.equal(text(updatedCard.findByProps({ className: 'my-devices-status' })), '拦截中')
  act(() => view.unmount())
})

test('integration saves devices without an input mode on every platform', async () => {
  for (const platform of ['macos', 'windows']) for (const kind of ['rc003', 'xboxBluetooth', 'cmiotA15']) {
    const remote = { ...device, kind, id: 'remote-one' }
    const snapshot = { ...model.emptySnapshot(), discovered: [remote] }
    let submitted
    let view
    const controller = { snapshot, error: '', busy: false, put: async instance => {
      submitted = instance
      return { ...snapshot, store: { ...snapshot.store, instances: [{ ...instance, id: 'saved-remote' }] } }
    } }
    act(() => { view = Renderer.create(React.createElement(DeviceHub, {
      controller, native: false, platform, permissions: {},
    })) })
    act(() => view.root.find(node => node.type === 'button' && node.props.className === 'my-devices-card').props.onClick())
    const dialog = view.root.findByProps({ role: 'dialog' })
    assert.ok(!text(dialog).includes('输入模式'))
    if (kind === 'cmiotA15' && platform === 'windows') {
      assert.ok(!text(dialog).includes('暂不支持输入监听'))
      assert.ok(text(dialog).includes('Quarbor Universal'))
    }
    assert.ok(!text(dialog).includes('共享监听'))
    assert.equal(dialog.findAllByType('input').filter(input => input.props.type === 'radio').length, 0)
    await act(async () => view.root.findByProps({ className: 'managed-primary' }).props.onClick())
    assert.ok(!('capture' in submitted))
    assert.equal(submitted.activeProfileId, 'default')
    assert.deepEqual(structuredClone(submitted.profiles), [{ id: 'default', name: '默认配置', behaviors: {} }])
    act(() => view.unmount())
  }
})

test('mobile model identity matching retains captured software and hardware behavior', () => {
  assert.deepEqual(Array.from(model.mobileRemoteKinds), ['cmiotA15', 'xmBt29', 'rc313'])
  assert.equal(model.mobileRemoteFallbackKind, 'rc313')
  assert.equal(model.isMobileRemoteDevice({ vendorId: 0x0416, productId: 0x0300 }), true)
  assert.equal(model.isMobileRemoteDevice({ vendorId: 0x0416, productId: 0x0301 }), false)
  assert.equal(model.isMobileRemoteDevice({ vendorId: 0x1d5a, productId: 0xc081 }), false)
  for (const [software, kind] of [
    ['CMIOT3_B311_debug', 'cmiotA15'],
    ['XFRSD0D_M_R01_761_debug', 'xmBt29'],
    ['CMIOT18_B302_1601', 'rc313'],
    ['unknown', null],
    [null, null],
  ]) assert.equal(model.mobileRemoteKindForSoftware(software), kind)
})

test('bundled capabilities retain recording defaults and platform support for all supported devices', () => {
  for (const [kind, mode, hidVoice, windowsDriver = true, singleLane = false] of [
    ['rc003', 'click', false], ['cmiotA15', 'click', true], ['xmBt29', 'hold', true],
    ['rc313', 'hold', true], ['obeRcuR5', 'hold', true], ['xboxBluetooth', 'click', false, true, true],
    ['tclRc802a', 'hold', true], ['tclRc902n', 'click', false], ['tclRc902v', 'click', false],
    ['hisenseRcf3b65', 'click', false], ['phicommDb1R', 'click', false],
    ['kivoK18Lite', 'click', false, false, true],
    ['g17Touch', 'click', false, false, true],
  ]) {
    assert.equal(model.newInstance(kind, null).cmiotA15RecordingMode, mode)
    assert.equal(model.usesHidVoice(kind), hidVoice)
    assert.equal(model.supportsWindowsDriver(kind), windowsDriver)
    assert.equal(model.usesSingleLaneWorkspace(kind), singleLane)
  }
})

test('TCL identity requires actual information fields and never trusts kind or detectedKind alone', () => {
  const rc802a = { ...device, kind: 'tclRc802a', vendorId: 0x0416, productId: 0x0301,
    deviceInfo: { modelNumber: 'prefix_BT_RC802A_suffix', manufacturer: 'TCL Electronics' } }
  assert.equal(model.deviceMatchesKind(rc802a, 'tclRc802a'), true)
  for (const field of ['modelNumber', 'manufacturer']) {
    for (const value of [null, '', 'other']) {
      assert.equal(model.deviceMatchesKind({ ...rc802a, deviceInfo: { ...rc802a.deviceInfo,
        [field]: value, detectedKind: 'tclRc802a' } }, 'tclRc802a'), false)
    }
  }
  assert.equal(model.deviceMatchesKind({ ...rc802a, productId: 0x0300 }, 'tclRc802a'), false)
  for (const [software, expected] of [['TCL_RC902N_1.0', 'tclRc902n'], ['TCL_RC902V_1.0', 'tclRc902v'], ['', null]]) {
    const remote = { ...device, kind: 'tclRc902n', vendorId: 0x0417, productId: 0x0304,
      deviceInfo: { softwareRevision: software, detectedKind: 'tclRc902n' } }
    for (const kind of ['tclRc902n', 'tclRc902v']) {
      assert.equal(model.deviceMatchesKind(remote, kind), kind === expected)
    }
  }
})

test('recording defaults and driver support follow changed SVG declarations for the same model', () => {
  const source = readFileSync('public/device-descriptors/cmiot-a15.svg', 'utf8')
  const descriptor = parseDescriptorSvg(source
    .replace('trigger-modes="hold click"', 'trigger-modes="hold"')
    .replaceAll('windows-prefix="BTHLEDEVICE"', ''), '/test.svg')
  const definition = modelImports['../cmiot-a15-remote/definition.ts']
  const variant = compile('src/devices/integration/model.ts', {
    ...modelImports,
    '../cmiot-a15-remote/definition.ts': { ...definition,
      cmiotA15SupportPackage: { ...definition.cmiotA15SupportPackage,
        remoteView: { ...definition.cmiotA15SupportPackage.remoteView, voice: descriptor.voice, identities: descriptor.identities },
      },
    },
  })
  assert.equal(variant.newInstance('cmiotA15', null).cmiotA15RecordingMode, 'hold')
  assert.equal(variant.supportsWindowsDriver('cmiotA15'), false)
})

test('mobile model recognizes any software marker declared in the SVG identity', () => {
  const source = readFileSync('public/device-descriptors/cmiot-a15.svg', 'utf8')
  const descriptor = parseDescriptorSvg(source.replaceAll('CMIOT3_B311', 'unused|CMIOT3_B311|alternate')
    .replace('software-contains="unused|CMIOT3_B311|alternate"', ''), '/test.svg')
  const definition = modelImports['../cmiot-a15-remote/definition.ts']
  const variant = compile('src/devices/integration/model.ts', {
    ...modelImports,
    '../cmiot-a15-remote/definition.ts': { ...definition,
      cmiotA15SupportPackage: { ...definition.cmiotA15SupportPackage,
        remoteView: { ...definition.cmiotA15SupportPackage.remoteView, identities: descriptor.identities },
      },
    },
  })
  assert.equal(variant.mobileRemoteKindForSoftware('CMIOT3_B311_debug'), 'cmiotA15')
  assert.equal(variant.mobileRemoteKindForSoftware('alternate_debug'), 'cmiotA15')
  assert.equal(variant.mobileRemoteKindForSoftware('unrelated'), null)
})

test('mobile integration preserves selection and recognizes native, old and unknown software snapshots', async () => {
  for (const recognition of [null, 'native', 'software', 'unknown', 'missing']) {
    const identify = recognition !== null
    const recognizedKind = recognition === 'unknown' || recognition === 'missing' ? 'rc313' : 'xmBt29'
    const expectedKind = identify ? recognizedKind : 'cmiotA15'
    const expectedName = identify ? (recognizedKind === 'rc313' ? 'RC-313' : 'XM-BT-29') : 'CMIOT-A15'
    const remote = { ...device, id: 'mobile-one', kind: 'cmiotA15', vendorId: 0x0416, productId: 0x0300, connected: true,
      deviceInfo: { status: 'ready',
        softwareRevision: recognition === 'native' ? 'CMIOT3_B311' : recognition === 'unknown' ? 'unknown' : recognition === 'missing' ? null : 'XFRSD0D_M_R01_761',
        ...(recognition === 'native' ? { detectedKind: 'xmBt29' } : {}),
      } }
    const second = { ...remote, id: 'mobile-two' }
    const snapshot = { ...model.emptySnapshot(), discovered: [remote, second] }
    const saved = [], refreshed = []
    const controller = { snapshot, error: '', busy: false,
      refreshInformation: async binding => { refreshed.push(binding) },
      refresh: async () => snapshot,
      put: async instance => {
        saved.push(instance)
        return { ...snapshot, store: { ...snapshot.store, instances: [{ ...instance, id: 'saved-mobile' }] } }
      },
    }
    let integrated = '', view
    act(() => { view = Renderer.create(React.createElement(DeviceDiscoverySection, {
      controller, native: true, platform: 'windows', permissions: {}, onIntegrated: id => { integrated = id },
    })) })
    const button = label => view.root.findAllByType('button').find(node => text(node) === label)
    const selectedModel = () => view.root.findAllByProps({ role: 'radio' }).find(node => node.props['aria-checked'])
    try {
      act(() => view.root.findAll(node => node.type === 'button' && node.props['data-discovered'])[0].props.onClick())
      assert.equal(view.root.findAllByProps({ role: 'radiogroup' }).length, 0)
      assert.equal(view.root.findByType(controls.DeviceBindingPicker).props.value, remote.id)
      act(() => view.root.findByType('input').props.onChange({ target: { value: '客厅遥控器' } }))
      act(() => view.root.findByType(controls.DeviceBindingPicker).props.onChange(second.id))
      act(() => button('下一步').props.onClick())
      assert.equal(view.root.findAllByType('input').length, 0)
      assert.equal(view.root.findAllByProps({ role: 'radio' }).length, 3)
      assert.ok(text(selectedModel()).includes('RC-313'))
      assert.equal(saved.length, 0)
      if (identify) {
        await act(async () => button('一键识别').props.onClick())
        assert.deepEqual(refreshed, [second.id])
        assert.ok(text(selectedModel()).includes(expectedName))
        assert.equal(view.root.findAllByProps({ role: 'radiogroup' }).length, 1, 'recognition selects a model without returning to the details page')
      } else {
        act(() => view.root.findAllByProps({ role: 'radio' }).find(node => text(node).includes('CMIOT-A15')).props.onClick())
      }
      act(() => button('上一步').props.onClick())
      assert.equal(view.root.findByType('input').props.value, '客厅遥控器')
      assert.equal(view.root.findByType(controls.DeviceBindingPicker).props.value, second.id)
      act(() => button('下一步').props.onClick())
      assert.ok(text(selectedModel()).includes(expectedName))
      assert.equal(saved.length, 0)
      await act(async () => button('集成设备').props.onClick())
      assert.equal(saved.length, 1)
      assert.equal(saved[0].name, '客厅遥控器')
      assert.equal(saved[0].binding, second.id)
      assert.equal(saved[0].kind, expectedKind)
      assert.equal(saved[0].cmiotA15RecordingMode, identify ? 'hold' : 'click')
      assert.equal(integrated, 'saved-mobile')
    } finally { act(() => view.unmount()) }
  }
})

test('OBE_RCU_R5 integrates directly by hardware model without software recognition', async () => {
  const remote = { ...device, id: 'obe-one', kind: 'obeRcuR5', name: 'OBE_RCU_R5',
    vendorId: 0x1d5a, productId: 0xc081, connected: true }
  const snapshot = { ...model.emptySnapshot(), discovered: [remote] }
  const saved = []
  const controller = { snapshot, error: '', busy: false, put: async instance => {
    saved.push(instance)
    return { ...snapshot, store: { ...snapshot.store, instances: [{ ...instance, id: 'saved-obe' }] } }
  } }
  let view
  act(() => { view = Renderer.create(React.createElement(DeviceDiscoverySection, {
    controller, native: true, platform: 'windows', permissions: {}, onIntegrated() {},
  })) })
  try {
    act(() => view.root.find(node => node.type === 'button' && node.props['data-discovered']).props.onClick())
    assert.ok(text(view.root).includes('OBE_RCU_R5'))
    assert.equal(view.root.findAllByProps({ role: 'radiogroup' }).length, 0)
    assert.equal(view.root.findAllByType('button').filter(button => text(button) === '一键识别').length, 0)
    assert.equal(view.root.findByType(controls.DeviceBindingPicker).props.value, remote.id)
    await act(async () => view.root.findByProps({ className: 'managed-primary' }).props.onClick())
    assert.equal(saved.length, 1)
    assert.equal(saved[0].kind, 'obeRcuR5')
    assert.equal(saved[0].binding, remote.id)
    assert.equal(saved[0].cmiotA15RecordingMode, 'hold')
  } finally { act(() => view.unmount()) }
})

test('A15 workspace scopes driver actions, recording mode and input feedback to its instance', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] })
  const listeners = []
  const RemoteControl = () => null
  const WorkflowAxonkey = () => null
  const modal = { opened: 0, closed: 0, showModal() { this.opened++ }, close() { this.closed++ } }
  const { InstanceWorkspace } = compile('src/devices/integration/InstanceWorkspace.tsx', {
    'react-dom': { createPortal: node => node },
    '@tauri-apps/api/event': { listen: async (_, listener) => { listeners.push(listener); return () => {} } },
    '../../behaviorModel': require('../src/behaviorModel.ts'),
    '../../appConfig': { triggerLabels: {} },
    '../../audioGain': require('../src/audioGain.ts'),
    '../../components/InputIcon': compile('src/components/InputIcon.tsx'),
    './railOverview': require('../src/devices/integration/railOverview.ts'),
    '../../deviceInputSelection': require('../src/deviceInputSelection.ts'),
    '../../telemetry': { reportTencentEvent() {} },
    '../../cloud/libraryUsage': { recordLibraryAdditions() {} },
    '../../profileNavigation': require('../src/profileNavigation.ts'),
    '../shared/RemoteControl': { RemoteControl },
    '../../components/ProfileManager': { ProfileManager: () => null },
    '../../components/ApplicationProfileToolbar': { ApplicationProfileToolbar: () => null },
    '../../useForegroundApplications': { useForegroundApplications: () => ({ current: null, recent: [], supported: true, error: null }) },
    './applicationProfiles': require('../src/devices/integration/applicationProfiles.ts'),
    '../../components/ProfileSwitchConfirmDialog': { ProfileSwitchConfirmDialog: () => null },
    '../../components/ProfileSwitchDeleteDialog': { ProfileSwitchDeleteDialog: () => null },
    '../../components/SettingsHelp': { SettingsHelp: () => null },
    '../../components/BatteryIndicator': battery,
    '../../components/BehaviorHistoryActions': compile('src/components/BehaviorHistoryActions.tsx'),
    '../../components/BehaviorSummaryPopover': compile('src/components/BehaviorSummaryPopover.tsx', {
      'react-dom': { createPortal: node => node },
      '../behaviorSummary': require('../src/behaviorSummary.ts'),
    }, {
      window: { innerWidth: 1280, innerHeight: 800, addEventListener() {}, removeEventListener() {} },
    }),
    '../../components/DeviceRail': compile('src/components/DeviceRail.tsx'),
    '../../components/WorkflowAxonkey': { WorkflowAxonkey },
    '../../components/QuickOverlayConfigurator': { QuickOverlayConfigurator: () => null },
    '../../components/workflowSplitLayout': require('../src/components/workflowSplitLayout.ts'),
    '../shared/DeviceWorkspaceHeader': compile('src/devices/shared/DeviceWorkspaceHeader.tsx'),
    '../shared/DeviceSettingsDrawer': compile('src/devices/shared/DeviceSettingsDrawer.tsx', {
      'react-dom': { createPortal: node => node },
    }),
    '../kivo-k18-lite/KivoScreenEditor': compile('src/devices/kivo-k18-lite/KivoScreenEditor.tsx', {
      '../integration/model': model,
    }),
    './IntegrationControls': controls,
    './model': model,
    './instanceProfiles': require('../src/devices/integration/instanceProfiles.ts'),
  })
  const instances = ['one', 'two'].map(id => ({ ...model.newInstance('cmiotA15', `physical-${id}`), id }))
  instances[0].cmiotA15RecordingMode = 'click'
  const snapshot = model.emptySnapshot()
  snapshot.store.instances = instances
  snapshot.runtime = {
    one: { state: 'driverMissing', driverState: 'missing', driverInstalled: false },
    two: { state: 'exclusive', driverState: 'connected', driverInstalled: true, recording: true },
  }
  const actions = []
  const audioDriverRequests = []
  const informationRefreshes = []
  const recordingRequests = []
  let finishRecording
  const controller = { snapshot, toggleRecording: id => {
    recordingRequests.push(id)
    return new Promise(resolve => { finishRecording = resolve })
  }, refreshInformation: async binding => { informationRefreshes.push(binding) }, update: async (id, change) => {
    const index = instances.findIndex(item => item.id === id)
    instances[index] = change(instances[index])
    return snapshot
  } }
  const props = index => ({ instance: instances[index], controller, native: true, platform: 'windows', permissions: {},
    driverAction: null, batteryLevel: index === 0 ? 15 : 78,
    onInstallDriver: id => actions.push(['install', id]),
    onBind: () => actions.push(['bind', instances[index].id]),
    onUnbindDevice: async id => actions.push(['unbind', id]),
    onOpenAudioCalibration: id => actions.push(['calibrate', id]),
    onOpenAudioDriver: () => audioDriverRequests.push('open'),
  })
  const views = []
  const settingsButton = { getBoundingClientRect: () => ({ x: 420, y: 18, width: 30, height: 30 }) }
  const createNodeMock = node => {
    if (node.type === 'dialog') return modal
    if (node.type === 'button' && node.props.className === 'device-workspace-settings') return settingsButton
    if (node.type === 'section' && node.props.className === 'managed-driver-notice') {
      return {
        getBoundingClientRect: () => ({ x: 160, y: 180, width: 420, height: 180 }),
        animate: () => ({ finished: Promise.resolve(), cancel() {} }),
      }
    }
    if (node.type === 'div' && node.props.className?.startsWith('mapping-page')) {
      return { querySelector: selector => (selector === '.device-workspace-settings' ? settingsButton : null) }
    }
    return null
  }
  await act(async () => {
    for (let index = 0; index < 2; index++) {
      views.push(Renderer.create(React.createElement(InstanceWorkspace, props(index)), { createNodeMock }))
    }
  })
  try {
    assert.equal(views[0].root.findByProps({ className: 'device-recording-control' }).props.disabled, true)
    snapshot.discovered = [{ ...device, id: 'physical-two', kind: 'cmiotA15', connected: true }]
    act(() => views[1].update(React.createElement(InstanceWorkspace, props(1))))
    const statusRow = views[1].root.findByProps({ 'aria-label': '设备状态' })
    assert.equal(text(statusRow), '拦截中78%')
    assert.equal(statusRow.findByProps({ role: 'switch' }).props['aria-checked'], true)
    assert.equal(statusRow.findAllByType('button').length, 1)
    const recordingButton = () => views[1].root.findByProps({ className: 'device-recording-control' })
    assert.equal(recordingButton().props.disabled, false)
    assert.equal(recordingButton().props['aria-label'], '停止录音')
    act(() => recordingButton().props.onClick())
    assert.deepEqual(recordingRequests, ['two'])
    assert.equal(recordingButton().props.disabled, true)
    await act(async () => finishRecording())
    assert.equal(recordingButton().props.disabled, false)
    snapshot.discovered = []
    act(() => views[1].update(React.createElement(InstanceWorkspace, props(1))))
    assert.ok(text(views[0].root.findByProps({ className: 'managed-instance-power' })).includes('15%'))
    assert.ok(text(views[1].root.findByProps({ className: 'managed-instance-power' })).includes('78%'))
    assert.equal(views[0].root.findAllByProps({ className: 'managed-driver-notice' }).length, 1)
    assert.equal(views[1].root.findAllByProps({ className: 'managed-driver-notice' }).length, 0)
    const driverNotice = views[0].root.findByProps({ className: 'managed-driver-notice' })
    assert.equal(driverNotice.props.role, 'dialog')
    assert.deepEqual(driverNotice.findAllByType('button').map(text), ['安装驱动', '关闭'])
    assert.ok(text(views[1].root.findByProps({ role: 'status', 'aria-live': 'polite', 'aria-atomic': 'true' })).includes('正在录音'))
    assert.ok(!text(views[0].root.findByProps({ className: 'mapping-device-rail panel-surface' })).includes('正在录音'))
    act(() => views[0].root.findByProps({ className: 'managed-driver-notice' }).findAllByType('button')[0].props.onClick())
    act(() => views[1].root.findByProps({ className: 'managed-audio-calibration' }).props.onClick())
    assert.deepEqual(actions, [['install', 'one'], ['calibrate', 'two']])
    await act(async () => views[0].root.findByProps({ className: 'managed-driver-notice-close' }).props.onClick())
    assert.equal(views[0].root.findAllByProps({ className: 'managed-driver-notice' }).length, 1)
    assert.equal(views[0].root.findByProps({ className: 'managed-driver-notice' }).props.role, 'status')
    act(() => views[0].update(React.createElement(InstanceWorkspace, props(0))))
    assert.equal(views[0].root.findAllByProps({ className: 'managed-driver-notice' }).length, 1)
    assert.equal(views[0].root.findByProps({ className: 'managed-driver-notice' }).props.role, 'status')

    const communicationError = 'Quarbor Universal connect (BTHLEDEVICE\\device): 系统找不到指定的文件。(os error 2)'
    for (const kind of ['rc003', 'tclRc902n', 'tclRc902v', 'cmiotA15']) {
      act(() => {
        instances[0] = { ...instances[0], kind, hideDriverMissingReminder: false }
        snapshot.runtime.one = { state: 'disconnected', driverState: 'connecting', driverInstalled: true, error: communicationError }
        views[0].update(React.createElement(InstanceWorkspace, props(0)))
      })
      const notice = views[0].root.findByProps({ className: 'managed-driver-notice' })
      assert.equal(notice.props.role, 'dialog')
      assert.ok(text(notice).includes('驱动错误，请重新安装。'))
      assert.equal(text(notice).includes(communicationError), true)
      assert.equal(notice.findByProps({ className: 'managed-driver-notice-details' }).findByType('summary').children[0], '查看错误详情')
      const button = notice.findByProps({ className: 'managed-driver-notice-install' })
      assert.equal(text(button), '重新安装驱动')
      assert.equal(button.props.disabled, false)
      assert.equal(views[0].root.findAllByProps({ className: 'managed-error' }).length, 0, 'communication errors are shown once')
      act(() => button.props.onClick())
      assert.deepEqual(actions.at(-1), ['install', 'one'])
      await act(async () => views[0].root.findByProps({ className: 'managed-driver-notice-close' }).props.onClick())
      const banner = views[0].root.findByProps({ className: 'managed-driver-notice' })
      assert.equal(banner.props.role, 'status')
      assert.equal(text(banner.findByType('span')), '驱动错误，请重新安装。')
      assert.equal(text(banner).includes(communicationError), false)
      act(() => views[0].update(React.createElement(InstanceWorkspace, {
        ...props(0), driverAction: { instanceId: 'two', status: 'running' },
      })))
      assert.equal(views[0].root.findByProps({ className: 'managed-driver-notice' }).findByType('button').props.disabled, true)
      act(() => views[0].update(React.createElement(InstanceWorkspace, {
        ...props(0), driverAction: { instanceId: 'one', status: 'running' },
      })))
      const runningNotice = views[0].root.findByProps({ className: 'managed-driver-notice' })
      assert.ok(text(runningNotice).includes('正在安装'))
      assert.equal(runningNotice.findByType('button').props.disabled, true)
      act(() => {
        snapshot.runtime.one = { state: 'exclusive', driverState: 'connected', driverInstalled: true, error: null }
        views[0].update(React.createElement(InstanceWorkspace, props(0)))
      })
      assert.equal(views[0].root.findAllByProps({ className: 'managed-driver-notice' }).length, 0)
    }

    for (const kind of ['rc003', 'tclRc902n', 'tclRc902v', 'cmiotA15']) {
      act(() => {
        instances[0] = { ...instances[0], kind }
        snapshot.runtime.one = { state: 'disconnected', driverState: 'offline', driverInstalled: false }
        views[0].update(React.createElement(InstanceWorkspace, {
          ...props(0), driverAction: { instanceId: 'one', status: 'error', error: '旧的驱动错误' },
        }))
      })
      const notice = views[0].root.findByProps({ className: 'managed-driver-notice' })
      assert.equal(text(notice), '设备不在线')
      assert.equal(notice.findAllByType('button').length, 0, 'offline devices cannot start driver installation')
      act(() => views[0].root.findByProps({ className: 'device-workspace-settings' }).props.onClick())
      const driverRow = views[0].root.findByProps({ className: 'settings-form-row managed-driver-status-row' })
      const settingsNavigation = views[0].root.findByProps({ className: 'settings-nav device-settings-drawer-nav' })
      assert.deepEqual(settingsNavigation.findAllByType('button').map(text), ['设备设置', '设备信息'])
      const bindingRow = views[0].root.findByProps({ className: 'settings-form-control managed-instance-binding-control' })
      assert.deepEqual(bindingRow.findAllByType('button').map(text), ['重新绑定', '解除绑定，保留配置'])
      act(() => bindingRow.findAllByType('button')[0].props.onClick())
      assert.deepEqual(actions.at(-1), ['bind', 'one'])
      const manageAudioDriver = views[0].root.findAllByType('button').find(button => text(button) === '管理驱动')
      act(() => manageAudioDriver.props.onClick())
      assert.equal(audioDriverRequests.at(-1), 'open')
      assert.equal(views[0].root.findAllByType('select').some(select => select.props.id?.endsWith('voice-output')), false)
      assert.ok(text(driverRow).includes('设备不在线'))
      assert.equal(driverRow.findAllByType('button').length, 0)
      act(() => views[0].root.findByProps({ className: 'device-workspace-settings' }).props.onClick())
    }
    act(() => {
      instances[0] = { ...instances[0], hideDriverMissingReminder: false }
      snapshot.runtime.one = { state: 'driverMissing', driverState: 'missing', driverInstalled: false }
      views[0].update(React.createElement(InstanceWorkspace, props(0)))
    })
    assert.ok(text(views[0].root.findByProps({ className: 'managed-driver-notice' })).includes('安装驱动'))
    act(() => {
      snapshot.runtime.one = { state: 'exclusive', driverState: 'connected', driverInstalled: true }
      views[0].update(React.createElement(InstanceWorkspace, props(0)))
    })
    assert.equal(views[0].root.findAllByProps({ className: 'managed-driver-notice' }).length, 0)
    act(() => views[0].root.findByProps({ className: 'device-workspace-settings' }).props.onClick())
    const reinstall = views[0].root.findByProps({ className: 'settings-form-row managed-driver-status-row' }).findByType('button')
    assert.equal(text(reinstall), '重新安装驱动')
    act(() => reinstall.props.onClick())
    assert.deepEqual(actions.at(-1), ['install', 'one'], 'reinstallation uses the same device install command')
    const message = managedDriverInstallMessage({ rebootRequired: true, installationState: 'restart_before_install' })
    act(() => {
      snapshot.runtime.one = { state: 'disconnected', driverState: 'offline', driverInstalled: false }
      views[0].update(React.createElement(InstanceWorkspace, {
        ...props(0), driverAction: { instanceId: 'one', status: 'restartRequired', message },
      }))
    })
    assert.equal(text(views[0].root.findByProps({ className: 'managed-driver-notice' })), message)
    assert.equal(views[0].root.findByProps({ className: 'managed-driver-notice' }).findAllByType('button').length, 0)
    assert.equal(views[0].root.findByProps({ className: 'settings-form-row managed-driver-status-row' }).findAllByType('button').length, 0)
    act(() => views[0].root.findByProps({ className: 'device-workspace-settings' }).props.onClick())
    act(() => {
      instances[0] = { ...instances[0], hideDriverMissingReminder: false }
      snapshot.runtime.one = { state: 'driverMissing', driverState: 'missing', driverInstalled: false }
      views[0].update(React.createElement(InstanceWorkspace, props(0)))
    })

    act(() => { for (const listener of listeners) listener({ payload: { instanceId: 'two', pressed: ['cmiotA15.up'], values: { 'cmiotA15.up': 1 } } }) })
    assert.deepEqual(Array.from(views[0].root.findByType(RemoteControl).props.pressedIds), [])
    assert.deepEqual(Array.from(views[1].root.findByType(RemoteControl).props.pressedIds), ['cmiotA15.up'])

    act(() => views[0].root.findByProps({ className: 'device-workspace-settings' }).props.onClick())
    assert.ok(text(views[0].root.findByProps({ className: 'settings-form-row managed-driver-status-row' })).includes('未安装'))
    assert.equal(views[0].root.findByType('select').props.value, 'click')
    await act(async () => views[0].root.findByType('select').props.onChange({ target: { value: 'hold' } }))
    assert.equal(instances[0].cmiotA15RecordingMode, 'hold')
    assert.equal(instances[1].cmiotA15RecordingMode, 'click', 'changing one instance preserves the other recording mode')
    act(() => views[1].root.findByProps({ className: 'device-workspace-settings' }).props.onClick())
    assert.equal(views[1].root.findByType('select').props.value, 'click', 'all CMIOT-A15 instances support choosing a recording mode')
    act(() => views[1].root.findByProps({ className: 'device-workspace-settings' }).props.onClick())
    const unbind = views[0].root.findByProps({ className: 'managed-bound-device' }).findAllByType('button')
      .find(button => text(button) === '解除绑定，保留配置')
    await act(async () => unbind.props.onClick())
    assert.deepEqual(actions.at(-1), ['unbind', 'one'])
    act(() => {
      views[0].update(React.createElement(InstanceWorkspace, props(0)))
    })
    assert.equal(views[0].root.findAllByProps({ className: 'managed-driver-notice' }).length, 1)
    assert.ok(text(views[0].root.findByProps({ className: 'settings-form-row managed-driver-status-row' })).includes('未安装'))
    for (const kind of ['rc003', 'tclRc902n', 'tclRc902v', 'cmiotA15']) {
      for (const recording of [true, false]) {
        act(() => {
          instances[1] = { ...instances[1], kind }
          snapshot.runtime.two = { ...snapshot.runtime.two, recording }
          views[1].update(React.createElement(InstanceWorkspace, props(1)))
        })
        const indicator = views[1].root.findByProps({ role: 'status', 'aria-live': 'polite', 'aria-atomic': 'true' })
        assert.equal(text(indicator), recording ? '正在录音' : '语音待机')
        assert.equal(indicator.props.className.includes('is-recording'), recording)
      }
    }
    act(() => {
      instances[1] = { ...instances[1], kind: 'obeRcuR5' }
      views[1].update(React.createElement(InstanceWorkspace, props(1)))
    })
    assert.equal(views[1].root.findAllByProps({ className: 'device-recording-control' }).length, 0)
    assert.equal(views[1].root.findAllByProps({ role: 'status', 'aria-live': 'polite' }).length, 1)
    for (const [kind, battery, manualRecording, recordingModes, voiceCalibration] of [
      ['rc003', true, false, false, true], ['cmiotA15', true, true, true, true], ['xmBt29', true, true, false, true],
      ['rc313', true, true, false, true], ['obeRcuR5', true, false, false, true], ['xboxBluetooth', false, false, false, false],
      ['tclRc802a', true, false, false, true], ['tclRc902n', true, false, true, true], ['tclRc902v', true, false, true, true],
      ['hisenseRcf3b65', true, false, false, false], ['phicommDb1R', true, false, false, false],
      ['kivoK18Lite', false, false, false, false],
      ['g17Touch', false, false, false, false],
    ]) {
      act(() => {
        instances[1] = { ...instances[1], kind }
        views[1].update(React.createElement(InstanceWorkspace, props(1)))
      })
      assert.equal(views[1].root.findAllByProps({ className: 'managed-instance-power' }).length, Number(battery))
      assert.equal(views[1].root.findAllByProps({ className: 'device-recording-control' }).length, Number(manualRecording))
      assert.equal(views[1].root.findAllByProps({ className: 'managed-audio-calibration' }).length, Number(voiceCalibration))
      act(() => views[1].root.findByProps({ className: 'device-workspace-settings' }).props.onClick())
      assert.equal(views[1].root.findAllByType('select').length, Number(recordingModes))
      assert.equal(views[1].root.findAllByProps({ className: 'settings-form-row managed-driver-status-row' }).length, Number(model.supportsWindowsDriver(kind)))
      act(() => views[1].root.findByProps({ className: 'device-workspace-settings' }).props.onClick())
    }
    act(() => {
      instances[1] = { ...instances[1], kind: 'xboxBluetooth' }
      views[1].update(React.createElement(InstanceWorkspace, props(1)))
    })
    assert.equal(views[1].root.findAllByProps({ 'aria-atomic': 'true' }).length, 0)
    act(() => listeners[1]({ payload: { instanceId: 'two', pressed: [], values: { 'xbox.lt': 0.6, 'xbox.rt': 0.3 } } }))
    assert.deepEqual(views[1].root.findAllByType('meter').map(meter => meter.props.value), [0.6, 0.3])
    assert.deepEqual(views[1].root.findByProps({ className: 'managed-analog' }).findAllByType('label').map(text), ['LT ', 'RT '])
    act(() => views[1].root.findByProps({ className: 'device-workspace-settings' }).props.onClick())
    act(() => views[1].root.findAllByType('button').find(node => text(node) === '设备设置').props.onClick())
    for (const [driverState, driverInstalled, label] of [['missing', false, '未安装'], ['connecting', true, '连接中'], ['connected', true, '已连接'], ['offline', false, '设备不在线']]) {
      act(() => {
        snapshot.runtime.two = { state: driverState === 'connected' ? 'exclusive' : 'disconnected', driverState, driverInstalled }
        views[1].update(React.createElement(InstanceWorkspace, props(1)))
      })
      const row = views[1].root.findByProps({ className: 'settings-form-row managed-driver-status-row' })
      assert.ok(text(row).includes(label))
      const buttons = row.findAllByType('button')
      assert.equal(buttons.length, driverState === 'offline' ? 0 : 1)
      if (buttons.length) {
        assert.equal(text(buttons[0]), driverInstalled ? '重新安装驱动' : '安装驱动')
        act(() => buttons[0].props.onClick())
        assert.deepEqual(actions.at(-1), ['install', 'two'])
      }
    }

    act(() => views[0].update(React.createElement(InstanceWorkspace, {
      ...props(0), platform: 'macos', permissions: { accessibility: true, inputMonitoring: true },
    })))
    assert.equal(views[0].root.findAllByProps({ className: 'settings-form-row managed-driver-status-row' }).length, 0)
    assert.equal(views[0].root.findByType('select').props.value, 'hold')
    await act(async () => views[0].root.findByType('select').props.onChange({ target: { value: 'click' } }))
    assert.equal(instances[0].cmiotA15RecordingMode, 'click')
    act(() => views[0].root.findByProps({ className: 'managed-audio-calibration' }).props.onClick())

    for (const kind of ['rc003', 'tclRc902n', 'tclRc902v', 'cmiotA15']) {
      const info = { status: 'ready', bluetoothName: 'REMOTE_NATIVE', batteryLevel: 54, manufacturer: 'IFLY_RCU', serialNumber: '20190620', hardwareRevision: 'HW1', firmwareRevision: 'FW1', softwareRevision: 'SW1' }
      act(() => {
        instances[0] = { ...instances[0], kind, binding: 'info-device' }
        snapshot.discovered = [{ ...device, id: 'info-device', kind, connected: true, bluetoothAddress: 'AA:BB:CC:DD:EE:FF', deviceInfo: info }]
        views[0].update(React.createElement(InstanceWorkspace, props(0)))
      })
      act(() => views[0].root.findAllByType('button').find(node => text(node) === '设备信息').props.onClick())
      const panel = () => views[0].root.findByProps({ className: 'settings-form-fields managed-device-information' })
      const refreshButton = () => views[0].root.findByProps({ 'aria-label': '刷新设备信息' })
      const refreshCount = informationRefreshes.length
      assert.ok(refreshCount > 0, 'entering the information page reads the device')
      assert.equal(informationRefreshes.at(-1), 'info-device')
      assert.equal(refreshButton().props.disabled, false)
      act(() => refreshButton().props.onClick())
      assert.equal(refreshButton().props.disabled, true)
      assert.equal(informationRefreshes.length, refreshCount + 1)
      act(() => refreshButton().props.onClick())
      assert.equal(informationRefreshes.length, refreshCount + 1, 'cooldown blocks duplicate clicks')
      assert.equal(text(refreshButton()), '10s')
      act(() => t.mock.timers.tick(1000))
      assert.equal(text(refreshButton()), '9s')
      act(() => t.mock.timers.tick(8999))
      assert.equal(text(refreshButton()), '1s')
      assert.equal(refreshButton().props.disabled, true)
      act(() => views[0].root.findAllByType('button').find(node => text(node) === '设备设置').props.onClick())
      act(() => views[0].root.findAllByType('button').find(node => text(node) === '设备信息').props.onClick())
      assert.equal(informationRefreshes.length, refreshCount + 2, 'reentering the page refreshes once')
      assert.equal(refreshButton().props.disabled, true, 'navigation preserves the manual cooldown')
      act(() => t.mock.timers.tick(1))
      assert.equal(refreshButton().props.disabled, false)
      assert.equal(refreshButton().props.title, '刷新设备信息')

      for (const value of ['REMOTE_NATIVE', '54%', 'AA:BB:CC:DD:EE:FF', 'IFLY_RCU', '20190620', 'HW1', 'FW1', 'SW1']) assert.ok(text(panel()).includes(value))
      act(() => { info.manufacturer = null; views[0].update(React.createElement(InstanceWorkspace, props(0))) })
      assert.ok(text(panel()).includes('设备未提供'))
      act(() => { info.status = 'retrying'; info.error = '读取超时'; views[0].update(React.createElement(InstanceWorkspace, props(0))) })
      assert.ok(text(panel()).includes('正在重试'))
      act(() => { instances[0] = { ...instances[0], binding: null }; views[0].update(React.createElement(InstanceWorkspace, props(0))) })
      assert.equal((text(panel()).match(/未绑定设备/g) ?? []).length, 9)
      assert.ok(!text(panel()).includes('REMOTE_NATIVE'))
      assert.equal(refreshButton().props.disabled, true)
    }
    assert.deepEqual(actions.at(-1), ['calibrate', 'one'])

    const workspace = views[0].root
    const workflow = workspace.findByType(WorkflowAxonkey)
    const bind = workspace.findByProps({ className: 'managed-instance-bind' })
    assert.equal(text(bind), '绑定设备')
    act(() => bind.props.onClick())
    assert.deepEqual(actions.at(-1), ['bind', 'one'])
    const close = () => workspace.findByProps({ 'aria-label': '关闭设备设置' }).props.onClick()
    const open = () => workspace.findByProps({ className: 'device-workspace-settings' }).props.onClick()
    act(close)
    const openedBefore = modal.opened
    const closedBefore = modal.closed
    act(open)
    assert.equal(modal.opened, openedBefore + 1, 'settings opens as a native modal that blocks background navigation')
    assert.equal(workspace.findByType(WorkflowAxonkey), workflow, 'opening settings preserves the mounted workflow')
    const dialog = () => workspace.findByType('dialog')
    const inside = {}
    act(() => dialog().props.onClick({ target: inside, currentTarget: {} }))
    assert.equal(workspace.findAllByType('dialog').length, 1, 'clicking inside does not close settings')
    let prevented = false
    act(() => dialog().props.onCancel({ preventDefault() { prevented = true } }))
    assert.equal(prevented, true)
    assert.equal(workspace.findAllByType('dialog').length, 0, 'Escape closes settings without leaving the device')
    assert.equal(modal.closed, closedBefore + 1)
    assert.equal(workspace.findByType(WorkflowAxonkey), workflow)
    act(open)
    const backdrop = {}
    act(() => dialog().props.onClick({ target: backdrop, currentTarget: backdrop }))
    assert.equal(workspace.findAllByType('dialog').length, 0, 'clicking the backdrop closes settings')
    act(open)
    act(close)
    assert.equal(workspace.findAllByType('dialog').length, 0, 'close button returns to mapping')
    assert.equal(workspace.findByType(WorkflowAxonkey), workflow)
  } finally { act(() => views.forEach(view => view.unmount())) }
})


test('guide discovery filters bound devices, refreshes and only advances after a successful save', async () => {
  const snapshot = { ...model.emptySnapshot(), discovered: [device, { ...device, id: 'already-bound' }] }
  snapshot.store.instances = [{ ...model.newInstance('xboxBluetooth', 'already-bound'), id: 'existing' }]
  let refreshes = 0, integrated = '', fail = true, submitted, opened = 0, closed = 0
  const controller = { snapshot, error: '', busy: false, refresh: async () => refreshes++, put: async instance => {
    submitted = instance
    if (fail) throw new Error('cannot save device')
    snapshot.store.instances.push({ ...instance, id: 'new-device' })
    return snapshot
  } }
  const props = { controller, native: true, platform: 'windows', permissions: {},
    guide: true, onIntegrated: id => { integrated = id } }
  let view
  act(() => { view = Renderer.create(React.createElement(DeviceDiscoverySection, props), {
    createNodeMock: node => node.type === 'dialog' ? { showModal() { opened++ }, close() { closed++ } } : null,
  }) })
  try {
    assert.equal(view.root.findByType('details').props.open, true)
    const cards = () => view.root.findAll(node => node.type === 'button' && node.props['data-discovered'])
    assert.equal(cards().length, 1)
    const refresh = view.root.findByProps({ className: 'managed-discovered-summary' }).findByProps({ 'aria-label': '刷新设备' })
    let prevented = false, stopped = false
    await act(async () => refresh.props.onClick({ preventDefault() { prevented = true }, stopPropagation() { stopped = true } }))
    assert.equal(prevented && stopped, true)
    assert.equal(view.root.findByType('details').props.open, true)
    assert.equal(refreshes, 1)
    act(() => cards()[0].props.onClick())
    assert.equal(opened, 1, 'integration uses a native modal above the guide')
    await act(async () => view.root.findByProps({ className: 'managed-primary' }).props.onClick())
    assert.equal(integrated, '')
    assert.match(text(view.root.findByProps({ role: 'alert' })), /cannot save device/)
    fail = false
    await act(async () => view.root.findByProps({ className: 'managed-primary' }).props.onClick())
    assert.equal(submitted.binding, device.id)
    assert.equal(integrated, 'new-device')
    assert.equal(closed, 1)
    assert.equal(cards().length, 0)
    assert.match(text(view.toJSON()), /暂未发现可添加的设备/)
  } finally { act(() => view.unmount()) }
})


test('binding dialog defaults to the first free device and only saves on confirmation', async () => {
  const instance = { ...model.newInstance('rc003', null), id: 'migrated' }
  const occupied = { ...model.newInstance('rc003', 'occupied'), id: 'existing' }
  const available = { ...device, id: 'free', kind: 'rc003' }
  const snapshot = { ...model.emptySnapshot(), discovered: [device,
    { ...available, id: 'occupied' }, { ...available, id: 'conflict', identityQuality: 'ambiguous' },
    available, { ...available, id: 'second' }],
    store: { version: 1, revision: 1, instances: [instance, occupied] } }
  const saved = []
  const controller = { snapshot, busy: false, error: '', async put(value) {
    saved.push(value)
    return { ...snapshot, store: { ...snapshot.store, instances: [value, occupied] } }
  } }
  let view
  act(() => { view = Renderer.create(React.createElement(ControlledDeviceHub, {
    controller, native: false, platform: 'windows', permissions: {},
    selectedInstanceId: instance.id, onSelectInstance() {}, bindInstanceId: instance.id,
  })) })
  try {
    assert.equal(view.root.findByType(controls.DeviceBindingPicker).props.value, available.id)
    assert.equal(saved.length, 0)
    assert.equal(view.root.findByProps({ className: 'managed-primary' }).props.disabled, false)
    await act(async () => view.root.findByProps({ className: 'managed-primary' }).props.onClick())
    assert.equal(saved.length, 1)
    assert.equal(saved[0].binding, available.id)
  } finally { act(() => view.unmount()) }
})

test('binding dialog handles delayed discovery and keeps manual choices and existing bindings', () => {
  for (const existingBinding of [null, 'already-bound']) {
    const instance = { ...model.newInstance('rc003', existingBinding), id: 'migrated' }
    const available = { ...device, id: 'first', kind: 'rc003' }
    let snapshot = { ...model.emptySnapshot(),
      store: { version: 1, revision: 1, instances: [instance] } }
    const props = { native: false, platform: 'windows', permissions: {},
      selectedInstanceId: instance.id, onSelectInstance() {} }
    let view
    const render = bindInstanceId => React.createElement(ControlledDeviceHub, { ...props,
      bindInstanceId, controller: { snapshot, busy: false, error: '' } })
    act(() => { view = Renderer.create(render(instance.id)) })
    const picker = () => view.root.findByType(controls.DeviceBindingPicker)
    try {
      assert.equal(picker().props.value, existingBinding ?? '')
      if (!existingBinding) assert.match(text(view.root.findByProps({ role: 'combobox' })), /稍后绑定/)
      snapshot = { ...snapshot, discovered: [available, { ...available, id: 'second' }] }
      act(() => view.update(render(null)))
      assert.equal(picker().props.value, existingBinding ?? 'first')
      act(() => picker().props.onChange('second'))
      snapshot = { ...snapshot, discovered: [...snapshot.discovered].reverse() }
      act(() => view.update(render(null)))
      assert.equal(picker().props.value, 'second')
      act(() => picker().props.onChange(''))
      snapshot = { ...snapshot, discovered: [...snapshot.discovered, { ...available, id: 'third' }] }
      act(() => view.update(render(null)))
      assert.equal(picker().props.value, '')
      assert.match(text(view.root.findByProps({ role: 'combobox' })), /稍后绑定/)
    } finally { act(() => view.unmount()) }
  }
})

test('migration binding request waits for the saved instance then opens its physical-device dialog once', () => {
  const instance = { ...model.newInstance('rc003', null), id: 'migrated' }
  let consumed = 0, view
  const props = { controller: { snapshot: model.emptySnapshot(), busy: false, error: '' }, native: false,
    platform: 'windows', permissions: {}, selectedInstanceId: instance.id, onSelectInstance() {},
    bindInstanceId: instance.id, onBindingOpened() { consumed++ } }
  act(() => { view = Renderer.create(React.createElement(ControlledDeviceHub, props)) })
  assert.equal(consumed, 0)
  const snapshot = { ...model.emptySnapshot(), store: { version: 1, revision: 1, instances: [instance] } }
  act(() => view.update(React.createElement(ControlledDeviceHub, { ...props, controller: { ...props.controller, snapshot } })))
  assert.equal(consumed, 1)
  assert.match(text(view.root.findByProps({ role: 'dialog' })), /绑定物理设备/)
  act(() => view.update(React.createElement(ControlledDeviceHub, { ...props, bindInstanceId: null, controller: { ...props.controller, snapshot } })))
  act(() => view.root.findByProps({ 'aria-label': '关闭集成' }).props.onClick())
  assert.equal(view.root.findAllByProps({ role: 'dialog' }).length, 0)
  assert.equal(consumed, 1)
  act(() => view.unmount())
})

test('managed device workspace renders undo/redo header actions, handles shortcuts and resets on profile switch', async () => {
  const keydownListeners = new Set()
  class MockHTMLElement {
    constructor(tagName = 'DIV') {
      this.tagName = tagName
      this.isContentEditable = false
    }
  }
  let modalOpen = false
  const RemoteControl = () => null
  const WorkflowAxonkey = ({ header }) => header
  const ApplicationProfileToolbar = () => null
  const { InstanceWorkspace } = compile('src/devices/integration/InstanceWorkspace.tsx', {
    'react-dom': { createPortal: node => node },
    '@tauri-apps/api/event': { listen: async () => () => {} },
    '../../behaviorModel': require('../src/behaviorModel.ts'),
    '../../appConfig': { triggerLabels: { click: '单击', doubleClick: '双击', longPress: '长按' } },
    '../../audioGain': require('../src/audioGain.ts'),
    '../../components/InputIcon': compile('src/components/InputIcon.tsx'),
    './railOverview': require('../src/devices/integration/railOverview.ts'),
    '../../deviceInputSelection': require('../src/deviceInputSelection.ts'),
    '../../telemetry': { reportTencentEvent() {} },
    '../../cloud/libraryUsage': { recordLibraryAdditions() {} },
    '../../profileNavigation': require('../src/profileNavigation.ts'),
    '../shared/RemoteControl': { RemoteControl },
    '../../components/ApplicationProfileToolbar': { ApplicationProfileToolbar },
    '../../useForegroundApplications': { useForegroundApplications: () => ({ current: null, recent: [], supported: true, error: null }) },
    './applicationProfiles': require('../src/devices/integration/applicationProfiles.ts'),
    '../../components/ProfileSwitchConfirmDialog': { ProfileSwitchConfirmDialog: () => null },
    '../../components/ProfileSwitchDeleteDialog': { ProfileSwitchDeleteDialog: () => null },
    '../../components/SettingsHelp': { SettingsHelp: () => null },
    '../../components/BatteryIndicator': battery,
    '../../components/BehaviorHistoryActions': compile('src/components/BehaviorHistoryActions.tsx'),
    '../../components/BehaviorSummaryPopover': compile('src/components/BehaviorSummaryPopover.tsx', {
      'react-dom': { createPortal: node => node },
      '../behaviorSummary': require('../src/behaviorSummary.ts'),
    }, {
      window: { innerWidth: 1280, innerHeight: 800, addEventListener() {}, removeEventListener() {} },
    }),
    '../../components/DeviceRail': compile('src/components/DeviceRail.tsx'),
    '../../components/WorkflowAxonkey': { WorkflowAxonkey },
    '../../components/QuickOverlayConfigurator': { QuickOverlayConfigurator: () => null },
    '../../components/workflowSplitLayout': require('../src/components/workflowSplitLayout.ts'),
    '../shared/DeviceWorkspaceHeader': compile('src/devices/shared/DeviceWorkspaceHeader.tsx'),
    '../shared/DeviceSettingsDrawer': compile('src/devices/shared/DeviceSettingsDrawer.tsx', {
      'react-dom': { createPortal: node => node },
    }),
    '../kivo-k18-lite/KivoScreenEditor': compile('src/devices/kivo-k18-lite/KivoScreenEditor.tsx', {
      '../integration/model': model,
    }),
    './IntegrationControls': controls,
    './model': model,
    './instanceProfiles': require('../src/devices/integration/instanceProfiles.ts'),
  }, {
    HTMLElement: MockHTMLElement,
    document: {
      body: {},
      getElementById: () => null,
      activeElement: null,
      querySelector: () => (modalOpen ? {} : null),
    },
    window: {
      localStorage: { getItem: () => null, setItem() {} },
      addEventListener(type, fn) { if (type === 'keydown') keydownListeners.add(fn) },
      removeEventListener(type, fn) { if (type === 'keydown') keydownListeners.delete(fn) },
    },
  })

  let instance = {
    ...model.newInstance('cmiotA15', null),
    id: 'a15-history',
    profiles: [
      { id: 'p1', name: '默认配置', behaviors: {} },
      { id: 'p2', name: '影音配置', behaviors: {} },
    ],
    activeProfileId: 'p1',
  }
  const snapshot = model.emptySnapshot()
  snapshot.store.instances = [instance]
  const toasts = []
  let view
  const render = () => React.createElement(InstanceWorkspace, {
    instance,
    controller: {
      snapshot,
      refreshInformation: async () => {},
      toggleRecording: async () => {},
      update: async (_id, change) => {
        instance = change(instance)
        snapshot.store.instances = [instance]
        return snapshot
      },
    },
    native: false,
    platform: 'macos',
    permissions: { accessibility: true, inputMonitoring: true },
    onPermissions() {},
    onBack() {},
    onBind() {},
    onUnbindDevice: async () => {},
    onRemoveDevice: async () => {},
    onOpenAudioCalibration() {},
    onOpenAudioDriver() {},
    driverAction: null,
    onInstallDriver() {},
    batteryLevel: null,
    onToast: message => toasts.push(message),
  })

  act(() => { view = Renderer.create(render(), { createNodeMock: node => node.type === 'dialog' ? { showModal() {}, close() {} } : null }) })
  try {
    const undoBtn = () => view.root.findByProps({ 'aria-label': '撤销行为更改' })
    const redoBtn = () => view.root.findByProps({ 'aria-label': '重做行为更改' })
    const workflow = () => view.root.findByType(WorkflowAxonkey)
    const remote = () => view.root.findByType(RemoteControl)
    const selectedId = workflow().props.button.id

    assert.equal(undoBtn().props.disabled, true)
    assert.equal(redoBtn().props.disabled, true)
    assert.equal(view.root.findAllByProps({ className: 'key-picker-voice-guidance' }).length, 0)

    act(() => remote().props.onSelect('cmiotA15.voice'))
    const voiceGuidance = view.root.findByProps({ className: 'key-picker-voice-guidance' })
    assert.equal(voiceGuidance.parent.props.className, 'key-picker-heading')
    assert.match(text(voiceGuidance), /要按住说话，请将语音快捷键配在「单击」，「双击」「长按」留空/)
    act(() => remote().props.onSelect(selectedId))
    assert.equal(view.root.findAllByProps({ className: 'key-picker-voice-guidance' }).length, 0)

    const seq1 = { click: [{ id: 's1', type: 'key', enabled: true, key: 'Space' }], doubleClick: [], longPress: [] }
    const seq2 = { click: [{ id: 's2', type: 'key', enabled: true, key: 'Enter' }], doubleClick: [], longPress: [] }

    await act(async () => { workflow().props.onChange(selectedId, seq1) })
    act(() => view.update(render()))
    assert.equal(undoBtn().props.disabled, false)
    assert.equal(redoBtn().props.disabled, true)
    assert.deepEqual(Array.from(remote().props.mappedIds), [selectedId])

    await act(async () => { workflow().props.onChange(selectedId, seq2) })
    act(() => view.update(render()))
    assert.equal(workflow().props.sequences.click[0].key, 'Enter')

    await act(async () => { undoBtn().props.onClick() })
    act(() => view.update(render()))
    assert.equal(workflow().props.sequences.click[0].key, 'Space')
    assert.equal(undoBtn().props.disabled, false)
    assert.equal(redoBtn().props.disabled, false)
    assert.equal(toasts.at(-1), '已撤销行为更改')

    // Typing inside an input or having a modal open must ignore history shortcuts.
    const fireKey = (key, opts = {}) => {
      let prevented = false
      const event = {
        key,
        metaKey: true,
        ctrlKey: false,
        shiftKey: false,
        altKey: false,
        defaultPrevented: false,
        target: new MockHTMLElement('DIV'),
        preventDefault() { prevented = true },
        ...opts,
      }
      for (const listener of keydownListeners) listener(event)
      return prevented
    }

    assert.equal(fireKey('z', { target: new MockHTMLElement('INPUT') }), false)
    modalOpen = true
    assert.equal(fireKey('z'), false)
    modalOpen = false

    await act(async () => { assert.equal(fireKey('z'), true) })
    act(() => view.update(render()))
    assert.equal(workflow().props.sequences.click.length, 0)
    assert.deepEqual(Array.from(remote().props.mappedIds), [])
    assert.equal(undoBtn().props.disabled, true)
    assert.equal(redoBtn().props.disabled, false)

    await act(async () => { assert.equal(fireKey('z', { shiftKey: true }), true) })
    act(() => view.update(render()))
    assert.equal(workflow().props.sequences.click[0].key, 'Space')
    assert.equal(toasts.at(-1), '已重做行为更改')

    await act(async () => { redoBtn().props.onClick() })
    act(() => view.update(render()))
    assert.equal(workflow().props.sequences.click[0].key, 'Enter')
    assert.equal(redoBtn().props.disabled, true)

    // Switching profile resets undo/redo history so undo never restores p1 into p2.
    act(() => {
      view.root.findByType(ApplicationProfileToolbar).props.onSwitchProfile('p2')
    })
    await act(async () => {})
    act(() => view.update(render()))
    assert.equal(undoBtn().props.disabled, true)
    assert.equal(redoBtn().props.disabled, true)
    assert.equal(workflow().props.sequences.click.length, 0)
  } finally {
    act(() => view.unmount())
  }
})

test('discovery help troubleshoot button opens ConnectionTroubleshootPage in DeviceHub and fallback modal in guide mode', async () => {
  const modal = { showModal() {}, close() {} }
  const clipboardWrites = []
  const diagnoseCalls = []
  const sampleReport = {
    platform: 'windows',
    checkedAtMs: 1794711000000,
    summaryKind: 'irk_conflict',
    headline: '检测到蓝牙配对被拦截：0C:E2:90:2E:27:4C 可能发生 IRK 身份密钥冲突',
    detail: 'Windows 日志记录了最近的 蓝牙 IRK 身份密钥冲突 (BTHUSB 事件 35)。',
    bluetoothAdapters: [
      {
        name: 'Realtek Bluetooth Adapter',
        instanceId: 'USB\\VID_0BDA&PID_0852\\1',
        status: 'OK',
        problemCode: null,
        leSupported: true,
      },
    ],
    pairingFailures: [
      {
        timestampIso: '2026-11-15T02:48:28.9417738Z',
        timestampMs: 1794710908941,
        provider: 'BTHUSB',
        eventId: 35,
        kind: 'irk_collision',
        targetAddress: '0C:E2:90:2E:27:4C',
        errorCodeHex: '0x80090003 (NTE_BAD_KEY)',
        title: '蓝牙 IRK 身份密钥冲突 (BTHUSB 事件 35)',
        explanation: '新设备与已配对设备返回相同的 IRK 身份密钥。',
        resolvedNow: false,
        matchingChipSignature: '005D;8762',
      },
      ...Array.from({ length: 7 }, (_, i) => ({
        timestampIso: `2026-11-15T01:0${i}:00Z`,
        timestampMs: 1794700000000 - i * 60000,
        provider: 'DeviceAssociationService',
        eventId: 3501,
        kind: 'pairing_failed',
        targetAddress: `AA:BB:CC:DD:EE:0${i + 1}`,
        errorCodeHex: `0x8007000${i + 1}`,
        title: `历史配对记录 #${i + 2}`,
        explanation: `历史事件说明 #${i + 2}`,
        resolvedNow: true,
        matchingChipSignature: null,
      })),
    ],
    pairedDevices: [
      {
        address: '0C:F3:CE:7F:24:1E',
        name: 'YYYKQ',
        vidHex: '0x0416',
        pidHex: '0x0300',
        chipSignature: '005D;8762',
        chipVendorLabel: 'Realtek (005D;8762)',
        lastConnectedMs: 1794600000000,
        lastSeenMs: 1794600000000,
        present: true,
        boundToQuarbor: true,
        recoveryActive: false,
        supportedKind: 'cmiotA15',
        suspectReason: '与配对失败设备芯片指纹相同 (005D;8762)',
      },
    ],
    warnings: [],
  }

  const troubleshootMod = compile('src/devices/integration/ConnectionTroubleshootPage.tsx', {
    '@tauri-apps/api/core': {
      invoke: async cmd => {
        diagnoseCalls.push(cmd)
        return sampleReport
      },
    },
    '../../clipboard': {
      writeClipboardText: async content => {
        clipboardWrites.push(content)
      },
    },
    './model': model,
  })
  const { DeviceHub: TestHub, DeviceDiscoverySection: TestDiscovery } = compile('src/devices/integration/DeviceHub.tsx', {
    'react-dom': { createPortal: node => node },
    '@tauri-apps/api/event': { listen: async () => () => {} },
    '../../appStorage': require('../src/appStorage.ts'),
    '../../cloud/BehaviorLibraryContext': behaviorLibraryContext,
    '../../cloud/useDeviceModelCatalog': useDeviceModelCatalog,
    './InstanceWorkspace': { InstanceWorkspace: props => React.createElement('instance-workspace', props) },
    './IntegrationControls': controls,
    './ModelMarkdown': modelMarkdown,
    '../../components/SettingsHelp': { SettingsHelp: () => null },
    '../../components/BatteryIndicator': battery,
    './model': model,
    './ConnectionTroubleshootPage': troubleshootMod,
  }, {
    window: new EventTarget(),
  })

  // 1. Inside DeviceHub: clicking 设备无法连接排查 switches into full troubleshoot page and back returns cleanly.
  let toasts = []
  let hubView
  const hubProps = {
    selectedInstanceId: null,
    onSelectInstance() {},
    controller: { snapshot: model.emptySnapshot(), error: '', busy: false },
    native: true,
    platform: 'windows',
    permissions: {},
    onOpenBluetoothSettings() {},
    onOpenDeviceManager() {},
    onOpenLogs() {},
    onToast: msg => toasts.push(msg),
  }
  await act(async () => {
    hubView = Renderer.create(React.createElement(TestHub, hubProps), {
      createNodeMock: node => (node.type === 'dialog' ? modal : null),
    })
  })
  try {
    const helpBtn = hubView.root.findByProps({ className: 'managed-discovery-help' })
    act(() => helpBtn.props.onClick({ preventDefault() {}, stopPropagation() {} }))
    const dialog = hubView.root.findByType('dialog')
    const troubleshootBtn = dialog.findAllByType('button').find(b => text(b) === '设备无法连接排查')
    assert.ok(troubleshootBtn)
    await act(async () => {
      troubleshootBtn.props.onClick()
      await Promise.resolve()
    })
    assert.equal(hubView.root.findAllByType('dialog').length, 0, 'help dialog closes after opening troubleshoot page')
    const page = hubView.root.findByProps({ 'aria-label': '设备无法连接排查' })
    const content = text(page)
    assert.ok(content.includes('0C:E2:90:2E:27:4C'))
    assert.ok(content.includes('YYYKQ'))
    assert.ok(content.includes('0C:F3:CE:7F:24:1E'))
    assert.ok(content.includes('恢复原驱动'))
    assert.ok(content.includes('Realtek Bluetooth Adapter'))
    assert.ok(content.includes('0x80090003 (NTE_BAD_KEY)'))
    assert.deepEqual(diagnoseCalls, ['diagnose_connection_issues'])

    // Verify independent scroll containers keep headers/actions fixed and do not truncate >6 failure records.
    const summaryScroll = page.findByProps({ className: 'troubleshoot-summary-scroll' })
    assert.ok(text(summaryScroll).includes('YYYKQ'))
    assert.ok(page.findByProps({ className: 'troubleshoot-actions-row' }))

    for (const cardClass of [
      'troubleshoot-card troubleshoot-card-devices',
      'troubleshoot-card troubleshoot-card-adapters',
      'troubleshoot-card troubleshoot-card-failures',
      'troubleshoot-card troubleshoot-card-checklist',
    ]) {
      const card = page.findByProps({ className: cardClass })
      const titleNode = card.children.find(child => child && typeof child === 'object' && child.props?.className === 'troubleshoot-card-title')
      const bodyNode = card.children.find(child => child && typeof child === 'object' && child.props?.className === 'troubleshoot-card-body')
      assert.ok(titleNode, `${cardClass} keeps fixed card title outside scroll body`)
      assert.ok(bodyNode, `${cardClass} provides independent .troubleshoot-card-body scroll container`)
    }
    const failuresBody = page.findByProps({ className: 'troubleshoot-card troubleshoot-card-failures' }).findByProps({
      className: 'troubleshoot-card-body',
    })
    assert.ok(text(failuresBody).includes('历史配对记录 #8'), 'all >6 failure records render inside independent scroll container')

    const copyBtn = page.findAllByType('button').find(b => text(b).includes('复制排查信息'))
    assert.ok(copyBtn)
    await act(async () => {
      await copyBtn.props.onClick()
    })
    assert.equal(clipboardWrites.length, 1)
    assert.ok(clipboardWrites[0].includes('0C:F3:CE:7F:24:1E'))
    assert.ok(clipboardWrites[0].includes('005D;8762'))
    assert.equal(toasts.at(-1), '已复制设备排查信息')

    const backBtn = page.findByProps({ className: 'device-workspace-back' })
    act(() => backBtn.props.onClick())
    assert.equal(hubView.root.findAllByProps({ 'aria-label': '设备无法连接排查' }).length, 0)
  } finally {
    act(() => hubView.unmount())
  }

  // 2. Inside standalone DeviceDiscoverySection (e.g. UserGuideDialog) in browser preview: opens fallback modal cleanly.
  let guideView
  await act(async () => {
    guideView = Renderer.create(
      React.createElement(TestDiscovery, {
        guide: true,
        controller: { snapshot: model.emptySnapshot(), error: '', busy: false },
        native: false,
        platform: 'windows',
        permissions: {},
        onOpenBluetoothSettings() {},
        onOpenDeviceManager() {},
        onIntegrated() {},
      }),
      { createNodeMock: node => (node.type === 'dialog' ? modal : null) },
    )
  })
  try {
    const helpBtn = guideView.root.findByProps({ className: 'managed-discovery-help' })
    act(() => helpBtn.props.onClick({ preventDefault() {}, stopPropagation() {} }))
    const helpDialog = guideView.root.findByType('dialog')
    const troubleshootBtn = helpDialog.findAllByType('button').find(b => text(b) === '设备无法连接排查')
    await act(async () => {
      troubleshootBtn.props.onClick()
      await Promise.resolve()
    })
    const modalDialog = guideView.root.findByProps({ className: 'troubleshoot-dialog' })
    assert.ok(text(modalDialog).includes('浏览器预览模式无法读取本机蓝牙日志与驱动信息'))
    const closeBtn = modalDialog.findByProps({ className: 'device-workspace-back' })
    act(() => closeBtn.props.onClick())
    assert.equal(guideView.root.findAllByProps({ className: 'troubleshoot-dialog' }).length, 0)
  } finally {
    act(() => guideView.unmount())
  }
})

test('Kivo K18 Lite workspace uses wide single-lane trigger tabs without Windows driver notices and edits per-profile and per-device OLED screen settings', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] })
  const previewCalls = []
  const screenEditorMod = compile('src/devices/kivo-k18-lite/KivoScreenEditor.tsx', {
    '@tauri-apps/api/core': {
      invoke: async (cmd, args) => {
        previewCalls.push([cmd, args])
        const frame = new Array(512).fill(0)
        frame[0] = 0b1010_0000
        frame[16 * 31 + 15] = 0b0000_0001
        return frame
      },
    },
    '../integration/model': model,
  })
  assert.equal(screenEditorMod.decodeOled1bppPixel([0b1010_0000, ...new Array(511).fill(0)], 0, 0), true)
  assert.equal(screenEditorMod.decodeOled1bppPixel([0b1010_0000, ...new Array(511).fill(0)], 1, 0), false)
  assert.equal(screenEditorMod.decodeOled1bppPixel([0b1010_0000, ...new Array(511).fill(0)], 2, 0), true)

  const RemoteControl = () => null
  const WorkflowAxonkey = ({ header }) => header
  const ApplicationProfileToolbar = () => null
  const { InstanceWorkspace } = compile('src/devices/integration/InstanceWorkspace.tsx', {
    'react-dom': { createPortal: node => node },
    '@tauri-apps/api/event': { listen: async () => () => {} },
    '../../behaviorModel': require('../src/behaviorModel.ts'),
    '../../appConfig': { triggerLabels: { click: '单击', doubleClick: '双击', longPress: '长按' } },
    '../../audioGain': require('../src/audioGain.ts'),
    '../../components/InputIcon': compile('src/components/InputIcon.tsx'),
    './railOverview': require('../src/devices/integration/railOverview.ts'),
    '../../deviceInputSelection': require('../src/deviceInputSelection.ts'),
    '../../telemetry': { reportTencentEvent() {} },
    '../../cloud/libraryUsage': { recordLibraryAdditions() {} },
    '../../profileNavigation': require('../src/profileNavigation.ts'),
    '../shared/RemoteControl': { RemoteControl },
    '../../components/ApplicationProfileToolbar': { ApplicationProfileToolbar },
    '../../useForegroundApplications': { useForegroundApplications: () => ({ current: null, recent: [], supported: true, error: null }) },
    './applicationProfiles': require('../src/devices/integration/applicationProfiles.ts'),
    '../../components/ProfileSwitchConfirmDialog': { ProfileSwitchConfirmDialog: () => null },
    '../../components/ProfileSwitchDeleteDialog': { ProfileSwitchDeleteDialog: () => null },
    '../../components/SettingsHelp': { SettingsHelp: () => null },
    '../../components/BatteryIndicator': battery,
    '../../components/BehaviorHistoryActions': compile('src/components/BehaviorHistoryActions.tsx'),
    '../../components/BehaviorSummaryPopover': compile('src/components/BehaviorSummaryPopover.tsx', {
      'react-dom': { createPortal: node => node },
      '../behaviorSummary': require('../src/behaviorSummary.ts'),
    }, {
      window: { innerWidth: 1280, innerHeight: 800, addEventListener() {}, removeEventListener() {} },
    }),
    '../../components/DeviceRail': compile('src/components/DeviceRail.tsx'),
    '../../components/WorkflowAxonkey': { WorkflowAxonkey },
    '../../components/QuickOverlayConfigurator': { QuickOverlayConfigurator: () => null },
    '../../components/workflowSplitLayout': require('../src/components/workflowSplitLayout.ts'),
    '../shared/DeviceWorkspaceHeader': compile('src/devices/shared/DeviceWorkspaceHeader.tsx'),
    '../shared/DeviceSettingsDrawer': compile('src/devices/shared/DeviceSettingsDrawer.tsx', {
      'react-dom': { createPortal: node => node },
    }),
    '../kivo-k18-lite/KivoScreenEditor': screenEditorMod,
    './IntegrationControls': controls,
    './model': model,
    './instanceProfiles': require('../src/devices/integration/instanceProfiles.ts'),
  })

  let instance = {
    ...model.newInstance('kivoK18Lite', null),
    id: 'kivo-one',
    profiles: [
      {
        id: 'p1',
        name: '默认配置',
        behaviors: {
          'kivo.k18Lite.k01': {
            click: [{ id: 's1', type: 'key', enabled: true, key: 'Enter' }],
            doubleClick: [{ id: 's2', type: 'delay', enabled: true, ms: 50 }],
            longPress: [],
          },
        },
      },
      { id: 'p2', name: '剪辑配置', behaviors: {} },
    ],
    activeProfileId: 'p1',
    applicationProfiles: [
      { application: { id: 'com.apple.FinalCut', name: 'Final Cut Pro', path: '/Applications/Final Cut Pro.app' }, profileId: 'p2' },
    ],
  }
  const snapshot = model.emptySnapshot()
  snapshot.store.instances = [instance]
  snapshot.runtime['kivo-one'] = { state: 'driverMissing', driverState: 'missing', driverInstalled: false }
  let view
  const render = () =>
    React.createElement(InstanceWorkspace, {
      instance,
      controller: {
        snapshot,
        refreshInformation: async () => {},
        toggleRecording: async () => {},
        update: async (_id, change) => {
          instance = change(instance)
          snapshot.store.instances = [instance]
          return snapshot
        },
      },
      native: true,
      platform: 'windows',
      permissions: {},
      onPermissions() {},
      onBack() {},
      onBind() {},
      onUnbindDevice: async () => {},
      onRemoveDevice: async () => {},
      onOpenAudioCalibration() {},
      onOpenAudioDriver() {},
      driverAction: null,
      onInstallDriver() {},
      batteryLevel: null,
    })

  act(() => {
    view = Renderer.create(render())
  })
  try {
    const rootDiv = view.root.find(node => node.type === 'div' && node.props.className?.includes('managed-instance-workspace'))
    assert.match(rootDiv.props.className, /\bis-controller\b/)
    assert.equal(view.root.findAllByProps({ className: 'remote-stage managed-controller-stage' }).length, 1)
    assert.equal(view.root.findAllByProps({ className: 'managed-driver-notice' }).length, 0)
    assert.ok(view.root.findByType(RemoteControl).props.screenRegion)

    const triggerGroup = view.root.findByProps({ className: 'managed-workflow-triggers' })
    const triggerBtns = triggerGroup.findAllByType('button')
    assert.deepEqual(triggerBtns.map(text), ['单击1', '双击1', '长按0'])
    assert.equal(view.root.findByType(WorkflowAxonkey).props.activeTrigger, 'click')
    act(() => triggerBtns[1].props.onClick())
    assert.equal(view.root.findByType(WorkflowAxonkey).props.activeTrigger, 'doubleClick')

    // Click OLED screen region -> switches right panel to KivoScreenEditor
    act(() => view.root.findByType(RemoteControl).props.onSelect('__screen__'))
    assert.equal(view.root.findAllByType(WorkflowAxonkey).length, 0)
    const editor = () => view.root.findByProps({ className: 'kivo-screen-editor' })
    assert.equal(
      editor().findByProps({ className: 'kivo-oled-preview' }).props['aria-label'],
      'OLED 屏幕预览：Kivo K18 Lite / 默认配置',
    )
    await act(async () => {
      t.mock.timers.tick(80)
      await Promise.resolve()
    })
    assert.deepEqual(structuredClone(previewCalls.at(-1)), [
      'render_kivo_oled_preview',
      { line1: 'Kivo K18 Lite', line2: '默认配置' },
    ])

    // Switch to custom mode and type per-profile lines
    const radios = () => editor().findAllByProps({ role: 'radio' })
    await act(async () => radios()[1].props.onClick())
    act(() => view.update(render()))
    const textInputs = () => editor().findAll(node => node.type === 'input' && node.props.type === 'text')
    assert.equal(textInputs().length, 2)
    await act(async () => {
      textInputs()[0].props.onCompositionStart()
      textInputs()[0].props.onChange({ target: { value: 'kai' }, nativeEvent: { isComposing: true } })
      textInputs()[0].props.onChange({ target: { value: 'kaifa' }, nativeEvent: { isComposing: true } })
    })
    act(() => view.update(render()))
    assert.equal(textInputs()[0].props.value, 'kaifa')
    assert.equal(instance.profiles[0].display.line1, '')
    await act(async () => {
      textInputs()[0].props.onCompositionEnd({ currentTarget: { value: '开发模式' } })
      textInputs()[0].props.onChange({ target: { value: '开发模式' }, nativeEvent: { isComposing: false } })
    })
    act(() => view.update(render()))
    await act(async () => {
      textInputs()[1].props.onCompositionStart()
      textInputs()[1].props.onChange({ target: { value: 'zhongwen' }, nativeEvent: { isComposing: true } })
    })
    act(() => view.update(render()))
    assert.equal(textInputs()[1].props.value, 'zhongwen')
    assert.equal(instance.profiles[0].display.line2, '')
    await act(async () => {
      textInputs()[1].props.onCompositionEnd({ currentTarget: { value: '中文屏幕' } })
    })
    act(() => view.update(render()))
    assert.deepEqual(structuredClone(instance.profiles[0].display), {
      mode: 'custom',
      line1: '开发模式',
      line2: '中文屏幕',
    })
    assert.equal(instance.profiles[1].display, undefined)

    // Selecting an ApplicationProfile previews that app name + its profile name in auto mode
    act(() => view.root.findByType(ApplicationProfileToolbar).props.onSelectApplication('com.apple.FinalCut'))
    assert.equal(
      editor().findByProps({ className: 'kivo-oled-preview' }).props['aria-label'],
      'OLED 屏幕预览：Final Cut Pro / 剪辑配置',
    )

    // Device-level display settings update brightness, sleep timeout (0 = 从不), and toast switches
    const range = editor().find(node => node.type === 'input' && node.props.type === 'range')
    await act(async () => range.props.onChange({ target: { value: '65' } }))
    act(() => view.update(render()))
    const sleepSelect = editor().findByType('select')
    await act(async () => sleepSelect.props.onChange({ target: { value: '0' } }))
    act(() => view.update(render()))
    const checkboxes = () => editor().findAll(node => node.type === 'input' && node.props.type === 'checkbox')
    await act(async () => checkboxes()[0].props.onChange({ target: { checked: false } }))
    act(() => view.update(render()))
    assert.deepEqual(structuredClone(instance.display), {
      brightness: 65,
      sleepTimeoutSec: 0,
      showKeyToast: false,
      showProfileToast: true,
    })

    // Selecting any keycap returns immediately to WorkflowAxonkey
    act(() => view.root.findByType(RemoteControl).props.onSelect('kivo.k18Lite.k02'))
    assert.equal(view.root.findAllByProps({ className: 'kivo-screen-editor' }).length, 0)
    assert.equal(view.root.findByType(WorkflowAxonkey).props.button.id, 'kivo.k18Lite.k02')
  } finally {
    act(() => view.unmount())
  }
})

test('rail configured overview shows only configured buttons, excludes sticks/triggers/screens, and syncs live voice amplitude bars', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] })
  const listeners = []
  const levelQueue = [
    { peak: 0.2, rms: 0.1 },
    { peak: 0.9, rms: 0.6 },
  ]
  const levelCalls = []
  const RemoteControl = () => null
  const WorkflowAxonkey = ({ button }) => React.createElement('workflow-stub', { buttonId: button.id })
  const { InstanceWorkspace } = compile('src/devices/integration/InstanceWorkspace.tsx', {
    'react-dom': { createPortal: node => node },
    '@tauri-apps/api/core': {
      invoke: async (cmd, args) => {
        levelCalls.push([cmd, args])
        if (cmd === 'get_audio_level') return levelQueue.shift() ?? { peak: 0, rms: 0 }
        return null
      },
    },
    '@tauri-apps/api/event': {
      listen: async (_, listener) => {
        listeners.push(listener)
        return () => {}
      },
    },
    '../../behaviorModel': require('../src/behaviorModel.ts'),
    '../../appConfig': { triggerLabels: { click: '单击', doubleClick: '双击', longPress: '长按' } },
    '../../audioGain': require('../src/audioGain.ts'),
    '../../components/InputIcon': compile('src/components/InputIcon.tsx'),
    './railOverview': require('../src/devices/integration/railOverview.ts'),
    '../../deviceInputSelection': require('../src/deviceInputSelection.ts'),
    '../../telemetry': { reportTencentEvent() {} },
    '../../cloud/libraryUsage': { recordLibraryAdditions() {} },
    '../../profileNavigation': require('../src/profileNavigation.ts'),
    '../shared/RemoteControl': { RemoteControl },
    '../../components/ProfileManager': { ProfileManager: () => null },
    '../../components/ApplicationProfileToolbar': { ApplicationProfileToolbar: () => null },
    '../../useForegroundApplications': { useForegroundApplications: () => ({ current: null, recent: [], supported: true, error: null }) },
    './applicationProfiles': require('../src/devices/integration/applicationProfiles.ts'),
    '../../components/ProfileSwitchConfirmDialog': { ProfileSwitchConfirmDialog: () => null },
    '../../components/ProfileSwitchDeleteDialog': { ProfileSwitchDeleteDialog: () => null },
    '../../components/SettingsHelp': { SettingsHelp: () => null },
    '../../components/BatteryIndicator': battery,
    '../../components/BehaviorHistoryActions': compile('src/components/BehaviorHistoryActions.tsx'),
    '../../components/BehaviorSummaryPopover': compile('src/components/BehaviorSummaryPopover.tsx', {
      'react-dom': { createPortal: node => node },
      '../behaviorSummary': require('../src/behaviorSummary.ts'),
    }, {
      window: { innerWidth: 1280, innerHeight: 800, addEventListener() {}, removeEventListener() {} },
    }),
    '../../components/DeviceRail': compile('src/components/DeviceRail.tsx'),
    '../../components/WorkflowAxonkey': { WorkflowAxonkey },
    '../../components/QuickOverlayConfigurator': { QuickOverlayConfigurator: () => null },
    '../../components/workflowSplitLayout': require('../src/components/workflowSplitLayout.ts'),
    '../shared/DeviceWorkspaceHeader': compile('src/devices/shared/DeviceWorkspaceHeader.tsx'),
    '../shared/DeviceSettingsDrawer': compile('src/devices/shared/DeviceSettingsDrawer.tsx', {
      'react-dom': { createPortal: node => node },
    }),
    '../kivo-k18-lite/KivoScreenEditor': compile('src/devices/kivo-k18-lite/KivoScreenEditor.tsx', {
      '../integration/model': model,
    }),
    './IntegrationControls': controls,
    './model': model,
    './instanceProfiles': require('../src/devices/integration/instanceProfiles.ts'),
  })

  let instance = {
    ...model.newInstance('rc003', 'phys-rc003'),
    id: 'rc003-one',
    audioGainDb: 6,
    profiles: [
      {
        id: 'default',
        name: '默认配置',
        behaviors: {
          power: {
            click: [{ id: 'p1', type: 'key', enabled: true, key: 'Esc' }],
            doubleClick: [],
            longPress: [
              { id: 'p2', type: 'shortcut', enabled: true, keys: ['Win', 'A'] },
              { id: 'p3', type: 'delay', enabled: true, ms: 30 },
            ],
          },
          confirm: {
            click: [{ id: 'c1', type: 'key', enabled: false, key: 'Enter' }],
            doubleClick: [],
            longPress: [],
          },
        },
      },
    ],
  }
  const snapshot = model.emptySnapshot()
  snapshot.store.instances = [instance]
  snapshot.discovered = [{ ...device, id: 'phys-rc003', kind: 'rc003', connected: true }]
  snapshot.runtime['rc003-one'] = { state: 'exclusive', recording: false }

  const render = (platform = 'macos') =>
    React.createElement(InstanceWorkspace, {
      instance,
      controller: {
        snapshot,
        refreshInformation: async () => {},
        toggleRecording: async () => {},
        update: async (_id, change) => {
          instance = change(instance)
          snapshot.store.instances = [instance]
          return snapshot
        },
      },
      native: true,
      platform,
      permissions: { accessibility: true, inputMonitoring: true },
      onPermissions() {},
      onBack() {},
      onBind() {},
      onUnbindDevice: async () => {},
      onRemoveDevice: async () => {},
      onOpenAudioCalibration() {},
      onOpenAudioDriver() {},
      driverAction: null,
      onInstallDriver() {},
      batteryLevel: 85,
    })

  let view
  await act(async () => {
    view = Renderer.create(render('macos'))
  })
  try {
    const tabs = () => view.root.findAllByProps({ role: 'tab' })
    assert.deepEqual(tabs().map(text), ['遥控器', '已配速览 (2)'])
    assert.equal(levelCalls.length, 0)
    const barsContainer = () => view.root.findByProps({ className: 'device-recording-bars' })
    assert.equal(barsContainer().findAllByType('i').length, 7)
    assert.equal(text(view.root.findByProps({ role: 'status', 'aria-live': 'polite' })), '语音待机')

    // Switch to 已配速览
    act(() => tabs()[1].props.onClick())
    const rows = () => view.root.findAllByProps({ role: 'option' })
    assert.equal(rows().length, 2)
    assert.ok(text(rows()[0]).includes('电源键'))
    assert.ok(text(rows()[0]).includes('单击: 退出（Esc） · 长按: Cmd + A 等2步'))
    assert.ok(text(rows()[1]).includes('确认键'))
    assert.ok(text(rows()[1]).includes('OK'))
    assert.ok(text(rows()[1]).includes('单击: 已停用'))

    // Short single-step item does not open popover when not overflowing; truncated URL or multi-step opens floating popover
    const shortAnchor = { querySelector: () => ({ scrollWidth: 80, clientWidth: 160 }), getBoundingClientRect: () => ({ left: 14, right: 200, top: 120, bottom: 164 }) }
    act(() => {
      rows()[1].props.onMouseEnter({ currentTarget: shortAnchor })
      t.mock.timers.tick(300)
    })
    assert.equal(view.root.findAllByProps({ className: 'behavior-summary-popover' }).length, 0)

    instance = {
      ...instance,
      profiles: [
        {
          id: 'default',
          name: '默认配置',
          behaviors: {
            ...instance.profiles[0].behaviors,
            volumeDown: {
              click: [{ id: 'v1', type: 'openWebsite', enabled: true, url: 'https://orbit.wleo.cn/very/long/path/demo' }],
              doubleClick: [],
              longPress: [],
            },
          },
        },
      ],
    }
    act(() => view.update(render('macos')))
    const longAnchor = { querySelector: () => ({ scrollWidth: 260, clientWidth: 160 }), getBoundingClientRect: () => ({ left: 14, right: 200, top: 200, bottom: 244 }) }
    act(() => {
      rows()[2].props.onMouseEnter({ currentTarget: longAnchor })
      t.mock.timers.tick(260)
    })
    const popovers = view.root.findAllByProps({ className: 'behavior-summary-popover' })
    assert.equal(popovers.length, 1)
    assert.ok(text(popovers[0]).includes('https://orbit.wleo.cn/very/long/path/demo'))
    act(() => {
      rows()[2].props.onMouseLeave({})
      t.mock.timers.tick(150)
    })
    assert.equal(view.root.findAllByProps({ className: 'behavior-summary-popover' }).length, 0)

    // Select power row & verify physical key press highlights row
    act(() => rows()[0].props.onClick())
    assert.equal(view.root.findByType('workflow-stub').props.buttonId, 'power')
    assert.match(rows()[0].props.className, /\bselected\b/)
    act(() => {
      for (const listener of listeners) listener({ payload: { instanceId: 'rc003-one', pressed: ['power'], values: {} } })
    })
    assert.match(rows()[0].props.className, /\bpressed\b/)

    // Empty state returns cleanly to diagram tab
    instance = { ...instance, profiles: [{ id: 'default', name: '默认配置', behaviors: {} }] }
    act(() => view.update(render('macos')))
    assert.equal(text(tabs()[1]), '已配速览')
    const emptyGoBtn = view.root.findByProps({ className: 'rail-keymap-empty' }).findByType('button')
    act(() => emptyGoBtn.props.onClick())
    assert.equal(tabs()[0].props['aria-selected'], true)

    // Xbox excludes analog sticks (axis) & triggers (trigger), keeping only buttons & D-pad (hat)
    instance = {
      ...model.newInstance('xboxBluetooth', 'phys-xbox'),
      id: 'xbox-one',
      profiles: [
        {
          id: 'default',
          name: '默认配置',
          behaviors: {
            'xbox.a': { click: [{ id: 'a1', type: 'key', enabled: true, key: 'Space' }], doubleClick: [], longPress: [] },
            'xbox.dpad.up': { click: [{ id: 'd1', type: 'key', enabled: true, key: 'Up' }], doubleClick: [], longPress: [] },
            'xbox.ls.left': { click: [{ id: 'l1', type: 'key', enabled: true, key: 'A' }], doubleClick: [], longPress: [] },
            'xbox.lt': { click: [{ id: 't1', type: 'key', enabled: true, key: 'B' }], doubleClick: [], longPress: [] },
          },
        },
      ],
    }
    act(() => view.update(render('macos')))
    assert.deepEqual(tabs().map(text), ['手柄', '已配速览 (2)'])
    act(() => tabs()[1].props.onClick())
    assert.equal(rows().length, 2)
    assert.ok(rows().every(row => !text(row).includes('摇杆') && !text(row).includes('扳机')))

    // Kivo K18 Lite excludes OLED screenRegion even when configured
    instance = {
      ...model.newInstance('kivoK18Lite', null),
      id: 'kivo-one',
      profiles: [
        {
          id: 'default',
          name: '默认配置',
          display: { mode: 'custom', line1: 'Line 1', line2: 'Line 2' },
          behaviors: {
            'kivo.k18Lite.k01': { click: [{ id: 'k1', type: 'key', enabled: true, key: 'Enter' }], doubleClick: [], longPress: [] },
          },
        },
      ],
    }
    act(() => view.update(render('macos')))
    assert.deepEqual(tabs().map(text), ['控制器', '已配速览 (1)'])
    act(() => tabs()[1].props.onClick())
    assert.equal(rows().length, 1)
    assert.ok(!text(rows()[0]).includes('OLED'))

    // Recording polls get_audio_level, scales amplitude with audioGainDb (+6 dB), and stops on release
    instance = { ...model.newInstance('rc003', 'phys-rc003'), id: 'rc003-one', audioGainDb: 6 }
    snapshot.runtime['rc003-one'] = { state: 'exclusive', recording: true }
    await act(async () => {
      view.update(render('macos'))
      await Promise.resolve()
    })
    assert.deepEqual(structuredClone(levelCalls[0]), ['get_audio_level', { instanceId: 'rc003-one' }])
    assert.match(view.root.findByProps({ role: 'status', 'aria-live': 'polite' }).props.className, /\btone-good\b/)
    const barHeights1 = barsContainer().findAllByType('i').map(bar => parseFloat(bar.props.style.height))
    assert.ok(barHeights1[6] > 3)

    await act(async () => {
      t.mock.timers.tick(80)
      await Promise.resolve()
    })
    // peak=0.9 with +6 dB gain => ~1.79 => clipping
    assert.match(view.root.findByProps({ role: 'status', 'aria-live': 'polite' }).props.className, /\btone-clipping\b/)
    const countWhileRecording = levelCalls.length

    snapshot.runtime['rc003-one'] = { state: 'exclusive', recording: false }
    await act(async () => {
      view.update(render('macos'))
    })
    await act(async () => {
      t.mock.timers.tick(300)
      await Promise.resolve()
    })
    assert.equal(levelCalls.length, countWhileRecording)
    assert.equal(text(view.root.findByProps({ role: 'status', 'aria-live': 'polite' })), '语音待机')

    // Local custom descriptor overriding cloud shows warning banner inside matching InstanceWorkspace only
    const { parseRuntimeDescriptorSvg } = require('../src/devices/shared/descriptorSvg.ts')
    const baseRc003Svg = readFileSync('public/device-descriptors/rc003.svg', 'utf8')
    const localRc003Svg = baseRc003Svg.replace('小米 RC003', '小米 RC003 本地测试版')
    model.setRuntimeSupportPackages([parseRuntimeDescriptorSvg(baseRc003Svg, { kind: 'rc003', name: '小米 RC003', model: 'RC003' }).supportPackage])
    model.setLocalCustomSupportPackages([parseRuntimeDescriptorSvg(localRc003Svg, { kind: 'rc003', name: '小米 RC003 本地测试版', model: 'RC003' }).supportPackage])
    act(() => view.update(render('macos')))
    const wsWarnings = view.root.findAll(node => node.props?.className === 'managed-warning')
    assert.equal(wsWarnings.length, 1)
    assert.match(text(wsWarnings[0]), /小米 RC003 本地测试版/)

    // Switching to another kind without local override hides the warning
    instance = { ...model.newInstance('kivoK18Lite', null), id: 'kivo-one' }
    act(() => view.update(render('macos')))
    assert.equal(view.root.findAll(node => node.props?.className === 'managed-warning').length, 0)
  } finally {
    model.resetRuntimeSupportPackages()
    act(() => view.unmount())
  }
})
