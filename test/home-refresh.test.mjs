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
  require: name => name === '../appConfig' ? { audioGainMin: -30, audioGainMax: 30 }
    : name === '../openGitHub' ? { openGitHub() {} }
      : name === './BatteryIndicator' ? { BatteryIndicator: () => null, BatteryDebugControls: () => null }
        : require(name),
})
const { HomeDashboard } = module.exports
const props = {
  platform: 'macos', nativeRuntime: true, systemProbeState: 'ready',
  permissions: { inputMonitoring: true, accessibility: true }, inputAuthorizationStale: false,
  inputDriver: { status: 'installed' },
  audioDriver: { status: 'installed', message: 'MiRemoteV 2ch 已就绪，RC003 语音通道已连接。' },
  device: { status: 'connected' }, batteryLevel: 40, audioGain: 12, enabled: true,
}

test('refresh and page remount preserve status copy; completed changes still appear', () => {
  let renderer
  const render = overrides => act(() => {
    const element = React.createElement(HomeDashboard, { ...props, ...overrides })
    if (renderer) renderer.update(element)
    else renderer = Renderer.create(element)
  })
  const title = () => renderer.root.findByProps({ id: 'home-device-title' }).children.join('')
  const quickRefresh = () => renderer.root.findAllByType('button').find(button =>
    button.findAllByType('strong').some(node => node.children.join('') === '运行检测'))
  try {
    render()
    assert.equal(title(), 'RC003 已就绪')
    const audioCopy = renderer.root.findAllByType('p').map(node => node.children.join(''))
    render({ refreshing: true })
    assert.equal(title(), 'RC003 已就绪')
    assert.deepEqual(renderer.root.findAllByType('p').map(node => node.children.join('')), audioCopy)
    assert.equal(quickRefresh().props['aria-busy'], true)
    assert.equal(quickRefresh().props.onClick, undefined)
    act(() => renderer.unmount())
    renderer = null
    render({ refreshing: true })
    assert.equal(title(), 'RC003 已就绪')
    render({ audioDriver: { status: 'error', message: '音频检测失败' } })
    assert.equal(title(), '完成设置即可使用')
    assert.equal(quickRefresh().props['aria-busy'], false)
    assert.ok(renderer.root.findAllByType('p').some(node => node.children.join('') === '音频检测失败'))
    render({ systemProbeState: 'loading', audioDriver: { status: 'unknown' } })
    assert.equal(title(), '正在检查 RC003')
  } finally {
    act(() => renderer.unmount())
  }
})
