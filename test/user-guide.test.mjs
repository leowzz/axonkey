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
  const module = { exports: {} }
  vm.runInNewContext(ts.transpileModule(readFileSync(path, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020, jsx: ts.JsxEmit.ReactJSX },
  }).outputText, {
    module, exports: module.exports, document: { activeElement: null }, HTMLElement: class {},
    require: name => imports[name] ?? (name.endsWith('.css') ? {} : require(name)),
  })
  return module.exports
}
const { UserGuideDialog } = compile('src/components/UserGuideDialog.tsx', {
  '../../src-tauri/icons/128x128@2x.png': { default: 'axonkey-icon.png' },
  './CableDriverDialog': compile('src/components/CableDriverDialog.tsx'),
  '../devices/integration/DeviceHub': { DeviceDiscoverySection: props => React.createElement('device-discovery', props) },
})

async function mount({ enabled = true, completed = false, save = async () => {} } = {}) {
  const calls = []
  const driverCalls = []
  let installed = false, homeVisits = 0, sounds = 0, refreshes = 0
  const { useCableDriver } = compile('src/hooks/useCableDriver.ts', {
    '@tauri-apps/api/core': { invoke: async (command, args) => {
      driverCalls.push([command, args])
      if (command === 'probe_cable_driver') return installed
      installed = args.action === 'install'
      return { rebootRequired: true, logPath: 'C:/logs/cable.log' }
    } },
  })
  const { useUserGuide } = compile('src/hooks/useUserGuide.ts', {
    '@tauri-apps/api/core': { invoke: async command => {
      calls.push(command)
      return command === 'get_onboarding_completed' ? completed : save()
    } },
  })
  let guide, view
  function App() {
    guide = useUserGuide(enabled, true)
    const cableDriver = useCableDriver(true)
    return guide.open ? React.createElement(UserGuideDialog, {
      saving: guide.saving, error: guide.error, cableDriver, nativeRuntime: true,
      deviceDiscovery: { controller: { refresh: async () => refreshes++ } },
      onOpenSound: () => sounds++,
      onComplete: async () => { if (await guide.complete()) homeVisits++ },
    }) : null
  }
  await act(async () => { view = Renderer.create(React.createElement(App), {
    createNodeMock: node => node.type === 'dialog' ? { showModal() {}, close() {} } : null,
  }) })
  return { view, calls, driverCalls, get guide() { return guide },
    get homeVisits() { return homeVisits }, get sounds() { return sounds },
    get refreshes() { return refreshes },
    button: label => view.root.findAllByType('button').find(button => text(button) === label),
  }
}

for (const action of ['完成', '跳过指南']) {
  test(`${action} persists completion before closing, and manual reopening remains available`, async () => {
    let resolveSave
    const h = await mount({ save: () => new Promise(resolve => { resolveSave = resolve }) })
    try {
      assert.equal(h.guide.open, true)
      if (action === '完成') {
        await act(async () => h.button('继续').props.onClick())
        await act(async () => h.button('继续').props.onClick())
        await act(async () => h.button('继续').props.onClick())
      }
      let pending
      act(() => { pending = h.button(action).props.onClick() })
      assert.equal(h.guide.open, true)
      assert.ok(h.view.root.findAllByType('button').every(button => button.props.disabled))
      await act(async () => { resolveSave(); await pending })
      assert.equal(h.guide.open, false)
      assert.equal(h.homeVisits, 1)
      assert.deepEqual(h.calls, ['get_onboarding_completed', 'complete_onboarding'])
      act(() => h.guide.show())
      assert.equal(h.guide.open, true)
      assert.match(text(h.view.toJSON()), /欢迎使用 Axonkey/)
    } finally { act(() => h.view.unmount()) }
  })
}

test('completed users do not auto-open; disabled platforms do not read config', async () => {
  for (const enabled of [true, false]) {
    const h = await mount({ enabled, completed: true })
    try {
      assert.equal(h.guide.open, false)
      assert.deepEqual(h.calls, enabled ? ['get_onboarding_completed'] : [])
      act(() => h.guide.show())
      assert.equal(h.guide.open, enabled)
    } finally { act(() => h.view.unmount()) }
  }
})

test('failed saving stays open with a retryable error; Escape cannot bypass completion', async () => {
  let fail = true
  const h = await mount({ save: async () => { if (fail) throw new Error('disk full') } })
  try {
    let prevented = false
    act(() => h.view.root.findByType('dialog').props.onCancel({ preventDefault() { prevented = true } }))
    assert.equal(prevented, true)
    await act(async () => h.button('继续').props.onClick())
    await act(async () => h.button('继续').props.onClick())
    await act(async () => h.button('继续').props.onClick())
    await act(async () => h.button('完成').props.onClick())
    assert.equal(h.guide.open, true)
    assert.equal(h.homeVisits, 0)
    assert.match(text(h.view.root.findByProps({ role: 'alert' })), /disk full/)
    assert.equal(h.button('完成').props.disabled, false)
    fail = false
    await act(async () => h.button('完成').props.onClick())
    assert.equal(h.guide.open, false)
    assert.equal(h.homeVisits, 1)
  } finally { act(() => h.view.unmount()) }
})

test('welcome, optional driver setup and final page share the actual driver controls', async () => {
  const h = await mount()
  try {
    assert.equal(h.view.root.findByType('img').props.alt, 'Axonkey 应用图标')
    assert.match(text(h.view.toJSON()), /无线麦克风/)
    assert.equal(h.button('完成'), undefined)
    assert.equal(h.driverCalls.length, 0)
    await act(async () => h.button('继续').props.onClick())
    assert.match(text(h.view.toJSON()), /推荐安装虚拟声卡驱动/)
    assert.match(text(h.view.toJSON()), /VB-CABLE Virtual Audio Device/)
    assert.match(text(h.view.toJSON()), /未安装/)
    assert.equal(h.driverCalls[0][0], 'probe_cable_driver')
    await act(async () => h.button('继续').props.onClick())
    assert.match(text(h.view.toJSON()), /选择一个你想要添加的设备/)
    assert.equal(h.refreshes, 1)
    await act(async () => h.button('继续').props.onClick())
    assert.match(text(h.view.toJSON()), /完成，可以开始了/)
    assert.deepEqual(h.calls, ['get_onboarding_completed'], 'continuing without a driver does not complete the guide')
    act(() => h.button('上一步').props.onClick())
    assert.match(text(h.view.toJSON()), /选择一个你想要添加的设备/)
    act(() => h.button('上一步').props.onClick())
    await act(async () => h.button('安装驱动').props.onClick())
    assert.match(text(h.view.toJSON()), /请重启 Windows/)
    assert.match(text(h.view.toJSON()), /cable\.log/)
    act(() => h.button('声音设置').props.onClick())
    assert.equal(h.sounds, 1)
    await act(async () => h.button('重新检测').props.onClick())
    assert.match(text(h.view.toJSON()), /已安装/)
    await act(async () => h.button('卸载驱动').props.onClick())
    assert.deepEqual(h.driverCalls.filter(([name]) => name === 'launch_driver_action').map(([, args]) => args.action), ['install', 'uninstall'])
    await act(async () => h.button('跳过指南').props.onClick())
    assert.equal(h.guide.open, false)
    assert.equal(h.homeVisits, 1)
  } finally { act(() => h.view.unmount()) }
})

test('adding a device advances to the fourth page without marking the guide complete', async () => {
  const h = await mount()
  try {
    await act(async () => h.button('继续').props.onClick())
    await act(async () => h.button('继续').props.onClick())
    act(() => h.view.root.findByType('device-discovery').props.onIntegrated('saved-device'))
    assert.match(text(h.view.toJSON()), /完成，可以开始了/)
    assert.deepEqual(h.calls, ['get_onboarding_completed'])
    assert.equal(h.homeVisits, 0)
  } finally { act(() => h.view.unmount()) }
})

test('only Windows settings exposes the guide entry and opens it', () => {
  const { SettingsPage } = compile('src/components/SettingsPage.tsx', {
    './SettingsHelp': { SettingsHelp: () => null },
    './DataBackupSettings': { DataBackupSettings: () => null },
    './AutostartControl': { AutostartControl: () => null },
  })
  for (const platform of ['windows', 'macos', 'unsupported']) {
    let view, opened = 0
    act(() => { view = Renderer.create(React.createElement(SettingsPage, {
      platform, nativeRuntime: true, section: 'permissions', permissions: {}, inputDriver: {},
      audioDriver: { status: 'installed', action: { status: 'idle' } }, backup: {},
      onOpenUserGuide: () => opened++,
    })) })
    try {
      const buttons = view.root.findAllByType('button').filter(button => text(button) === '打开指南')
      assert.equal(buttons.length, platform === 'windows' ? 1 : 0)
      if (buttons.length) {
        act(() => buttons[0].props.onClick())
        assert.equal(opened, 1)
      }
    } finally { act(() => view.unmount()) }
  }
})
