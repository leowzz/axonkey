import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import vm from 'node:vm'
import ts from 'typescript'
import React from 'react'
import Renderer, { act } from 'react-test-renderer'
import * as gain from '../src/audioGain.ts'

const require = createRequire(import.meta.url)
const source = path => ts.transpileModule(readFileSync(new URL(path, import.meta.url), 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020, jsx: ts.JsxEmit.ReactJSX },
}).outputText
const waveformModule = { exports: {} }
vm.runInNewContext(source('../src/components/AudioTestWaveform.tsx'), {
  module: waveformModule, exports: waveformModule.exports,
  require: name => name === '../audioGain' ? gain : require(name),
})
const helpModule = { exports: {} }
vm.runInNewContext(source('../src/components/SettingsHelp.tsx'), {
  module: helpModule, exports: helpModule.exports, require, clearTimeout,
})
const text = node => typeof node === 'string' ? node : (Array.isArray(node) ? node : node?.children ?? []).map(text).join('')

async function calibration(platform = 'windows') {
  const calls = []
  let sample = [{ driverInstalled: true, bluetoothConnected: true, forwarding: false, receivedData: false, outputReady: false, error: null }, { peak: 0, rms: 0, nowMs: 1000, waveform: [] }]
  let poll, view
  const module = { exports: {} }
  vm.runInNewContext(source('../src/components/AudioTestDialog.tsx'), {
    module, exports: module.exports,
    window: { setTimeout(callback) { poll = callback; return 1 }, clearTimeout() { poll = undefined } },
    require: name => name === '../audioGain' ? gain
      : name === '../appConfig' ? { audioGainMin: -30, audioGainMax: 30 }
      : name === './AudioTestWaveform' ? waveformModule.exports
      : name === './SettingsHelp' ? helpModule.exports
      : name === '@tauri-apps/api/core' ? { invoke: async (command, args) => { calls.push([command, args]); return sample } }
      : require(name),
  })
  await act(async () => {
    view = Renderer.create(React.createElement(module.exports.AudioTestDialog, {
      platform, nativeRuntime: true, instanceId: 'remote-one', audioGain: 0, gainError: '',
      onAudioGainChange() {}, onClose() {},
    }))
  })
  return {
    calls,
    view,
    text: () => text(view.toJSON()),
    async sample(status, level = sample[1]) {
      sample = [{ ...sample[0], ...status }, level]
      await act(async () => { await poll() })
    },
    async close() { await act(async () => view.unmount()) },
  }
}

test('calibration measures incoming audio and finishes without a virtual microphone consumer', async () => {
  const app = await calibration()
  try {
    assert.match(app.text(), /等待测试/)
    await app.sample({ receivedData: true }, { peak: 0.1, rms: 0.05, nowMs: 1200, waveform: [{ t: 1100, peak: 0.1 }] })
    assert.match(app.text(), /正在收音/)
    assert.match(app.text(), /收音：已收到数据/)
    assert.match(app.text(), /转发：未转发/)
    assert.notEqual(app.view.root.findByProps({ className: 'audio-calibration-envelope' }).props.d, '')
    assert.equal(app.view.root.findByProps({ role: 'meter' }).props['aria-valuenow'], -20)
    await app.sample({ receivedData: false }, { peak: 0, rms: 0, nowMs: 1300, waveform: [{ t: 1100, peak: 0.1 }] })
    assert.match(app.text(), /增益合适/)
    assert.match(app.text(), /建议/)
    assert.ok(app.calls.every(([command, args]) => command === 'get_audio_test_state' && args.instanceId === 'remote-one'))
  } finally { await app.close() }
})

test('calibration continues to support macOS RC003 forwarding status', async () => {
  const app = await calibration('macos')
  try {
    await app.sample({ forwarding: true, outputReady: true }, { peak: 0.02, rms: 0.01, nowMs: 1200, waveform: [{ t: 1100, peak: 0.02 }] })
    assert.match(app.text(), /正在收音/)
    await app.sample({ forwarding: false })
    assert.match(app.text(), /音量偏低/)
  } finally { await app.close() }
})

test('opening or closing a microphone consumer cannot split the current measurement', async () => {
  const app = await calibration()
  try {
    await app.sample({ receivedData: true }, { peak: 0.1, rms: 0.05, nowMs: 1200, waveform: [{ t: 1100, peak: 0.1 }] })
    await app.sample({ forwarding: true, outputReady: true }, { peak: 0.02, rms: 0.01, nowMs: 1400, waveform: [{ t: 1300, peak: 0.02 }] })
    await app.sample({ forwarding: false, outputReady: false })
    assert.match(app.text(), /正在收音/)
    assert.doesNotMatch(app.text(), /应用建议/)
    await app.sample({ receivedData: false })
    assert.match(app.text(), /增益合适/)
  } finally { await app.close() }
})

test('disconnected audio cannot start a calibration measurement', async () => {
  const app = await calibration()
  try {
    await app.sample({ bluetoothConnected: false })
    assert.match(app.text(), /暂不可测试/)
    assert.match(app.text(), /请连接并唤醒遥控器/)
    assert.equal(app.view.root.findByProps({ className: 'audio-calibration-envelope' }).props.d, '')
  } finally { await app.close() }
})
