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
    setTimeout: (...args) => globalThis.setTimeout(...args), clearTimeout: (...args) => globalThis.clearTimeout(...args),
    setInterval: (...args) => globalThis.setInterval(...args), clearInterval: (...args) => globalThis.clearInterval(...args),
    document: { getElementById: () => null, activeElement: null, body: {} }, HTMLElement: class {},
    require: name => imports[name] ?? (name.endsWith('.css') ? {} : require(name)),
  })
  return module.exports
}
const model = compile('src/devices/integration/model.ts', {
  '../xiaomi-remote/buttons': { xiaomiRemoteButtons: require('../src/devices/xiaomi-remote/buttons.ts').xiaomiRemoteButtons },
  '../xiaomi-remote/view': { xiaomiRemoteView: { artworkUrl: 'remote.svg' } },
  '../xbox-controller/xbox-controller.svg': { default: 'controller.svg' },
  '../cmiot-a15-remote/definition': { cmiotA15RemoteDevice: { remoteView: { artworkUrl: 'remote.svg' }, buttons: require('../src/devices/cmiot-a15-remote/buttons.ts').cmiotA15RemoteButtons } },
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
const { managedDriverInstallMessage } = compile('src/systemState.ts')

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
  const props = { controller: { snapshot, error: '', busy: false }, native: true, platform: 'windows', permissions: {}, legacyProfiles: () => [] }
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
  const props = { controller: { snapshot, error: '', busy: false }, native: true, platform: 'macos', permissions: {}, legacyProfiles: () => [] }
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
      controller, native: false, platform, permissions: {}, legacyProfiles: () => [],
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
    act(() => view.unmount())
  }
})

test('A15 workspace scopes driver actions, recording mode and input feedback to its instance', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] })
  const listeners = []
  const RemoteControl = () => null
  const { InstanceWorkspace } = compile('src/devices/integration/InstanceWorkspace.tsx', {
    'react-dom': { createPortal: node => node },
    '@tauri-apps/api/event': { listen: async (_, listener) => { listeners.push(listener); return () => {} } },
    '../../behaviorModel': require('../src/behaviorModel.ts'),
    '../../appConfig': { triggerLabels: {} },
    '../../profileNavigation': require('../src/profileNavigation.ts'),
    '../../components/RemoteControl': { RemoteControl },
    '../../components/ProfileManager': { ProfileManager: () => null },
    '../../components/ProfileSwitchConfirmDialog': { ProfileSwitchConfirmDialog: () => null },
    '../../components/ProfileSwitchDeleteDialog': { ProfileSwitchDeleteDialog: () => null },
    '../../components/SettingsHelp': { SettingsHelp: () => null },
    '../../components/BatteryIndicator': battery,
    '../../components/DeviceRail': compile('src/components/DeviceRail.tsx'),
    '../../components/WorkflowAxonkey': { WorkflowAxonkey: () => null },
    '../shared/DeviceWorkspaceHeader': compile('src/devices/shared/DeviceWorkspaceHeader.tsx'),
    './IntegrationControls': controls,
    '../xiaomi-remote/settings/VoiceOutput': { VoiceOutput: () => null },
    '../xbox-controller/ControllerDiagram': { ControllerDiagram: () => null },
    '../xiaomi-remote/view': { xiaomiRemoteView: {} },
    '../cmiot-a15-remote/definition': { cmiotA15RemoteDevice: {} },
    './model': model,
    './instanceProfiles': require('../src/devices/integration/instanceProfiles.ts'),
  })
  const instances = ['one', 'two'].map(id => ({ ...model.newInstance('cmiotA15', `physical-${id}`), id, legacyProfilesMigrated: true }))
  const snapshot = model.emptySnapshot()
  snapshot.store.instances = instances
  snapshot.runtime = {
    one: { state: 'driverMissing', driverState: 'missing', driverInstalled: false },
    two: { state: 'exclusive', driverState: 'connected', driverInstalled: true, recording: true },
  }
  const actions = []
  const informationRefreshes = []
  const controller = { snapshot, refreshInformation: async binding => { informationRefreshes.push(binding) }, update: async (id, change) => {
    const index = instances.findIndex(item => item.id === id)
    instances[index] = change(instances[index])
    return snapshot
  } }
  const props = index => ({ instance: instances[index], controller, native: true, platform: 'windows', permissions: {},
    legacyProfiles: () => [], driverAction: null, batteryLevel: index === 0 ? 15 : 78,
    onInstallDriver: id => actions.push(['install', id]),
    onUnbindDevice: async id => actions.push(['unbind', id]),
    onOpenAudioCalibration: id => actions.push(['calibrate', id]),
  })
  const views = []
  await act(async () => { for (let index = 0; index < 2; index++) views.push(Renderer.create(React.createElement(InstanceWorkspace, props(index)))) })
  try {
    assert.ok(text(views[0].root.findByProps({ className: 'managed-instance-power' })).includes('15%'))
    assert.ok(text(views[1].root.findByProps({ className: 'managed-instance-power' })).includes('78%'))
    assert.equal(views[0].root.findAllByProps({ className: 'managed-driver-notice' }).length, 1)
    assert.equal(views[1].root.findAllByProps({ className: 'managed-driver-notice' }).length, 0)
    assert.ok(text(views[1].root.findByProps({ role: 'status', 'aria-live': 'polite', 'aria-atomic': 'true' })).includes('正在录音'))
    assert.ok(!text(views[0].root.findByProps({ className: 'mapping-device-rail panel-surface' })).includes('正在录音'))
    act(() => views[0].root.findByProps({ className: 'managed-driver-notice' }).findAllByType('button')[0].props.onClick())
    act(() => views[1].root.findByProps({ className: 'managed-audio-calibration' }).props.onClick())
    assert.deepEqual(actions, [['install', 'one'], ['calibrate', 'two']])

    const communicationError = 'Quarbor Universal connect (BTHLEDEVICE\\device): 系统找不到指定的文件。(os error 2)'
    for (const kind of ['rc003', 'cmiotA15']) {
      act(() => {
        instances[0] = { ...instances[0], kind, hideDriverMissingReminder: true }
        snapshot.runtime.one = { state: 'disconnected', driverState: 'connecting', driverInstalled: true, error: communicationError }
        views[0].update(React.createElement(InstanceWorkspace, props(0)))
      })
      const notice = views[0].root.findByProps({ className: 'managed-driver-notice' })
      assert.ok(text(notice).includes(communicationError))
      const button = notice.findByType('button')
      assert.equal(text(button), '重新安装驱动')
      assert.equal(button.props.disabled, false)
      assert.equal(views[0].root.findAllByProps({ className: 'managed-error' }).length, 0, 'communication errors are shown once')
      act(() => button.props.onClick())
      assert.deepEqual(actions.at(-1), ['install', 'one'])
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

    for (const kind of ['rc003', 'cmiotA15']) {
      act(() => {
        instances[0] = { ...instances[0], kind, hideDriverMissingReminder: true }
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
      instances[0] = { ...instances[0], hideDriverMissingReminder: true }
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
    assert.equal(views[0].root.findByType(RemoteControl).props.pressedId, null)
    assert.equal(views[1].root.findByType(RemoteControl).props.pressedId, 'cmiotA15.up')

    act(() => views[0].root.findByProps({ className: 'device-workspace-settings' }).props.onClick())
    assert.ok(text(views[0].root.findByProps({ className: 'settings-form-row managed-driver-status-row' })).includes('未安装'))
    await act(async () => views[0].root.findByType('select').props.onChange({ target: { value: 'click' } }))
    assert.equal(instances[0].cmiotA15RecordingMode, 'click')
    assert.equal(instances[1].cmiotA15RecordingMode, 'hold')
    await act(async () => views[0].root.findByProps({ className: 'managed-bound-device' }).findByType('button').props.onClick())
    assert.deepEqual(actions.at(-1), ['unbind', 'one'])
    act(() => {
      instances[0] = { ...instances[0], hideDriverMissingReminder: true }
      views[0].update(React.createElement(InstanceWorkspace, props(0)))
    })
    assert.equal(views[0].root.findAllByProps({ className: 'managed-driver-notice' }).length, 0)
    assert.ok(text(views[0].root.findByProps({ className: 'settings-form-row managed-driver-status-row' })).includes('未安装'))
    for (const kind of ['rc003', 'cmiotA15']) {
      for (const recording of [true, false]) {
        act(() => {
          instances[1] = { ...instances[1], kind }
          snapshot.runtime.two = { ...snapshot.runtime.two, recording }
          views[1].update(React.createElement(InstanceWorkspace, props(1)))
        })
        const indicator = views[1].root.findByProps({ role: 'status', 'aria-live': 'polite', 'aria-atomic': 'true' })
        assert.equal(text(indicator), recording ? '正在录音' : '未录音')
        assert.equal(indicator.props.className.includes('is-recording'), recording)
      }
    }
    act(() => {
      instances[1] = { ...instances[1], kind: 'xboxBluetooth' }
      views[1].update(React.createElement(InstanceWorkspace, props(1)))
    })
    assert.equal(views[1].root.findAllByProps({ 'aria-atomic': 'true' }).length, 0)
    act(() => views[0].update(React.createElement(InstanceWorkspace, {
      ...props(0), platform: 'macos', permissions: { accessibility: true, inputMonitoring: true },
    })))
    assert.equal(views[0].root.findAllByProps({ className: 'settings-form-row managed-driver-status-row' }).length, 0)
    assert.equal(views[0].root.findByType('select').props.value, 'click')
    await act(async () => views[0].root.findByType('select').props.onChange({ target: { value: 'hold' } }))
    assert.equal(instances[0].cmiotA15RecordingMode, 'hold')
    act(() => views[0].root.findByProps({ className: 'managed-audio-calibration' }).props.onClick())

    for (const kind of ['rc003', 'cmiotA15']) {
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
      assert.equal((text(panel()).match(/未绑定设备/g) ?? []).length, 8)
      assert.ok(!text(panel()).includes('REMOTE_NATIVE'))
      assert.equal(refreshButton().props.disabled, true)
    }
    assert.deepEqual(actions.at(-1), ['calibrate', 'one'])
  } finally { act(() => views.forEach(view => view.unmount())) }
})
