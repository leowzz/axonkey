import assert from 'node:assert/strict'
import test from 'node:test'
import React from 'react'
import Renderer, { act } from 'react-test-renderer'
import { AppBottomBar, AppSettingsPanel, text } from './fixtures/home-dashboard.mjs'

const base = {
  activePanel: null,
  nativeRuntime: true,
  hasUpdate: false,
  onOpenDevices() {},
  onReturnToWorkspace() {},
  onOpenSettings() {},
  onOpenCloud() {},
  onOpenLogs() {},
  onOpenAbout() {},
}

test('bottom bar routes workspace and utility actions independently', () => {
  const actions = []
  const renderer = Renderer.create(React.createElement(AppBottomBar, {
    ...base,
    workspaceName: '小米遥控器',
    onOpenDevices: () => actions.push('devices'),
    onReturnToWorkspace: () => actions.push('workspace'),
    onOpenSettings: () => actions.push('settings'),
    onOpenCloud: () => actions.push('cloud'),
    onOpenLogs: () => actions.push('logs'),
    onOpenAbout: () => actions.push('about'),
  }))
  try {
    for (const label of ['设备', '小米遥控器', '设置', '账号与同步', '运行日志', '关于']) {
      renderer.root.findByProps({ 'aria-label': label }).props.onClick()
    }
    assert.deepEqual(actions, ['devices', 'workspace', 'settings', 'cloud', 'logs', 'about'])
  } finally { renderer.unmount() }
})

test('bottom bar selects the current workspace or open panel and shows device status', () => {
  const renderer = Renderer.create(React.createElement(AppBottomBar, base))
  const selectedLabels = () => renderer.root.findAllByType('button')
    .filter(button => button.props['aria-current'] === 'page')
    .map(button => button.props['aria-label'])
  const props = {
    ...base,
    workspaceName: '小米遥控器',
    workspaceStatus: { label: '独占拦截中', tone: 'connected' },
  }
  try {
    assert.deepEqual(selectedLabels(), ['设备'])
    renderer.update(React.createElement(AppBottomBar, props))
    assert.deepEqual(selectedLabels(), ['小米遥控器'])
    assert.match(text(renderer.root.findByProps({ 'aria-label': '设备工作区' })), /独占拦截中/)
    for (const [panel, label] of [['settings', '设置'], ['cloud', '账号与同步'], ['about', '关于']]) {
      renderer.update(React.createElement(AppBottomBar, { ...props, activePanel: panel }))
      assert.deepEqual(selectedLabels(), [label])
      assert.equal(renderer.root.findByProps({ 'aria-label': '小米遥控器' }).props.onClick, props.onReturnToWorkspace)
    }
    renderer.update(React.createElement(AppBottomBar, props))
    assert.deepEqual(selectedLabels(), ['小米遥控器'])
  } finally { renderer.unmount() }
})

test('browser preview disables native logs while keeping settings available', () => {
  let settings = 0, logs = 0
  const props = {
    ...base,
    nativeRuntime: false,
    onOpenSettings: () => settings++,
    onOpenLogs: () => logs++,
  }
  const renderer = Renderer.create(React.createElement(AppBottomBar, props))
  const logButton = () => renderer.root.findByProps({ 'aria-label': '运行日志' })
  try {
    assert.equal(logButton().props.disabled, true)
    assert.equal(logButton().props.title, '请在桌面应用中查看')
    renderer.root.findByProps({ 'aria-label': '设置' }).props.onClick()
    assert.equal(settings, 1)
    assert.equal(logs, 0)
    renderer.update(React.createElement(AppBottomBar, { ...props, nativeRuntime: true }))
    assert.equal(logButton().props.disabled, false)
    assert.equal(logButton().props.title, '打开日志目录')
    logButton().props.onClick()
    assert.equal(logs, 1)
  } finally { renderer.unmount() }
})

test('about exposes an available update visually and in its accessible name', () => {
  const renderer = Renderer.create(React.createElement(AppBottomBar, base))
  const dots = () => renderer.root.findAllByProps({ className: 'app-bottom-bar-update-dot' })
  try {
    assert.equal(dots().length, 0)
    assert.equal(renderer.root.findByProps({ 'aria-label': '关于' }).props.title, '关于')
    renderer.update(React.createElement(AppBottomBar, { ...base, hasUpdate: true }))
    assert.equal(dots().length, 1)
    assert.equal(renderer.root.findByProps({ 'aria-label': '关于，有新版本可用' }).props.title, '关于 · 发现新版本')
    renderer.update(React.createElement(AppBottomBar, base))
    assert.equal(dots().length, 0)
  } finally { renderer.unmount() }
})

test('settings panel uses full-screen workspace header with top-left back button unified with device workspace', () => {
  let closes = 0
  const workspace = { inert: false }
  let renderer
  act(() => {
    renderer = Renderer.create(
      React.createElement(
        AppSettingsPanel,
        { workspaceRef: { current: workspace }, backLabel: '我的设备', onClose: () => closes++ },
        React.createElement('div', null, '设置内容'),
      ),
      { createNodeMock: () => ({ focus() {} }) },
    )
  })
  try {
    assert.equal(workspace.inert, true)
    assert.equal(renderer.root.findAllByProps({ className: 'app-settings-panel-dismiss' }).length, 0)
    const header = renderer.root.findByType('header')
    assert.match(header.props.className, /\bdevice-workspace-header\b/)
    const back = header.findByProps({ className: 'device-workspace-back' })
    assert.equal(back.parent.props.className, 'device-workspace-title')
    assert.equal(back.props['aria-label'], '返回我的设备')
    assert.equal(text(back), '我的设备')
    assert.equal(text(header.findByType('h2')), '设置')
    assert.equal(header.findAllByType('button').length, 1, 'no duplicate top-right close button')
    act(() => back.props.onClick())
    assert.equal(closes, 1)
  } finally {
    act(() => renderer.unmount())
    assert.equal(workspace.inert, false)
  }
})
