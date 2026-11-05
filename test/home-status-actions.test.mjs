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
    onOpenCloud: () => actions.push('cloud'),
    onOpenLogs: () => actions.push('logs'),
    onOpenAbout: () => actions.push('about'),
  }
  const renderer = Renderer.create(React.createElement(HomeDashboard, props))
  try {
    assert.equal(text(renderer.root.findByProps({ 'aria-label': '设备工作区' })), '已绑定设备')
    for (const label of ['设置', '账号与同步', '运行日志', '关于']) {
      renderer.root.findAllByType('button').find(button => text(button) === label).props.onClick()
    }
    assert.deepEqual(actions, ['settings', 'cloud', 'logs', 'about'])
  } finally { renderer.unmount() }
})

test('browser preview disables native logs while keeping settings available', () => {
  let settings = 0, logs = 0
  const props = {
    ...base, nativeRuntime: false, onOpenSettings: () => settings++, onOpenLogs: () => logs++,
  }
  const renderer = Renderer.create(React.createElement(HomeDashboard, props))
  try {
    const logButton = () => renderer.root.findByProps({ 'aria-label': '运行日志' })
    assert.equal(logButton().props.disabled, true)
    assert.equal(logButton().props.onClick, undefined)
    renderer.root.findByProps({ 'aria-label': '设置' }).props.onClick()
    assert.equal(settings, 1)
    assert.equal(logs, 0)
    renderer.update(React.createElement(HomeDashboard, { ...props, nativeRuntime: true }))
    assert.equal(logButton().props.disabled, false)
    logButton().props.onClick()
    assert.equal(logs, 1)
  } finally { renderer.unmount() }
})

test('microphone warning follows the global flag and opens driver management', () => {
  let opened = 0
  const props = { ...base, onOpenAudioDriver: () => opened++ }
  const renderer = Renderer.create(React.createElement(HomeDashboard, props))
  try {
    assert.equal(renderer.root.findAllByProps({ role: 'alert' }).length, 0)
    renderer.update(React.createElement(HomeDashboard, { ...props, microphoneDriverAbnormal: true }))
    const warning = renderer.root.findByProps({ role: 'alert' })
    assert.match(text(warning), /虚拟麦克风驱动异常，这会导致遥控器无语音功能。/)
    assert.equal(renderer.toJSON().children[0].props.className, 'home-microphone-warning')
    const button = warning.findAllByType('button').find(button => text(button) === 'Quarbor 虚拟麦克风驱动')
    assert.equal(text(button), 'Quarbor 虚拟麦克风驱动')
    button.props.onClick()
    assert.equal(opened, 1)
    renderer.update(React.createElement(HomeDashboard, props))
    assert.equal(renderer.root.findAllByProps({ role: 'alert' }).length, 0)
    renderer.update(React.createElement(HomeDashboard, { ...props, nativeRuntime: false, microphoneDriverAbnormal: true }))
    assert.equal(renderer.root.findAllByProps({ role: 'alert' }).length, 0)
  } finally { renderer.unmount() }
})

test('closing the warning suppresses it during the same fault and recovery allows a new warning', () => {
  let dismissed = 0
  const props = { ...base, microphoneDriverAbnormal: true, onDismissMicrophoneDriverWarning: () => dismissed++ }
  const renderer = Renderer.create(React.createElement(HomeDashboard, props))
  try {
    renderer.root.findByProps({ 'aria-label': '关闭麦克风驱动异常提醒' }).props.onClick()
    assert.equal(dismissed, 1)
    renderer.update(React.createElement(HomeDashboard, { ...props, microphoneDriverWarningSuppressed: true }))
    assert.equal(renderer.root.findAllByProps({ role: 'alert' }).length, 0)
    renderer.update(React.createElement(HomeDashboard, { ...props, microphoneDriverAbnormal: false }))
    assert.equal(renderer.root.findAllByProps({ role: 'alert' }).length, 0)
    renderer.update(React.createElement(HomeDashboard, props))
    assert.equal(renderer.root.findAllByProps({ role: 'alert' }).length, 1)
  } finally { renderer.unmount() }
})
