import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import vm from 'node:vm'
import test from 'node:test'
import ts from 'typescript'
import React from 'react'
import Renderer, { act } from 'react-test-renderer'

const require = createRequire(import.meta.url)
const source = ts.transpileModule(readFileSync('src/devices/shared/DeviceWorkspaceHeader.tsx', 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX, esModuleInterop: true },
}).outputText
const module = { exports: {} }
vm.runInNewContext(source, { module, exports: module.exports, require })
const { DeviceWorkspaceHeader, GlobalSettingsButton } = module.exports

const text = node => (typeof node === 'string' ? node : (node.children ?? []).map(text).join(''))

test('workspace topbar quick switcher switches between integrated devices and exposes device actions', () => {
  const actions = []
  let view
  act(() => {
    view = Renderer.create(
      React.createElement(DeviceWorkspaceHeader, {
        deviceName: '客厅遥控器',
        onBackToDevices: () => actions.push('back'),
        onOpenSettings: () => actions.push('device-settings'),
        onOpenAddDevice: () => actions.push('add-device'),
        switcherItems: [
          {
            id: 'rc003-living',
            name: '客厅遥控器',
            statusLabel: '独占拦截中',
            tone: 'ready',
            active: true,
            onSelect: () => actions.push('select:living'),
          },
          {
            id: 'xbox-desk',
            name: 'Xbox 无线控制器',
            statusLabel: '未连接',
            tone: 'muted',
            active: false,
            onSelect: () => actions.push('select:xbox'),
          },
          {
            id: 'system-mouse',
            name: '系统鼠标',
            statusLabel: '系统输入源',
            tone: 'ready',
            active: false,
            onSelect: () => actions.push('select:mouse'),
          },
        ],
        statusControls: React.createElement('span', { 'aria-label': '设备状态' }, '拦截中'),
        profileControls: React.createElement('button', { type: 'button' }, '默认配置'),
        globalControls: React.createElement(GlobalSettingsButton, {
          active: false,
          hasUpdate: false,
          onClick: () => actions.push('global-settings'),
        }),
      }),
    )
  })
  try {
    const trigger = () => view.root.findByProps({ 'aria-label': '切换设备，当前为客厅遥控器' })
    assert.equal(trigger().props['aria-expanded'], false)
    act(() => trigger().props.onClick())
    assert.equal(trigger().props['aria-expanded'], true)
    const menu = view.root.findByProps({ role: 'menu' })
    assert.match(text(menu), /客厅遥控器.*Xbox 无线控制器.*系统鼠标.*当前设备设置与信息.*添加设备/)

    // Clicking the already active device closes the menu without firing a redundant switch.
    act(() => menu.findAllByProps({ role: 'menuitemradio' })[0].props.onClick())
    assert.deepEqual(actions, [])
    assert.equal(trigger().props['aria-expanded'], false)

    // Selecting another device fires its switch callback and closes the menu.
    act(() => trigger().props.onClick())
    act(() => view.root.findAllByProps({ role: 'menuitemradio' })[2].props.onClick())
    assert.deepEqual(actions, ['select:mouse'])

    // Quick device settings and add-device actions inside the menu work independently.
    act(() => trigger().props.onClick())
    act(() =>
      view.root
        .findAllByProps({ role: 'menuitem' })
        .find(item => text(item).includes('当前设备设置与信息'))
        .props.onClick(),
    )
    act(() => trigger().props.onClick())
    act(() =>
      view.root
        .findAllByProps({ role: 'menuitem' })
        .find(item => text(item).includes('添加设备'))
        .props.onClick(),
    )
    act(() => view.root.findByProps({ className: 'device-workspace-settings' }).props.onClick())
    act(() => view.root.findByProps({ 'aria-label': '全局设置' }).props.onClick())
    assert.deepEqual(actions, ['select:mouse', 'device-settings', 'add-device', 'device-settings', 'global-settings'])
  } finally {
    act(() => view.unmount())
  }
})

test('global settings button exposes available updates visually and in its accessible name', () => {
  let clicks = 0
  const renderer = Renderer.create(
    React.createElement(GlobalSettingsButton, { active: false, hasUpdate: false, onClick: () => clicks++ }),
  )
  const dots = () => renderer.root.findAllByProps({ className: 'topbar-update-dot' })
  try {
    assert.equal(dots().length, 0)
    assert.equal(renderer.root.findByProps({ 'aria-label': '全局设置' }).props.title, '全局设置')
    renderer.update(
      React.createElement(GlobalSettingsButton, { active: true, hasUpdate: true, onClick: () => clicks++ }),
    )
    assert.equal(dots().length, 1)
    const button = renderer.root.findByProps({ 'aria-label': '全局设置，有新版本可用' })
    assert.equal(button.props.title, '全局设置 · 发现新版本')
    assert.equal(button.props['aria-expanded'], true)
    button.props.onClick()
    assert.equal(clicks, 1)
  } finally {
    renderer.unmount()
  }
})
