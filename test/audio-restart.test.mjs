import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync } from 'node:fs'
import vm from 'node:vm'
import ts from 'typescript'
import React from 'react'
import Renderer, { act } from 'react-test-renderer'

function environment({ nativeRuntime = true, platform = 'macos', deferStretch = false } = {}) {
  const requests = [], toasts = [], stretchRequests = [], saved = []
  const module = { exports: {} }
  const source = ts.transpileModule(readFileSync('src/hooks/useAudioControls.ts', 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
  }).outputText
  const imports = {
    react: React,
    '@tauri-apps/api/core': { invoke(command, args) {
      if (command === 'set_audio_stretch_compensation' && deferStretch) return new Promise((resolve, reject) => stretchRequests.push({ args, resolve, reject }))
      if (command !== 'restart_audio_service') return Promise.resolve()
      return new Promise((resolve, reject) => requests.push({ resolve, reject }))
    } },
    '../appConfig': { audioGainMin: -30, audioGainMax: 30, audioSettingsStorageKey: 'audio', getStoredAudioGain: () => 6, getStoredAudioStretchCompensation: () => false },
    '../runtimeLogging': { logError() {}, logInfo() {} },
  }
  vm.runInNewContext(source, {
    module, exports: module.exports, require: name => {
      assert.ok(name in imports, `Unexpected import: ${name}`)
      return imports[name]
    },
    window: { localStorage: { setItem(_key, value) { saved.push(JSON.parse(value)) } }, setTimeout() {} },
  })
  let controls, renderer
  function Harness() {
    controls = module.exports.useAudioControls({ nativeRuntime, platform, onToast: message => toasts.push(message) })
    return null
  }
  return {
    requests, toasts, stretchRequests, saved,
    get controls() { return controls },
    async mount() { await act(async () => { renderer = Renderer.create(React.createElement(Harness)) }) },
    async close() { await act(async () => renderer.unmount()) },
  }
}

test('restart ignores repeated clicks and reports completion only after native rebinding', async () => {
  const app = environment()
  await app.mount()
  try {
    let pending
    await act(async () => {
      pending = app.controls.restartAudio()
      await app.controls.restartAudio()
    })
    assert.equal(app.requests.length, 1)
    assert.equal(app.controls.audioRestarting, true)
    assert.deepEqual(app.toasts, [])
    await act(async () => { app.requests[0].resolve(); await pending })
    assert.equal(app.controls.audioRestarting, false)
    assert.equal(app.controls.audioRestartError, '')
    assert.equal(app.controls.audioGain, 6)
    assert.equal(app.toasts.length, 1)
  } finally { await app.close() }
})

test('restart failure stays visible and a subsequent retry clears it', async () => {
  const app = environment()
  await app.mount()
  try {
    await act(async () => {
      const pending = app.controls.restartAudio()
      app.requests[0].reject('设备选择失败')
      await pending
    })
    assert.equal(app.controls.audioRestartError, '重启失败：设备选择失败')
    assert.equal(app.controls.audioRestarting, false)
    assert.deepEqual(app.toasts, [])
    let pending
    await act(async () => { pending = app.controls.restartAudio() })
    assert.equal(app.controls.audioRestartError, '')
    assert.equal(app.controls.audioRestarting, true)
    await act(async () => { app.requests[1].resolve(); await pending })
    assert.equal(app.controls.audioRestarting, false)
    assert.equal(app.toasts.length, 1)
  } finally { await app.close() }
})

test('preview and unsupported platforms cannot restart native audio', async () => {
  for (const options of [{ nativeRuntime: false }, { platform: 'windows' }, { platform: 'unsupported' }]) {
    const app = environment(options)
    await app.mount()
    try {
      await act(async () => app.controls.restartAudio())
      assert.equal(app.requests.length, 0)
      assert.equal(app.controls.audioRestarting, false)
      assert.deepEqual(app.toasts, [])
    } finally { await app.close() }
  }
})

test('stretch setting persists only native success, preserves gain, and serializes toggles', async () => {
  const app = environment({ deferStretch: true })
  await app.mount()
  try {
    assert.equal(app.controls.stretchUpdating, true)
    assert.equal(app.stretchRequests[0].args.enabled, false)
    await act(async () => app.stretchRequests[0].resolve())
    let pending
    await act(async () => {
      pending = app.controls.updateStretchCompensation(true)
      await app.controls.updateStretchCompensation(true)
    })
    assert.equal(app.stretchRequests.length, 2)
    assert.equal(app.controls.stretchCompensation, false)
    await act(async () => { app.stretchRequests[1].reject('请松开语音键'); await pending })
    assert.equal(app.controls.stretchCompensation, false)
    assert.match(app.controls.stretchError, /请松开语音键/)
    assert.equal(app.saved.at(-1).stretchCompensation, false)
    await act(async () => { pending = app.controls.updateStretchCompensation(true) })
    await act(async () => { app.stretchRequests[2].resolve(); await pending })
    assert.equal(app.controls.stretchCompensation, true)
    assert.equal(app.controls.stretchError, '')
    assert.deepEqual(app.saved.at(-1), { gain: 6, stretchCompensation: true })
    await act(async () => app.controls.updateAudioGain(8))
    assert.deepEqual(app.saved.at(-1), { gain: 8, stretchCompensation: true })
  } finally { await app.close() }
})

test('stretch defaults off for old or invalid settings and requires an explicit true preference', () => {
  const source = ts.createSourceFile('appConfig.tsx', readFileSync('src/appConfig.tsx', 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)
  const names = new Set(['isRecord', 'getStoredAudioStretchCompensation'])
  const functions = source.statements.filter(node => ts.isFunctionDeclaration(node) && names.has(node.name?.text)).map(node => node.getText(source)).join('\n')
  assert.equal(functions.includes('getStoredAudioStretchCompensation'), true)
  const compiled = ts.transpileModule(functions, { compilerOptions: { module: ts.ModuleKind.CommonJS } }).outputText
  const read = (stored, hasWindow = true) => {
    const module = { exports: {} }
    vm.runInNewContext(compiled, {
      module, exports: module.exports, audioSettingsStorageKey: 'audio',
      ...(hasWindow ? { window: { localStorage: { getItem: () => stored } } } : {}),
    })
    return module.exports.getStoredAudioStretchCompensation()
  }
  for (const value of [null, '{}', '{"gain":13}', 'null', '[]', 'invalid', '{"stretchCompensation":"false"}', '{"stretchCompensation":"true"}', '{"stretchCompensation":1}']) assert.equal(read(value), false)
  assert.equal(read('{"gain":13,"stretchCompensation":false}'), false)
  assert.equal(read('{"gain":13,"stretchCompensation":true}'), true)
  assert.equal(read(null, false), false)
})
