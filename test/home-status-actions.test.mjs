import assert from 'node:assert/strict'
import test from 'node:test'
import React from 'react'
import Renderer from 'react-test-renderer'
import { HomeDashboard, base, devices, text, permissionLabels } from './fixtures/home-dashboard.mjs'

test('macOS permission management stays available while row actions follow authorization state', () => {
  let opened = 0
  const props = { ...base, onOpenPermissions: () => opened++ }
  const renderer = Renderer.create(React.createElement(HomeDashboard, props))
  const actions = () => renderer.root.findAllByProps({ className: 'home-row-action' })
  const manage = () => renderer.root.findByProps({ className: 'home-section-link' })
  try {
    assert.deepEqual(renderer.root.findAllByType('h3').map(text), ['输入监控', '辅助功能'])
    assert.equal(actions().length, 0)
    manage().props.onClick()
    assert.equal(opened, 1)
    renderer.update(React.createElement(HomeDashboard, { ...props, systemProbeState: 'loading' }))
    assert.equal(actions().length, 0)
    assert.equal(manage().props.onClick, props.onOpenPermissions)
    renderer.update(React.createElement(HomeDashboard, { ...props, inputAuthorizationStale: true, permissions: { inputMonitoring: true, accessibility: false } }))
    assert.deepEqual(permissionLabels(renderer), ['需要重新授权', '未授权'])
    assert.equal(actions().length, 2)
    assert.match(text(actions()[0]), /重新授权/)
    assert.match(text(actions()[1]), /开始授权/)
    actions().forEach(button => button.props.onClick())
    assert.equal(opened, 3)
    renderer.update(React.createElement(HomeDashboard, props))
    assert.equal(actions().length, 0)
    manage().props.onClick()
    assert.equal(opened, 4)
  } finally { renderer.unmount() }
})

test('merged home routes each device, integration, permissions, refresh and logs independently', () => {
  const selected = []
  let integrations = 0, permissions = 0, refreshes = 0, logs = 0
  const props = {
    ...base, onSelectDevice: id => selected.push(id), onIntegrate: () => integrations++,
    onOpenPermissions: () => permissions++, onRefresh: () => refreshes++, onOpenLogs: () => logs++,
  }
  const renderer = Renderer.create(React.createElement(HomeDashboard, props))
  try {
    assert.equal(text(renderer.root.findByType('h1')), '设备与权限')
    const cards = renderer.root.findAllByProps({ className: 'my-devices-card' })
    assert.equal(cards.length, 2)
    assert.match(text(cards[0]), /遥控工作.*3 份配置文件/)
    assert.match(text(cards[1]), /鼠标默认.*1 份配置文件/)
    cards.forEach(card => card.props.onClick())
    assert.deepEqual(selected, ['rc003', 'mouse'])
    renderer.root.findByProps({ className: 'my-devices-integrate' }).props.onClick()
    renderer.root.findByProps({ className: 'home-log-button' }).props.onClick()
    renderer.root.findByProps({ className: 'home-section-link' }).props.onClick()
    const refresh = renderer.root.findByProps({ className: 'home-refresh-button' })
    assert.equal(refresh.props['aria-disabled'], false)
    assert.equal(refresh.props['aria-busy'], false)
    refresh.props.onClick()
    assert.deepEqual({ integrations, permissions, refreshes, logs }, { integrations: 1, permissions: 1, refreshes: 1, logs: 1 })
  } finally { renderer.unmount() }
})

test('browser preview never treats cached permissions as current or invokes native operations', () => {
  let permissions = 0
  const renderer = Renderer.create(React.createElement(HomeDashboard, {
    ...base, nativeRuntime: false, onOpenPermissions: () => permissions++,
    devices: devices.map(device => ({ ...device, status: { label: '浏览器预览', tone: 'neutral' } })),
  }))
  try {
    assert.deepEqual(permissionLabels(renderer), ['浏览器预览', '浏览器预览'])
    assert.equal(renderer.root.findAllByProps({ className: 'home-row-action' }).length, 0)
    const refresh = renderer.root.findByProps({ className: 'home-refresh-button' })
    assert.equal(refresh.props.disabled, true)
    assert.equal(refresh.props['aria-disabled'], true)
    assert.equal(refresh.props.onClick, undefined)
    const logs = renderer.root.findByProps({ className: 'home-log-button' })
    assert.equal(logs.props.disabled, true)
    assert.equal(logs.props.onClick, undefined)
    renderer.root.findByProps({ className: 'home-section-link' }).props.onClick()
    assert.equal(permissions, 1)
    assert.doesNotMatch(text(renderer.root), /已授权|已连接/)
  } finally { renderer.unmount() }
})

test('failed macOS permission checks invalidate cached success and offer retry and logs', () => {
  let refreshed = 0, logs = 0
  const renderer = Renderer.create(React.createElement(HomeDashboard, {
    ...base, systemProbeState: 'error', onRefresh: () => refreshed++, onOpenLogs: () => logs++,
  }))
  try {
    assert.deepEqual(permissionLabels(renderer), ['检测失败', '检测失败'])
    const actions = renderer.root.findAllByProps({ className: 'home-row-action' })
    assert.equal(actions.length, 2)
    actions.forEach(button => button.props.onClick())
    assert.equal(refreshed, 2)
    renderer.root.findByProps({ className: 'home-log-button' }).props.onClick()
    assert.equal(logs, 1)
  } finally { renderer.unmount() }
})

test('Windows does not infer administrator authorization or global failure from device probes', () => {
  const renderer = Renderer.create(React.createElement(HomeDashboard, { ...base, platform: 'windows' }))
  try {
    for (const systemProbeState of ['loading', 'ready', 'error']) {
      renderer.update(React.createElement(HomeDashboard, {
        ...base, platform: 'windows', systemProbeState, inputAuthorizationStale: true,
        permissions: { inputMonitoring: false, accessibility: false },
      }))
      assert.deepEqual(renderer.root.findAllByType('h3').map(text), ['运行环境'])
      assert.deepEqual(permissionLabels(renderer), ['桌面应用'])
      assert.equal(renderer.root.findByProps({ className: 'home-refresh-button' }).props['aria-busy'], false)
      assert.doesNotMatch(text(renderer.root.findByType('aside')), /管理员|已授权|检测失败|正在检测/)
    }
  } finally { renderer.unmount() }
})
