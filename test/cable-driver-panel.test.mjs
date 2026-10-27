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
  }).outputText, { module, exports: module.exports, document: { activeElement: null }, HTMLElement: class {}, require: name => imports[name] ?? (name.endsWith('.css') ? {} : require(name)) })
  return module.exports
}
const { CableDriverDialog } = compile('src/components/CableDriverDialog.tsx')

function mount(nativeRuntime, invoke) {
  const { useCableDriver } = compile('src/hooks/useCableDriver.ts', { '@tauri-apps/api/core': { invoke } })
  let controller
  let closed = 0
  let sounds = 0
  const modal = { opened: 0, closed: 0, showModal() { this.opened++ }, close() { this.closed++ } }
  function App({ open = true }) {
    controller = useCableDriver(nativeRuntime)
    return open ? React.createElement(CableDriverDialog, { controller, nativeRuntime, onClose: () => closed++, onOpenSound: () => sounds++ }) : null
  }
  let view
  act(() => { view = Renderer.create(React.createElement(App), { createNodeMock: node => node.type === 'dialog' ? modal : null }) })
  return { view, modal, get controller() { return controller }, get closed() { return closed }, get sounds() { return sounds },
    button: label => view.root.findAllByType('button').find(button => text(button) === label),
    show: open => act(() => view.update(React.createElement(App, { open }))),
  }
}

test('CABLE panel uses actual driver checks and preserves installer results across closing', async () => {
  const calls = []
  let installed = false
  const h = mount(true, async (command, args) => {
    calls.push([command, args])
    if (command === 'probe_cable_driver') return installed
    installed = args.action === 'install'
    return { rebootRequired: true, logPath: 'C:/logs/cable.log' }
  })
  try {
    assert.equal(h.modal.opened, 1)
    assert.equal(h.button('安装驱动').props.disabled, true, 'unknown state cannot select an installation action')
    await act(async () => { await h.controller.probe() })
    assert.equal(h.button('安装驱动').props.disabled, false)
    await act(async () => { h.button('安装驱动').props.onClick() })
    assert.equal(h.controller.installed, true)
    assert.match(text(h.view.toJSON()), /请重启 Windows/)
    assert.match(text(h.view.toJSON()), /cable\.log/)
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
    if (command === 'probe_cable_driver') return Promise.resolve(false)
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

test('Windows permissions settings exposes only the CABLE panel entry', () => {
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
    backup: {}, onOpenCableDriver: () => opened++, onOpenManagedDriverCleanup: () => cleanupOpened++,
  })) })
  try {
    const row = view.root.findByProps({ 'aria-labelledby': 'settings-windows-audio-label' })
    assert.equal(row.findAllByType('button').length, 1)
    assert.equal(text(row.findByType('button')), '管理 CABLE 驱动')
    act(() => row.findByType('button').props.onClick())
    assert.equal(opened, 1)
    const cleanup = view.root.findByProps({ 'aria-labelledby': 'settings-quarbor-cleanup-label' })
    assert.equal(text(cleanup.findByType('button')), '卸载已绑定设备驱动')
    act(() => cleanup.findByType('button').props.onClick())
    assert.equal(cleanupOpened, 1)
    assert.equal(opened, 1)
  } finally { act(() => view.unmount()) }
})
