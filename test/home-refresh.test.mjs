import assert from 'node:assert/strict'
import test from 'node:test'
import React from 'react'
import Renderer, { act } from 'react-test-renderer'
import { HomeDashboard, base, devices, text } from './fixtures/home-dashboard.mjs'

test('device status and profile updates remain independent after rerender and remount', () => {
  let renderer
  const render = updatedDevices => act(() => {
    const element = React.createElement(HomeDashboard, { ...base, devices: updatedDevices })
    if (renderer) renderer.update(element)
    else renderer = Renderer.create(element)
  })
  try {
    render(devices)
    for (const label of ['已连接', '检测失败']) {
      const updatedDevices = devices.map(device => device.id === 'rc003'
        ? { ...device, status: { label, tone: label === '已连接' ? 'ready' : 'warning' }, profileName: '遥控专属配置', profileCount: 4 } : device)
      render(updatedDevices)
      assert.equal(text(renderer.root.findByProps({ id: 'my-device-rc003-status' })), label)
      assert.match(text(renderer.root.findByProps({ id: 'my-device-rc003-profile' })), /遥控专属配置/)
      assert.match(text(renderer.root.findByProps({ id: 'my-device-rc003-mapping' })), /4 份配置文件/)
      assert.equal(text(renderer.root.findByProps({ id: 'my-device-mouse-status' })), '可用')
      assert.match(text(renderer.root.findByProps({ id: 'my-device-mouse-profile' })), /鼠标默认/)
      assert.match(text(renderer.root.findByProps({ id: 'my-device-mouse-mapping' })), /1 份配置文件/)
      act(() => renderer.unmount())
      renderer = null
      render(updatedDevices)
      assert.equal(text(renderer.root.findByProps({ id: 'my-device-rc003-status' })), label)
      assert.match(text(renderer.root.findByProps({ id: 'my-device-rc003-profile' })), /遥控专属配置/)
    }
  } finally { act(() => renderer?.unmount()) }
})

test('pausing one device does not change another device or its connection status', () => {
  let renderer
  try {
    act(() => { renderer = Renderer.create(React.createElement(HomeDashboard, {
      ...base, devices: devices.map(device => ({ ...device, enabled: device.id !== 'mouse' })),
    })) })
    assert.equal(renderer.root.findAllByProps({ className: 'my-devices-paused' }).length, 1)
    assert.doesNotMatch(text(renderer.root.findByProps({ id: 'my-device-rc003-mapping' })), /映射已暂停/)
    assert.match(text(renderer.root.findByProps({ id: 'my-device-mouse-mapping' })), /映射已暂停/)
    assert.equal(text(renderer.root.findByProps({ id: 'my-device-mouse-status' })), '可用')
    act(() => renderer.update(React.createElement(HomeDashboard, base)))
    assert.equal(renderer.root.findAllByProps({ className: 'my-devices-paused' }).length, 0)
    assert.equal(text(renderer.root.findByProps({ id: 'my-device-rc003-status' })), '未连接')
    assert.equal(text(renderer.root.findByProps({ id: 'my-device-mouse-status' })), '可用')
  } finally { act(() => renderer?.unmount()) }
})
