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
  require: name => {
    if (name === '../appConfig') return { audioGainMin: -30, audioGainMax: 30 }
    if (name === '../openGitHub') return { openGitHub: () => {} }
    if (name === './BatteryIndicator') return { BatteryIndicator: () => null, BatteryDebugControls: () => null }
    return require(name)
  },
})
const { HomeDashboard } = module.exports
const base = {
  platform: 'macos', nativeRuntime: true, systemProbeState: 'ready',
  permissions: { inputMonitoring: true, accessibility: true }, inputAuthorizationStale: false,
  inputDriver: { status: 'installed' }, audioDriver: { status: 'installed' },
  device: { status: 'connected' }, batteryLevel: null, audioGain: 0, enabled: true,
}

test('ready and checking rows hide settings; actionable rows preserve navigation and calibration', () => {
  let opened = 0, calibrated = 0
  const props = { ...base, onOpenPermissions: () => opened++, onTestAudio: () => calibrated++ }
  const renderer = Renderer.create(React.createElement(HomeDashboard, props))
  const actions = () => renderer.root.findAllByProps({ className: 'home-row-action' })
  try {
    assert.equal(actions().length, 0)
    renderer.root.findByProps({ className: 'home-audio-test-button' }).props.onClick()
    assert.equal(calibrated, 1)
    renderer.update(React.createElement(HomeDashboard, { ...props, systemProbeState: 'loading', audioDriver: { status: 'checking' } }))
    assert.equal(actions().length, 0)
    renderer.update(React.createElement(HomeDashboard, { ...props, inputAuthorizationStale: true, permissions: { inputMonitoring: true, accessibility: false }, audioDriver: { status: 'missing' }, device: { status: 'disconnected' } }))
    assert.equal(actions().length, 4)
    actions().forEach(button => button.props.onClick())
    assert.equal(opened, 4)
    renderer.update(React.createElement(HomeDashboard, props))
    assert.equal(actions().length, 0)
  } finally {
    renderer.unmount()
  }
})

test('hardware mapping recovery shows a retry action and returns to ready after success', () => {
  let refreshed = 0, openedPermissions = 0
  const props = { ...base, onRefresh: () => refreshed++, onOpenPermissions: () => openedPermissions++ }
  const renderer = Renderer.create(React.createElement(HomeDashboard, {
    ...props, inputMappingRecovering: true,
    inputDriver: { status: 'error', message: 'RC003 硬件按键映射尚未恢复，正在自动重试。' },
  }))
  const text = () => JSON.stringify(renderer.toJSON())
  try {
    assert.match(text(), /按键映射/)
    assert.match(text(), /恢复中/)
    assert.doesNotMatch(text(), /启动失败|打开设置|重新授权/)
    const retry = renderer.root.findByProps({ className: 'home-row-action' })
    assert.equal(retry.children[0], '重新检测')
    retry.props.onClick()
    assert.equal(refreshed, 1)
    assert.equal(openedPermissions, 0)

    renderer.update(React.createElement(HomeDashboard, { ...props, inputMappingRecovering: false }))
    assert.doesNotMatch(text(), /恢复中/)
    assert.equal(renderer.root.findAllByProps({ className: 'home-row-action' }).length, 0)

    renderer.update(React.createElement(HomeDashboard, {
      ...props, inputMappingRecovering: true, inputAuthorizationStale: true,
      inputDriver: { status: 'error' },
    }))
    assert.match(text(), /需要重新授权/)
    renderer.root.findByProps({ className: 'home-row-action' }).props.onClick()
    assert.equal(openedPermissions, 1)
  } finally {
    renderer.unmount()
  }
})
