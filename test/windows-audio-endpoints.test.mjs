import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import vm from 'node:vm'
import ts from 'typescript'
import React from 'react'
import Renderer, { act } from 'react-test-renderer'
import * as model from '../src/windowsAudioEndpoints.ts'
import * as audioGain from '../src/audioGain.ts'

const require = createRequire(import.meta.url)
const endpoint = (id, direction = 'render', adapterId = 'adapter-a', extra = {}) => ({
  id, direction, adapterId, name: '扬声器', state: 'active', hardwareIds: ['VBAudioVACWDM'], service: 'VBAudioVACMME', channels: 2, ...extra,
})
const endpoints = [endpoint('render-a'), endpoint('render-b', 'render', 'adapter-b', { channels: 16 }), endpoint('capture-a', 'capture'), endpoint('capture-b', 'capture', 'adapter-b')]
const output = (state = 'selectionRequired', id = null) => ({ state, selectedEndpointId: id, selectedEndpointName: id ? `改名后的 ${id}` : null, captureEndpointId: id ? id.replace('render', 'capture') : null, captureEndpointName: id ? '麦克风中文名' : null, error: null })
const probe = (value) => ({ driverInstalled: true, state: 'ready', bluetoothConnected: true, forwarding: false, output: value })
const text = (node) => typeof node === 'string' ? node : (node?.children ?? []).map(text).join('')

function load(file, mocks = {}, globals = {}) {
  const module = { exports: {} }
  vm.runInNewContext(ts.transpileModule(readFileSync(file, 'utf8'), { compilerOptions: {
    module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020, jsx: ts.JsxEmit.ReactJSX,
  } }).outputText, {
    module, exports: module.exports,
    require: name => name === '../windowsAudioEndpoints' ? model : name in mocks ? mocks[name] : require(name),
    ...globals,
  })
  return module.exports
}

async function setup({ supported = true, bound = false, candidates = endpoints } = {}) {
  let snapshot = { endpoints: candidates, binding: bound ? { schemaVersion: 1, renderEndpointId: 'render-a', captureEndpointId: 'capture-a', adapterInstanceId: 'adapter-a' } : null, output: output(bound ? 'ready' : 'selectionRequired', bound ? 'render-a' : null), error: null }
  const calls = [], probes = [], outputs = []
  let failWrite = false, failClear = false, failRead = false, holdWrite = null, readAfterSaveFailure = false
  const { WindowsAudioEndpointControl } = load('src/components/WindowsAudioEndpointControl.tsx', {
    './SettingsHelp': { SettingsHelp: () => null },
    '@tauri-apps/api/core': { invoke: async (command, args) => {
      calls.push([command, args])
      if (command === 'get_windows_audio_endpoints') {
        if (failRead) throw new Error('读取失败')
        return structuredClone(snapshot)
      }
      if (command === 'set_windows_audio_endpoint') {
        if (holdWrite) await holdWrite
        if (failWrite) { snapshot.output = { ...snapshot.output, state: 'openFailed', error: '旧播放流恢复失败' }; throw new Error('打开设备失败') }
        snapshot = { ...snapshot, binding: { schemaVersion: 1, ...args, adapterInstanceId: 'adapter-b' }, output: output('ready', args.renderEndpointId) }
        if (readAfterSaveFailure) failRead = true
        return probe(snapshot.output)
      }
      if (command === 'clear_windows_audio_endpoint') {
        if (failClear) throw new Error('保存配置失败')
        snapshot = { ...snapshot, binding: null, output: output() }
        return probe(snapshot.output)
      }
      throw new Error(`Unexpected command: ${command}`)
    } },
  })
  let renderer
  await act(async () => { renderer = Renderer.create(React.createElement(WindowsAudioEndpointControl, { supported, driverBusy: false, onProbeChange: value => probes.push(value), onOutputChange: value => outputs.push(value), onInstall() {}, onOpenSound() {} })) })
  return {
    calls, probes, outputs,
    get root() { return renderer.root },
    get current() { return text(renderer.root.findByProps({ role: 'status' })) },
    get alerts() { return renderer.root.findAllByProps({ role: 'alert' }).map(text) },
    get render() { return renderer.root.findByProps({ id: 'windows-audio-render' }) },
    get capture() { return renderer.root.findByProps({ id: 'windows-audio-capture' }) },
    button(label) { return renderer.root.findAllByType('button').find(button => text(button) === label) },
    async choose(id) { await act(async () => this.render.props.onChange({ target: { value: id } })) },
    async chooseCapture(id) { await act(async () => this.capture.props.onChange({ target: { value: id } })) },
    async click(label) { await act(async () => this.button(label).props.onClick()) },
    async close() { await act(async () => renderer.unmount()) },
    set failWrite(value) { failWrite = value },
    set failClear(value) { failClear = value },
    set failRead(value) { failRead = value },
    set holdWrite(value) { holdWrite = value },
    set readAfterSaveFailure(value) { readAfterSaveFailure = value },
  }
}

test('explicit ID selection includes renamed/same-name and 16-channel endpoints without picking the first candidate', async () => {
  const app = await setup()
  try {
    assert.equal(app.render.props.value, '')
    assert.equal(app.button('保存并应用').props.disabled, true)
    const options = app.render.findAllByType('option')
    assert.ok(options.some(option => option.props.value === 'render-a' && text(option).includes('render-a')))
    assert.ok(options.some(option => option.props.value === 'render-b' && text(option).includes('render-b')))
    await app.choose('render-b')
    assert.equal(app.capture.props.value, 'capture-b')
    assert.equal(app.capture.findAllByType('option').some(option => option.props.value === 'capture-a'), false)
    assert.equal(app.current.includes('改名后的 render-b'), false, 'draft must not become active output')
    await app.click('保存并应用')
    const request = app.calls.find(([command]) => command === 'set_windows_audio_endpoint')
    assert.equal(request[1].renderEndpointId, 'render-b')
    assert.equal(request[1].captureEndpointId, 'capture-b')
    assert.equal(app.probes.length, 1)
    assert.ok(app.current.includes('改名后的 render-b'))
    assert.ok(app.current.includes('已保存并生效'))
  } finally { await app.close() }
})

test('multiple capture endpoints require a choice; inactive endpoints stay visible and cannot be applied', async () => {
  const app = await setup({ candidates: [...endpoints, endpoint('capture-a2', 'capture'), endpoint('disabled', 'render', 'adapter-z', { state: 'disabled' })] })
  try {
    await app.choose('render-a')
    assert.equal(app.capture.props.value, '')
    assert.equal(app.button('保存并应用').props.disabled, true)
    await app.chooseCapture('capture-a2')
    assert.equal(app.button('保存并应用').props.disabled, false)
    assert.equal(app.render.findByProps({ value: 'disabled' }).props.disabled, true)
    await app.choose('disabled')
    assert.equal(app.button('保存并应用').props.disabled, true)
  } finally { await app.close() }
})

test('failed switching retains the draft, reports failure and refreshes actual stream state', async () => {
  const app = await setup({ bound: true })
  try {
    await app.choose('render-b')
    app.failWrite = true
    await app.click('保存并应用')
    assert.equal(app.render.props.value, 'render-b')
    assert.equal(app.probes.length, 0)
    assert.ok(app.alerts.some(value => value.includes('打开设备失败')))
    assert.ok(app.current.includes('旧播放流恢复失败'))
    assert.equal(app.current.includes('已保存并生效'), false)
    assert.equal(app.button('保存并应用').props.disabled, false)
    app.failWrite = false
    await app.click('保存并应用')
    assert.equal(app.alerts.length, 0)
    assert.equal(app.probes.at(-1).output.selectedEndpointId, 'render-b')
  } finally { await app.close() }
})

test('clearing binding succeeds explicitly; failed clear retains binding and other choices', async () => {
  const app = await setup({ bound: true })
  try {
    app.failClear = true
    await app.click('清除绑定')
    assert.equal(app.render.props.value, 'render-a')
    assert.equal(app.probes.length, 0)
    assert.ok(app.alerts.some(value => value.includes('清除失败')))
    app.failClear = false
    await app.click('清除绑定')
    assert.equal(app.render.props.value, '')
    assert.equal(app.capture.props.value, '')
    assert.equal(app.probes.at(-1).output.state, 'selectionRequired')
    assert.equal(app.button('清除绑定').props.disabled, true)
    assert.ok(app.current.includes('不会切换到其他设备'))
  } finally { await app.close() }
})

test('save is pending until native confirmation and repeated actions cannot overlap', async () => {
  const app = await setup({ bound: true })
  try {
    let resolve
    app.holdWrite = new Promise(done => { resolve = done })
    await app.choose('render-b')
    await app.click('保存并应用')
    assert.equal(app.button('保存并应用').props.disabled, true)
    assert.ok(app.current.includes('改名后的 render-a'))
    assert.equal(app.current.includes('已保存并生效'), false)
    await app.click('保存并应用')
    assert.equal(app.calls.filter(([command]) => command === 'set_windows_audio_endpoint').length, 1)
    await act(async () => resolve())
    assert.ok(app.current.includes('改名后的 render-b'))
  } finally { await app.close() }
})

test('a refresh failure after saving does not claim the confirmed operation failed', async () => {
  const app = await setup()
  try {
    app.readAfterSaveFailure = true
    await app.choose('render-b')
    await app.click('保存并应用')
    assert.equal(app.probes.length, 1)
    assert.ok(app.alerts.some(value => value.includes('操作已完成，但设备列表刷新失败')))
    assert.ok(app.current.includes('已保存并生效'))
    assert.ok(app.current.includes('改名后的 render-b'))
  } finally { await app.close() }
})

test('preview cannot invoke native discovery or changes', async () => {
  const app = await setup({ supported: false })
  try {
    assert.equal(app.render.props.disabled, true)
    assert.equal(app.button('保存并应用').props.disabled, true)
    assert.equal(app.calls.length, 0)
    assert.ok(app.current.includes('Windows 桌面版'))
  } finally { await app.close() }
})

test('Windows output errors never imply missing driver; readiness needs the actual output and voice connection', () => {
  const expected = { selectionRequired: '需要选择设备', adapterMissing: '未发现设备', enumerationFailed: '检测失败', endpointDisabled: '设备已禁用', endpointUnavailable: '设备不可用', unsupportedFormat: '格式不支持', openFailed: '打开失败', configError: '配置失败', switching: '正在切换' }
  for (const [state, label] of Object.entries(expected)) {
    const current = probe(output(state, 'render-a'))
    const presentation = model.windowsAudioPresentation(current)
    assert.equal(presentation.label, label)
    assert.equal(presentation.detail.includes('未安装'), false)
    assert.notEqual(presentation.tone, 'ready')
    assert.equal(model.audioTestReady('windows', current), false)
  }
  const ready = probe(output('ready', 'render-a'))
  assert.equal(model.audioTestReady('windows', ready), true)
  assert.equal(model.audioTestReady('windows', { ...ready, bluetoothConnected: false }), false)
  assert.equal(model.audioTestReady('windows', { ...ready, output: undefined }), false)
  assert.equal(model.audioTestReady('macos', { ...ready, output: undefined }), true)
  assert.equal(model.windowsAudioPresentation({ ...ready, bluetoothConnected: false }).label, '等待遥控器')
  assert.equal(model.windowsAudioPresentation({ ...ready, error: 'GATT error' }).tone, 'error')
  assert.ok(model.windowsAudioPresentation(ready).detail.includes('改名后的 render-a'))
})

test('empty, missing and unknown native output states remain actionable and never report readiness', () => {
  for (const state of ['', undefined, null, 'futureState', 'toString']) {
    for (const error of [null, '底层状态尚未初始化']) {
      const current = probe({ ...output('ready', 'render-a'), state, error })
      const presentation = model.windowsAudioPresentation(current)
      assert.equal(presentation.label, '状态未知')
      assert.equal(presentation.tone, 'warning')
      assert.ok(presentation.detail.includes('重新检测'))
      assert.equal(presentation.detail.includes('未安装'), false)
      if (error) assert.ok(presentation.detail.includes(error))
      assert.equal(model.audioTestReady('windows', current), false)
    }
  }
})

test('Windows homepage reports output failure even with a present adapter and opens the selection settings', () => {
  const { HomeDashboard } = load('src/components/HomeDashboard.tsx', {
    '../openGitHub': { openGitHub() {} },
    './BatteryIndicator': { BatteryIndicator: () => null, BatteryDebugControls: () => null },
  })
  let opened = 0
  const props = { platform: 'windows', nativeRuntime: true, systemProbeState: 'ready', permissions: {}, inputDriver: { status: 'installed' }, audioDriver: { status: 'installed' }, device: { status: 'connected' }, enabled: true, audioProbe: probe(output('openFailed', 'render-a')), onOpenPermissions: () => opened++ }
  const renderer = Renderer.create(React.createElement(HomeDashboard, props))
  try {
    assert.equal(text(renderer.root.findByProps({ id: 'home-device-title' })), '完成设置即可使用')
    assert.ok(text(renderer.toJSON()).includes('打开失败'))
    renderer.root.findByProps({ className: 'home-secondary-action' }).props.onClick()
    assert.equal(opened, 1)
    renderer.update(React.createElement(HomeDashboard, { ...props, audioProbe: probe(output('ready', 'render-a')) }))
    assert.equal(text(renderer.root.findByProps({ id: 'home-device-title' })), 'RC003 已就绪')
    assert.ok(text(renderer.toJSON()).includes('改名后的 render-a'))
  } finally { renderer.unmount() }
})

test('calibration preserves macOS forwarding-based reception and uses Windows receivedData independently', async () => {
  for (const [platform, forwarding, receivedData, expected] of [
    ['macos', true, false, '已收到数据'],
    ['macos', false, false, '暂无数据'],
    ['windows', true, false, '暂无数据'],
    ['windows', false, true, '已收到数据'],
  ]) {
    const { AudioTestDialog } = load('src/components/AudioTestDialog.tsx', {
      '../appConfig': { audioGainMin: -30, audioGainMax: 30 },
      '../audioGain': audioGain,
      '@tauri-apps/api/core': { invoke: async () => [{ ...probe(output('ready', 'render-a')), forwarding, receivedData }, { peak: 0.1, rms: 0.02 }] },
    }, { window: { setTimeout: () => 1, clearTimeout() {} } })
    let renderer
    await act(async () => { renderer = Renderer.create(React.createElement(AudioTestDialog, { platform, nativeRuntime: true, audioGain: 0, gainError: '', onAudioGainChange() {}, onClose() {} }), { createNodeMock: element => element.type === 'dialog' ? { showModal() {}, close() {} } : null }) })
    try {
      const stage = renderer.root.findByProps({ 'aria-label': '语音通道状态' })
      assert.ok(text(stage).includes(`语音收音：${expected}`), `${platform}: forwarding=${forwarding}, receivedData=${receivedData}`)
    } finally { await act(async () => renderer.unmount()) }
  }
})
