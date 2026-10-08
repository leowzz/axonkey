import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import vm from 'node:vm'
import ts from 'typescript'
import React from 'react'
import Renderer, { act } from 'react-test-renderer'

const require = createRequire(import.meta.url)
async function environment({ supported = true, failStatus = false, failInstall = false } = {}) {
  const requests = []
  let installed = false
  const module = { exports: {} }
  const source = ts.transpileModule(readFileSync('src/components/InterceptionFixControl.tsx', 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX } }).outputText
  const invoke = async (_, { action }) => {
    requests.push(action)
    if (action === 'status') {
      if (failStatus) throw new Error('status unavailable')
      return { installed, configured: installed, restartRequired: installed, exitCode: 0, serviceState: 'Stopped' }
    }
    if (action === 'install' && failInstall) throw new Error('UAC cancelled')
    installed = action === 'install'
  }
  vm.runInNewContext(source, { module, exports: module.exports, require: name => name === '@tauri-apps/api/core' ? { invoke } : name === './SettingsHelp' ? { SettingsHelp: () => null } : require(name) })
  let renderer
  await act(async () => { renderer = Renderer.create(React.createElement(module.exports.InterceptionFixControl, { supported })) })
  return { requests, renderer, button: name => renderer.root.findAllByType('button').find(b => b.children.join('') === name) }
}

test('upgrade prompt explains the optional enhancement and supports skipping', async () => {
  const module = { exports: {} }
  const source = ts.transpileModule(readFileSync('src/components/InterceptionFixPrompt.tsx', 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX } }).outputText
  vm.runInNewContext(source, { module, exports: module.exports, require })
  let installed = 0
  let skipped = 0
  let renderer
  await act(async () => {
    renderer = Renderer.create(React.createElement(module.exports.InterceptionFixPrompt, {
      busy: false,
      error: '',
      onInstall: () => { installed++ },
      onSkip: () => { skipped++ },
    }))
  })
  assert.match(JSON.stringify(renderer.toJSON()), /可选功能/)
  assert.match(JSON.stringify(renderer.toJSON()), /设置 → 设备与权限/)
  const buttons = renderer.root.findAllByType('button')
  buttons.find(button => button.children.join('') === '暂不安装').props.onClick()
  buttons.find(button => button.children.join('') === '安装增强').props.onClick()
  assert.equal(skipped, 1)
  assert.equal(installed, 1)
  renderer.unmount()
})

test('mount only probes; enabling is explicit, needs reboot; removal remains available', async () => {
  const env = await environment()
  assert.deepEqual(env.requests, ['status'])
  await act(async () => { env.button('补装并授权').props.onClick() })
  assert.deepEqual(env.requests, ['status', 'install', 'status'])
  assert.match(JSON.stringify(env.renderer.toJSON()), /等待重启/)
  assert.equal(env.button('补装并授权').props.disabled, true)
  await act(async () => { env.button('卸载修复').props.onClick() })
  assert.match(JSON.stringify(env.renderer.toJSON()), /重启 Windows 完成回滚/)
  env.renderer.unmount()
})
test('cancelled UAC never reports success; failed status does not appear disabled', async () => {
  const cancelled = await environment({ failInstall: true })
  await act(async () => { cancelled.button('补装并授权').props.onClick() })
  assert.match(JSON.stringify(cancelled.renderer.toJSON()), /UAC cancelled/)
  assert.doesNotMatch(JSON.stringify(cancelled.renderer.toJSON()), /已安装，请重启/)
  cancelled.renderer.unmount()
  const failed = await environment({ failStatus: true })
  assert.equal(failed.button('补装并授权').props.disabled, true)
  assert.equal(failed.button('卸载修复').props.disabled, false)
  assert.match(JSON.stringify(failed.renderer.toJSON()), /status unavailable/)
  failed.renderer.unmount()
})
test('browser preview has no native side effects', async () => {
  const env = await environment({ supported: false })
  assert.deepEqual(env.requests, [])
  assert.equal(env.button('补装并授权').props.disabled, true)
  env.renderer.unmount()
})
