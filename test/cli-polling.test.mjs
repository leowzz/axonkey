import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync } from 'node:fs'
import vm from 'node:vm'
import ts from 'typescript'
import React from 'react'
import Renderer, { act } from 'react-test-renderer'

test('a callback update cannot abandon already claimed CLI requests or start another poll', async () => {
  let pollCount = 0, release
  const calls = []
  const exports = {}
  const source = ts.transpileModule(readFileSync(new URL('../src/useCliRequests.ts', import.meta.url), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText
  vm.runInNewContext(source, {
    exports, setTimeout, clearTimeout,
    require(name) {
      if (name === 'react') return React
      if (name === '@tauri-apps/api/core') return { invoke: async () => { pollCount++; return [{ id: 'a' }, { id: 'b' }] } }
      if (name === './runtimeLogging') return { logError() {} }
      throw new Error(name)
    },
  })
  function Harness({ updated }) {
    exports.useCliRequests(true, async request => {
      calls.push(`${updated}:${request.id}`)
      if (request.id === 'a') await new Promise(resolve => { release = resolve })
    })
    return null
  }
  let view
  await act(async () => { view = Renderer.create(React.createElement(Harness, { updated: false })) })
  try {
    await act(async () => { view.update(React.createElement(Harness, { updated: true })) })
    assert.equal(pollCount, 1)
    await act(async () => { release() })
    assert.deepEqual(calls, ['false:a', 'true:b'])
    assert.equal(pollCount, 1)
  } finally { await act(async () => view.unmount()) }
})
