import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync } from 'node:fs'
import vm from 'node:vm'
import ts from 'typescript'
import React from 'react'
import Renderer, { act } from 'react-test-renderer'

function environment({ nativeRuntime = true, platform = 'macos' } = {}) {
  const requests = [], toasts = []
  const module = { exports: {} }
  const source = ts.transpileModule(readFileSync('src/hooks/useAudioControls.ts', 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
  }).outputText
  const imports = {
    react: React,
    '@tauri-apps/api/core': { invoke(command) {
      if (command !== 'restart_audio_service') return Promise.resolve()
      return new Promise((resolve, reject) => requests.push({ resolve, reject }))
    } },
    '../appConfig': { audioGainMin: -30, audioGainMax: 30, audioSettingsStorageKey: 'audio', getStoredAudioGain: () => 6 },
    '../runtimeLogging': { logError() {}, logInfo() {} },
  }
  vm.runInNewContext(source, {
    module, exports: module.exports, require: name => {
      assert.ok(name in imports, `Unexpected import: ${name}`)
      return imports[name]
    },
    window: { localStorage: { setItem() {} }, setTimeout() {} },
  })
  let controls, renderer
  function Harness() {
    controls = module.exports.useAudioControls({ nativeRuntime, platform, onToast: message => toasts.push(message) })
    return null
  }
  return {
    requests, toasts,
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
