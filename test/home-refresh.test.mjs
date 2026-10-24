import assert from 'node:assert/strict'
import test from 'node:test'
import React from 'react'
import Renderer, { act } from 'react-test-renderer'
import { HomeDashboard, base, devices, text, permissionLabels } from './fixtures/home-dashboard.mjs'

test('refresh and remount preserve permission status while completed permission changes appear', () => {
  let renderer
  const render = overrides => act(() => {
    const element = React.createElement(HomeDashboard, { ...base, ...overrides })
    if (renderer) renderer.update(element)
    else renderer = Renderer.create(element)
  })
  const assertRefreshBusy = busy => {
    const button = renderer.root.findByProps({ className: 'home-refresh-button' })
    assert.equal(button.props['aria-busy'], busy)
    assert.equal(button.props.onClick, busy ? undefined : base.onRefresh)
  }
  try {
    render()
    assert.deepEqual(permissionLabels(renderer), ['已授权', '已授权'])
    render({ refreshing: true })
    assert.deepEqual(permissionLabels(renderer), ['已授权', '已授权'])
    assertRefreshBusy(true)
    act(() => renderer.unmount())
    renderer = null
    render({ refreshing: true })
    assert.deepEqual(permissionLabels(renderer), ['已授权', '已授权'])
    assertRefreshBusy(true)
    render({ permissions: { inputMonitoring: false, accessibility: true } })
    assert.deepEqual(permissionLabels(renderer), ['未授权', '已授权'])
    assertRefreshBusy(false)
    render({ inputAuthorizationStale: true })
    assert.deepEqual(permissionLabels(renderer), ['需要重新授权', '已授权'])
    render({ systemProbeState: 'error' })
    assert.deepEqual(permissionLabels(renderer), ['检测失败', '检测失败'])
    assertRefreshBusy(false)
    render({ systemProbeState: 'loading' })
    assert.deepEqual(permissionLabels(renderer), ['检测中', '检测中'])
    assertRefreshBusy(true)
  } finally { act(() => renderer?.unmount()) }
})

test('device failures do not alter shared permission state or another device profile', () => {
  let renderer
  try {
    for (const label of ['未连接', '检测失败']) {
      act(() => {
        const element = React.createElement(HomeDashboard, {
          ...base, devices: devices.map(device => device.id === 'rc003'
            ? { ...device, status: { label, tone: 'warning' }, profileName: '遥控专属配置' } : device),
        })
        if (renderer) renderer.update(element)
        else renderer = Renderer.create(element)
      })
      assert.deepEqual(permissionLabels(renderer), ['已授权', '已授权'])
      assert.equal(text(renderer.root.findByProps({ id: 'my-device-rc003-status' })), label)
      assert.match(text(renderer.root.findByProps({ id: 'my-device-rc003-profile' })), /遥控专属配置/)
      assert.match(text(renderer.root.findByProps({ id: 'my-device-mouse-profile' })), /鼠标默认/)
    }
  } finally { act(() => renderer?.unmount()) }
})

test('paused device mappings and browser preview remain distinct from permission readiness', () => {
  let renderer
  try {
    act(() => { renderer = Renderer.create(React.createElement(HomeDashboard, { ...base, devices: devices.map(device => ({ ...device, enabled: false })) })) })
    assert.equal(renderer.root.findAllByProps({ className: 'my-devices-paused' }).length, 2)
    assert.deepEqual(permissionLabels(renderer), ['已授权', '已授权'])
    act(() => renderer.update(React.createElement(HomeDashboard, { ...base, nativeRuntime: false })))
    assert.deepEqual(permissionLabels(renderer), ['浏览器预览', '浏览器预览'])
  } finally { act(() => renderer?.unmount()) }
})
