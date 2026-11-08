import assert from 'node:assert/strict'
import test from 'node:test'
import React from 'react'
import Renderer from 'react-test-renderer'
import { HomeDashboard, base, text } from './fixtures/home-dashboard.mjs'

test('home renders the device workspace without duplicating global navigation', () => {
  const props = {
    ...base,
    deviceContent: React.createElement('section', { 'aria-label': '设备工作区' }, '已绑定设备'),
  }
  const renderer = Renderer.create(React.createElement(HomeDashboard, props))
  try {
    assert.equal(text(renderer.root.findByProps({ 'aria-label': '设备工作区' })), '已绑定设备')
    assert.equal(renderer.root.findAllByType('footer').length, 0)
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
