import assert from 'node:assert/strict'
import test from 'node:test'
import React from 'react'
import Renderer from 'react-test-renderer'
import { HomeDashboard, base, text } from './fixtures/home-dashboard.mjs'

test('home renders the device workspace and routes footer actions independently', () => {
  const actions = []
  const props = {
    ...base,
    deviceContent: React.createElement('section', { 'aria-label': '设备工作区' }, '已绑定设备'),
    onOpenSettings: () => actions.push('settings'),
    onOpenPermissions: () => actions.push('permissions'),
    onOpenLogs: () => actions.push('logs'),
    onOpenAbout: () => actions.push('about'),
  }
  const renderer = Renderer.create(React.createElement(HomeDashboard, props))
  try {
    assert.equal(text(renderer.root.findByProps({ 'aria-label': '设备工作区' })), '已绑定设备')
    for (const label of ['设置', '权限设置', '运行日志', '关于']) {
      renderer.root.findByProps({ 'aria-label': label }).props.onClick()
    }
    assert.deepEqual(actions, ['settings', 'permissions', 'logs', 'about'])
  } finally { renderer.unmount() }
})

test('browser preview disables native logs while keeping permission settings available', () => {
  let permissions = 0, logs = 0
  const props = {
    ...base, nativeRuntime: false, onOpenPermissions: () => permissions++, onOpenLogs: () => logs++,
  }
  const renderer = Renderer.create(React.createElement(HomeDashboard, props))
  try {
    const logButton = () => renderer.root.findByProps({ 'aria-label': '运行日志' })
    assert.equal(logButton().props.disabled, true)
    assert.equal(logButton().props.onClick, undefined)
    renderer.root.findByProps({ 'aria-label': '权限设置' }).props.onClick()
    assert.equal(permissions, 1)
    assert.equal(logs, 0)
    renderer.update(React.createElement(HomeDashboard, { ...props, nativeRuntime: true }))
    assert.equal(logButton().props.disabled, false)
    logButton().props.onClick()
    assert.equal(logs, 1)
  } finally { renderer.unmount() }
})
