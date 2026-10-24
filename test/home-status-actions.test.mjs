import assert from 'node:assert/strict'
import test from 'node:test'
import React from 'react'
import Renderer from 'react-test-renderer'
import { HomeDashboard, base, devices, text } from './fixtures/home-dashboard.mjs'

test('home routes each device, integration, permissions and logs independently', () => {
  const selected = []
  let integrations = 0, permissions = 0, logs = 0
  const props = {
    ...base, onSelectDevice: id => selected.push(id), onIntegrate: () => integrations++,
    onOpenPermissions: () => permissions++, onOpenLogs: () => logs++,
  }
  const renderer = Renderer.create(React.createElement(HomeDashboard, props))
  try {
    const cards = renderer.root.findAllByProps({ className: 'my-devices-card' })
    assert.equal(cards.length, 2)
    assert.match(text(cards[0]), /遥控工作.*3 份配置文件/)
    assert.match(text(cards[1]), /鼠标默认.*1 份配置文件/)
    cards.forEach(card => card.props.onClick())
    assert.deepEqual(selected, ['rc003', 'mouse'])
    renderer.root.findByProps({ className: 'my-devices-integrate' }).props.onClick()
    const logButton = renderer.root.findByProps({ 'aria-label': '运行日志' })
    assert.equal(logButton.props.disabled, false)
    logButton.props.onClick()
    renderer.root.findByProps({ 'aria-label': '权限设置' }).props.onClick()
    assert.deepEqual({ integrations, permissions, logs }, { integrations: 1, permissions: 1, logs: 1 })
  } finally { renderer.unmount() }
})

test('browser preview disables native logs while keeping permission settings available', () => {
  let permissions = 0, logs = 0
  const props = {
    ...base, nativeRuntime: false, onOpenPermissions: () => permissions++, onOpenLogs: () => logs++,
    devices: devices.map(device => ({ ...device, status: { label: '浏览器预览', tone: 'neutral' } })),
  }
  const renderer = Renderer.create(React.createElement(HomeDashboard, props))
  try {
    const logButton = () => renderer.root.findByProps({ 'aria-label': '运行日志' })
    assert.equal(logButton().props.disabled, true)
    assert.equal(logButton().props.onClick, undefined)
    renderer.root.findByProps({ 'aria-label': '权限设置' }).props.onClick()
    assert.equal(permissions, 1)
    assert.equal(logs, 0)
    assert.deepEqual(devices.map(device => text(renderer.root.findByProps({ id: `my-device-${device.id}-status` }))), ['浏览器预览', '浏览器预览'])
    renderer.update(React.createElement(HomeDashboard, { ...props, nativeRuntime: true }))
    assert.equal(logButton().props.disabled, false)
    logButton().props.onClick()
    assert.equal(logs, 1)
  } finally { renderer.unmount() }
})
