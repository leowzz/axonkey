import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import vm from 'node:vm'
import ts from 'typescript'
import React from 'react'
import Renderer from 'react-test-renderer'

const require = createRequire(import.meta.url)
const module = { exports: {} }
const source = ts.transpileModule(readFileSync(new URL('../src/components/HomeDashboard.tsx', import.meta.url), 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX },
}).outputText
vm.runInNewContext(source, {
  module, exports: module.exports,
  require: name => name === '../openGitHub' ? { openGitHub: () => {} } : require(name),
})
const { HomeDashboard } = module.exports
const base = {
  platform: 'macos', nativeRuntime: true, systemProbeState: 'ready',
  permissions: { inputMonitoring: true, accessibility: true }, inputAuthorizationStale: false,
  enabled: true,
  onOpenPermissions() {}, onRefresh() {}, onOpenDevices() {}, onOpenSettings() {}, onOpenLogs() {},
}
const text = node => typeof node === 'string' ? node : (node.children ?? []).map(text).join('')
const featureState = renderer => renderer.root.find(node => (node.props.className ?? '').split(' ').includes('home-feature-state'))

test('macOS permission management stays available while row actions follow authorization state', () => {
  let opened = 0
  const props = { ...base, onOpenPermissions: () => opened++ }
  const renderer = Renderer.create(React.createElement(HomeDashboard, props))
  const actions = () => renderer.root.findAllByProps({ className: 'home-row-action' })
  const manage = () => renderer.root.findAllByType('button').find(button => text(button) === '管理权限')
  try {
    assert.deepEqual(renderer.root.findAllByType('h3').map(text), ['输入监控', '辅助功能'])
    assert.equal(actions().length, 0)
    manage().props.onClick()
    assert.equal(opened, 1)
    renderer.update(React.createElement(HomeDashboard, { ...props, systemProbeState: 'loading' }))
    assert.equal(actions().length, 0)
    assert.equal(manage().props.onClick, props.onOpenPermissions)
    renderer.update(React.createElement(HomeDashboard, { ...props, inputAuthorizationStale: true, permissions: { inputMonitoring: true, accessibility: false } }))
    assert.equal(text(renderer.root.findByProps({ id: 'home-status-title' })), '需要完成授权')
    assert.equal(actions().length, 2)
    assert.match(text(actions()[0]), /重新授权/)
    assert.match(text(actions()[1]), /开始授权/)
    actions().forEach(button => button.props.onClick())
    assert.equal(opened, 3)
    renderer.update(React.createElement(HomeDashboard, props))
    assert.equal(actions().length, 0)
    manage().props.onClick()
    assert.equal(opened, 4)
  } finally {
    renderer.unmount()
  }
})

test('home exposes three quick destinations, permission management and one refresh action', () => {
  let devices = 0, settings = 0, permissions = 0, refreshes = 0, logs = 0
  const props = {
    ...base, onOpenDevices: () => devices++, onOpenPermissions: () => permissions++,
    onOpenSettings: () => settings++, onRefresh: () => refreshes++, onOpenLogs: () => logs++,
  }
  const renderer = Renderer.create(React.createElement(HomeDashboard, props))
  const quick = title => renderer.root.findAllByProps({ className: 'home-quick-button' }).find(button =>
    button.findAllByType('strong').some(node => text(node) === title))
  try {
    assert.equal(text(renderer.root.findByType('h1')), '主页')
    assert.match(text(featureState(renderer)), /软件功能.*已开启/)
    const shortcuts = renderer.root.findAllByProps({ className: 'home-quick-button' })
    assert.deepEqual(shortcuts.map(button => text(button.findByType('strong'))), ['我的设备', '设置', '运行日志'])
    quick('我的设备').props.onClick()
    quick('设置').props.onClick()
    quick('运行日志').props.onClick()
    renderer.root.findAllByType('button').find(button => text(button) === '管理权限').props.onClick()
    const refresh = renderer.root.findByProps({ className: 'home-refresh-button' })
    assert.equal(renderer.root.findAllByType('button').filter(button => button.props.onClick === props.onRefresh).length, 1)
    assert.equal(refresh.props['aria-disabled'], false)
    assert.equal(refresh.props['aria-busy'], false)
    refresh.props.onClick()
    assert.deepEqual({ devices, settings, permissions, refreshes, logs }, { devices: 1, settings: 1, permissions: 1, refreshes: 1, logs: 1 })
  } finally {
    renderer.unmount()
  }
})

test('browser preview never treats cached permissions as current or invokes native operations', () => {
  let permissions = 0
  const renderer = Renderer.create(React.createElement(HomeDashboard, { ...base, nativeRuntime: false, onOpenPermissions: () => permissions++ }))
  try {
    const labels = renderer.root.findAllByProps({ className: 'home-status-label' })
    assert.deepEqual(labels.map(text), ['浏览器预览', '浏览器预览'])
    assert.equal(text(renderer.root.findByProps({ id: 'home-status-title' })), '浏览器预览')
    assert.equal(renderer.root.findAllByProps({ className: 'home-row-action' }).length, 0)
    const refresh = renderer.root.findByProps({ className: 'home-refresh-button' })
    assert.equal(refresh.props.disabled, true)
    assert.equal(refresh.props['aria-disabled'], true)
    assert.equal(refresh.props.onClick, undefined)
    const logs = renderer.root.findAllByProps({ className: 'home-quick-button' }).find(button => text(button).startsWith('运行日志'))
    assert.equal(logs.props.disabled, true)
    assert.equal(logs.props['aria-disabled'], true)
    assert.equal(logs.props.onClick, undefined)
    renderer.root.findAllByType('button').find(button => text(button) === '管理权限').props.onClick()
    assert.equal(permissions, 1)
    assert.equal(renderer.root.findAllByType('img').length, 0)
    assert.doesNotMatch(text(renderer.root), /已授权|已连接|校准|电量|RC003|Quarbor|MiRemoteV/)
  } finally {
    renderer.unmount()
  }
})

test('failed macOS permission checks invalidate cached success and offer retry and logs', () => {
  let refreshed = 0, logs = 0
  const renderer = Renderer.create(React.createElement(HomeDashboard, {
    ...base, systemProbeState: 'error', onRefresh: () => refreshed++, onOpenLogs: () => logs++,
  }))
  try {
    const labels = renderer.root.findAllByProps({ className: 'home-status-label' })
    assert.equal(labels.filter(node => text(node) === '检测失败').length, 2)
    assert.equal(text(renderer.root.findByProps({ id: 'home-status-title' })), '运行环境检测失败')
    const actions = renderer.root.findAllByProps({ className: 'home-row-action' })
    assert.equal(actions.length, 2)
    actions.forEach(button => button.props.onClick())
    assert.equal(refreshed, 2)
    renderer.root.findAllByProps({ className: 'home-quick-button' }).find(button => text(button).startsWith('运行日志')).props.onClick()
    assert.equal(logs, 1)
    assert.doesNotMatch(text(renderer.root), /运行环境已就绪|已授权|RC003|驱动/)
  } finally {
    renderer.unmount()
  }
})

test('Windows does not infer administrator authorization or global failure from device probes', () => {
  const renderer = Renderer.create(React.createElement(HomeDashboard, { ...base, platform: 'windows' }))
  try {
    for (const systemProbeState of ['loading', 'ready', 'error']) {
      renderer.update(React.createElement(HomeDashboard, {
        ...base, platform: 'windows', systemProbeState, inputAuthorizationStale: true,
        permissions: { inputMonitoring: false, accessibility: false },
        inputDriver: { status: 'error', message: 'Quarbor HID driver unavailable' },
      }))
      assert.deepEqual(renderer.root.findAllByType('h3').map(text), ['运行环境'])
      assert.equal(text(renderer.root.findByProps({ id: 'home-status-title' })), '自定义功能已启用')
      assert.deepEqual(renderer.root.findAllByProps({ className: 'home-status-label' }).map(text), ['桌面应用'])
      assert.match(text(featureState(renderer)), /软件功能.*已开启/)
      assert.equal(renderer.root.findByProps({ className: 'home-refresh-button' }).props['aria-busy'], false)
      assert.doesNotMatch(text(renderer.root), /管理员|已授权|检测失败|正在检测|Quarbor|运行环境已就绪/)
    }
    renderer.update(React.createElement(HomeDashboard, { ...base, platform: 'windows', enabled: false }))
    assert.equal(text(renderer.root.findByProps({ id: 'home-status-title' })), '软件功能已暂停')
    assert.match(text(featureState(renderer)), /软件功能.*已暂停/)
  } finally {
    renderer.unmount()
  }
})
