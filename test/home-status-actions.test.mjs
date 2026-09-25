import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import vm from 'node:vm'
import ts from 'typescript'
import React from 'react'
import Renderer from 'react-test-renderer'
import * as windowsAudioEndpoints from '../src/windowsAudioEndpoints.ts'

const require = createRequire(import.meta.url)
const module = { exports: {} }
const source = ts.transpileModule(readFileSync(new URL('../src/components/HomeDashboard.tsx', import.meta.url), 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX },
}).outputText
vm.runInNewContext(source, {
  module, exports: module.exports,
  require: name => {
    if (name === '../windowsAudioEndpoints') return windowsAudioEndpoints
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
