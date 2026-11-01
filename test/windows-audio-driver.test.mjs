import assert from 'node:assert/strict'
import test from 'node:test'
import { existsSync, readFileSync } from 'node:fs'
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
  }).outputText, { module, exports: module.exports, document: { activeElement: null }, HTMLElement: class {}, require: name => imports[name] ?? (name.endsWith('.css') ? {} : require(name)) })
  return module.exports
}
const { WindowsAudioDriverDialog } = compile('src/components/WindowsAudioDriverDialog.tsx')

function mount(nativeRuntime, invoke) {
  const { useWindowsAudioDriver } = compile('src/hooks/useWindowsAudioDriver.ts', { '@tauri-apps/api/core': { invoke } })
  let controller
  let closed = 0
  let sounds = 0
  const modal = { opened: 0, closed: 0, showModal() { this.opened++ }, close() { this.closed++ } }
  function App({ open = true }) {
    controller = useWindowsAudioDriver(nativeRuntime)
    return open ? React.createElement(WindowsAudioDriverDialog, { controller, nativeRuntime, onClose: () => closed++, onOpenSound: () => sounds++ }) : null
  }
  let view
  act(() => { view = Renderer.create(React.createElement(App), { createNodeMock: node => node.type === 'dialog' ? modal : null }) })
  return { view, modal, get controller() { return controller }, get closed() { return closed }, get sounds() { return sounds },
    button: label => view.root.findAllByType('button').find(button => text(button) === label),
    show: open => act(() => view.update(React.createElement(App, { open }))),
  }
}

test('Quarbor panel uses reported driver state and preserves installer results across closing', async () => {
  const calls = []
  let installed = false
  const h = mount(true, async (command, args) => {
    calls.push([command, args])
    if (command === 'probe_windows_audio_driver') return installed
    installed = args.action === 'install'
    return { rebootRequired: true, logPath: 'C:/logs/quarbor-vmic.log', driverInstalled: installed }
  })
  try {
    assert.equal(h.modal.opened, 1)
    assert.equal(h.button('安装驱动').props.disabled, true, 'unknown state cannot select an installation action')
    await act(async () => { await h.controller.probe() })
    assert.equal(h.button('安装驱动').props.disabled, false)
    await act(async () => { h.button('安装驱动').props.onClick() })
    assert.equal(h.controller.installed, true)
    assert.match(text(h.view.toJSON()), /请重启 Windows/)
    assert.match(text(h.view.toJSON()), /quarbor-vmic\.log/)
    assert.equal(h.button('卸载驱动').props.disabled, false)
    h.show(false)
    h.show(true)
    assert.match(text(h.view.toJSON()), /请重启 Windows/)
    await act(async () => { h.button('重新检测').props.onClick() })
    assert.match(text(h.view.toJSON()), /请重启 Windows/, 'checking cannot dismiss a pending reboot')
    await act(async () => { h.button('卸载驱动').props.onClick() })
    assert.equal(h.controller.installed, false)
    assert.deepEqual(calls.filter(([command]) => command === 'launch_driver_action').map(([, args]) => ({ ...args })), [
      { driver: 'audio', action: 'install' }, { driver: 'audio', action: 'uninstall' },
    ])
    act(() => h.button('声音设置').props.onClick())
    assert.equal(h.sounds, 1)
    act(() => h.view.root.findByType('dialog').props.onCancel())
    assert.equal(h.closed, 1)
  } finally { act(() => h.view.unmount()) }
})

test('busy actions block duplicates, failures are visible and retryable, and previews cannot invoke native code', async () => {
  let rejectInstall
  const calls = []
  const h = mount(true, (command, args) => {
    calls.push([command, args])
    if (command === 'probe_windows_audio_driver') return Promise.resolve(false)
    return new Promise((_, reject) => { rejectInstall = reject })
  })
  try {
    await act(async () => { await h.controller.probe() })
    let pending
    act(() => { pending = h.controller.run('install') })
    assert.equal(h.button('安装驱动').props.disabled, true)
    assert.equal(h.button('重新检测').props.disabled, true)
    await act(async () => { await h.controller.run('install'); await h.controller.probe() })
    assert.equal(calls.length, 2)
    h.show(false)
    await act(async () => { rejectInstall(new Error('授权取消')); await pending })
    h.show(true)
    assert.match(text(h.view.root.findByProps({ role: 'alert' })), /授权取消/)
    assert.equal(h.button('安装驱动').props.disabled, false)
  } finally { act(() => h.view.unmount()) }

  const preview = mount(false, () => { throw new Error('must not invoke') })
  try {
    await act(async () => { await preview.controller.probe(); await preview.controller.run('install') })
    for (const label of ['安装驱动', '重新检测', '声音设置']) assert.equal(preview.button(label).props.disabled, true)
    assert.match(text(preview.view.toJSON()), /浏览器预览/)
  } finally { act(() => preview.view.unmount()) }
})

test('Windows permissions settings exposes the Quarbor audio panel entry', () => {
  const { SettingsPage } = compile('src/components/SettingsPage.tsx', {
    './SettingsHelp': { SettingsHelp: () => null },
    './DataBackupSettings': { DataBackupSettings: () => null },
    './AutostartControl': { AutostartControl: () => null },
  })
  let opened = 0, cleanupOpened = 0
  let view
  act(() => { view = Renderer.create(React.createElement(SettingsPage, {
    platform: 'windows', nativeRuntime: true, section: 'permissions', permissions: {},
    inputDriver: {}, audioDriver: { status: 'installed', action: { status: 'idle' } },
    backup: {}, onOpenWindowsAudioDriver: () => opened++, onOpenManagedDriverCleanup: () => cleanupOpened++,
  })) })
  try {
    const row = view.root.findByProps({ 'aria-labelledby': 'settings-windows-audio-label' })
    assert.equal(row.findAllByType('button').length, 1)
    assert.equal(text(row.findByType('button')), '管理 Quarbor 驱动')
    act(() => row.findByType('button').props.onClick())
    assert.equal(opened, 1)
    const cleanup = view.root.findByProps({ 'aria-labelledby': 'settings-quarbor-cleanup-label' })
    assert.equal(text(cleanup.findByType('button')), '卸载已绑定设备驱动')
    act(() => cleanup.findByType('button').props.onClick())
    assert.equal(cleanupOpened, 1)
    assert.equal(opened, 1)
  } finally { act(() => view.unmount()) }
})

test('virtual audio upgrade settings entry is Windows debug-only and previews cannot start it', () => {
  const { SettingsPage } = compile('src/components/SettingsPage.tsx', {
    './SettingsHelp': { SettingsHelp: () => null },
    './DataBackupSettings': { DataBackupSettings: () => null },
    './AutostartControl': { AutostartControl: () => null },
  })
  let opened = 0, view
  const render = (debugMode, nativeRuntime = true, platform = 'windows') => {
    const element = React.createElement(SettingsPage, {
      platform, nativeRuntime, debugMode, section: 'permissions', permissions: {},
      inputDriver: {}, audioDriver: { status: 'installed', action: { status: 'idle' } }, backup: {},
      onOpenVirtualAudioUpgrade: () => opened++,
    })
    act(() => { if (view) view.update(element); else view = Renderer.create(element) })
    return view.root.findAllByProps({ 'aria-labelledby': 'settings-virtual-audio-upgrade-label' })
  }
  try {
    assert.equal(render(false).length, 0)
    const [row] = render(true)
    assert.equal(row.findByType('button').props.disabled, false)
    act(() => row.findByType('button').props.onClick())
    assert.equal(opened, 1)
    assert.equal(render(false).length, 0)
    assert.equal(render(true, false)[0].findByType('button').props.disabled, true)
    assert.equal(render(true, true, 'macos').length, 0)
  } finally { act(() => view.unmount()) }
})

test('driver actions preserve reboot and unknown states instead of inferring them from the requested action', async () => {
  let result = { rebootRequired: false, logPath: 'vmic-install.log', driverInstalled: true }
  const h = mount(true, async command => command === 'probe_windows_audio_driver' ? false : result)
  try {
    await act(async () => { await h.controller.probe(); await h.controller.run('install') })
    assert.equal(h.controller.installed, true)
    assert.equal(h.controller.rebootRequired, false)
    assert.match(text(h.view.toJSON()), /安装已完成/)
    assert.doesNotMatch(text(h.view.toJSON()), /请重启 Windows/)

    result = { rebootRequired: true, logPath: 'vmic-remove.log', driverInstalled: true }
    await act(async () => h.controller.run('uninstall'))
    assert.equal(h.controller.installed, true, 'a pending removal may still report the device')
    assert.match(text(h.view.toJSON()), /卸载已提交/)
    assert.match(text(h.view.toJSON()), /请重启 Windows/)

    result = { rebootRequired: false, logPath: 'vmic-install.log', warning: '无法确认驱动状态：设备枚举失败' }
    await act(async () => h.controller.run('install'))
    assert.equal(h.controller.installed, null)
    assert.match(text(h.view.toJSON()), /安装已完成/)
    assert.match(text(h.view.root.findByProps({ role: 'alert' })), /设备枚举失败/)
    assert.equal(h.button('安装驱动').props.disabled, true)
    await act(async () => h.controller.probe())
    assert.equal(h.controller.warning, '')
    assert.equal(h.controller.installed, false)
    assert.equal(h.button('安装驱动').props.disabled, false)
  } finally { act(() => h.view.unmount()) }
})

test('failed or incomplete operations recheck actual state and failed checks keep actions disabled', async () => {
  let installed = true, statusFails = false
  const h = mount(true, async command => {
    if (command === 'probe_windows_audio_driver') {
      if (statusFails) throw new Error('无法枚举设备')
      return installed
    }
    installed = false
    throw new Error('操作未完成（299）：驱动包尚未移除。日志：vmic-remove.log')
  })
  try {
    await act(async () => h.controller.probe())
    await act(async () => h.controller.run('uninstall'))
    assert.equal(h.controller.installed, false, 'a partial removal can remove the device before failing')
    assert.match(text(h.view.root.findByProps({ role: 'alert' })), /299.*驱动包尚未移除/)
    statusFails = true
    await act(async () => h.controller.probe())
    assert.equal(h.controller.installed, null)
    assert.equal(h.button('安装驱动').props.disabled, true)
    assert.match(text(h.view.toJSON()), /状态未知/)
  } finally { act(() => h.view.unmount()) }
})

test('Windows bundle ships the complete Quarbor microphone package in one directory', () => {
  const config = JSON.parse(readFileSync('src-tauri/tauri.windows.conf.json', 'utf8'))
  const directory = 'vendor/QuarborVirtualMicrophoneDriverInstaller'
  const names = [
    'QuarborVirtualMicrophoneDriverInstaller.exe', 'QuarborVirtualMicrophoneDriver.inf',
    'QuarborVirtualMicrophoneDriver.sys', 'QuarborVirtualMicrophoneDriver.cat', 'License',
  ]
  const resources = config.bundle.resources
  for (const name of names) {
    assert.equal(resources[`../${directory}/${name}`], `${directory}/${name}`)
    assert.equal(existsSync(`${directory}/${name}`), true, `missing bundled resource: ${name}`)
  }
  assert.equal(Object.keys(resources).some(path => /vbcable|vb-cable/i.test(path)), false)
})
