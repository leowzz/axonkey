import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import vm from 'node:vm'
import ts from 'typescript'
import React from 'react'
import Renderer, { act } from 'react-test-renderer'

const require = createRequire(import.meta.url)
const module = { exports: {} }
vm.runInNewContext(ts.transpileModule(readFileSync('src/components/HomeDashboard.tsx', 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX },
}).outputText, {
  module, exports: module.exports,
  require: name => name.endsWith('.css') ? {} : name === '../openGitHub' ? { openGitHub() {} } : require(name),
})
const { HomeDashboard } = module.exports
const props = {
  platform: 'macos', nativeRuntime: true, systemProbeState: 'ready',
  permissions: { inputMonitoring: true, accessibility: true }, inputAuthorizationStale: false,
  enabled: true,
  onOpenPermissions() {}, onRefresh() {}, onOpenDevices() {}, onOpenSettings() {}, onOpenLogs() {},
}

const text = node => typeof node === 'string' ? node : (node.children ?? []).map(text).join('')

test('refresh and page remount preserve environment status; completed permission changes still appear', () => {
  let renderer
  const render = overrides => act(() => {
    const element = React.createElement(HomeDashboard, { ...props, ...overrides })
    if (renderer) renderer.update(element)
    else renderer = Renderer.create(element)
  })
  const title = () => text(renderer.root.findByProps({ id: 'home-status-title' }))
  const refreshControls = () => renderer.root.findAllByType('button').filter(button => typeof button.props['aria-busy'] === 'boolean')
  const assertRefreshBusy = busy => {
    const buttons = refreshControls()
    assert.ok(buttons.length > 0)
    for (const button of buttons) {
      assert.equal(button.props['aria-busy'], busy)
      assert.equal(button.props.onClick, busy ? undefined : props.onRefresh)
    }
  }
  try {
    render()
    assert.equal(title(), '运行环境已就绪')
    const readyCopy = renderer.root.findAllByType('p').map(text)
    render({ refreshing: true })
    assert.equal(title(), '运行环境已就绪')
    assert.deepEqual(renderer.root.findAllByType('p').map(text), readyCopy)
    assertRefreshBusy(true)
    act(() => renderer.unmount())
    renderer = null
    render({ refreshing: true })
    assert.equal(title(), '运行环境已就绪')
    assert.deepEqual(renderer.root.findAllByType('p').map(text), readyCopy)
    assertRefreshBusy(true)
    render({ permissions: { inputMonitoring: false, accessibility: true } })
    assert.equal(title(), '需要完成授权')
    assertRefreshBusy(false)
    render({ inputAuthorizationStale: true })
    assert.equal(title(), '需要完成授权')
    render({ systemProbeState: 'error' })
    assert.equal(title(), '运行环境检测失败')
    assertRefreshBusy(false)
    render({ systemProbeState: 'loading' })
    assert.equal(title(), '正在检测运行环境')
    assertRefreshBusy(true)
  } finally {
    act(() => renderer?.unmount())
  }
})

test('device, input driver and audio failures do not alter a ready application environment', () => {
  let renderer
  try {
    for (const deviceStatus of ['disconnected', 'error']) {
      const element = React.createElement(HomeDashboard, {
        ...props,
        inputDriver: { status: 'error', message: 'Quarbor 输入驱动错误' },
        audioDriver: { status: 'error', message: 'MiRemoteV 2ch 音频错误' },
        device: { status: deviceStatus, message: 'RC003 蓝牙连接错误' },
        batteryLevel: 0,
      })
      act(() => {
        if (renderer) renderer.update(element)
        else renderer = Renderer.create(element)
      })
      assert.equal(text(renderer.root.findByProps({ id: 'home-status-title' })), '运行环境已就绪')
      const output = JSON.stringify(renderer.toJSON())
      for (const deviceCopy of ['Quarbor', 'MiRemoteV', 'RC003', '输入驱动错误', '音频错误', '蓝牙连接错误']) {
        assert.ok(!output.includes(deviceCopy), `Home must not expose device-specific state: ${deviceCopy}`)
      }
    }
  } finally {
    act(() => renderer?.unmount())
  }
})

test('paused features and browser preview remain distinct from permission readiness', () => {
  let renderer
  try {
    act(() => { renderer = Renderer.create(React.createElement(HomeDashboard, { ...props, enabled: false })) })
    assert.equal(text(renderer.root.findByProps({ id: 'home-status-title' })), '软件功能已暂停')
    act(() => renderer.update(React.createElement(HomeDashboard, { ...props, nativeRuntime: false })))
    assert.equal(text(renderer.root.findByProps({ id: 'home-status-title' })), '浏览器预览')
    assert.ok(!text(renderer.root).includes('运行环境已就绪'))
  } finally {
    act(() => renderer?.unmount())
  }
})
