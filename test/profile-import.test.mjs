import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import vm from 'node:vm'
import ts from 'typescript'
import React from 'react'
import Renderer, { act } from 'react-test-renderer'
import * as deviceModel from '../src/deviceModel.ts'
import { createBehavior, createEmptyBehaviorMap } from '../src/behaviorModel.ts'

const require = createRequire(import.meta.url)
const text = node => typeof node === 'string' ? node : (Array.isArray(node) ? node : node?.children ?? []).map(text).join('')
const source = ts.transpileModule(readFileSync('src/components/ProfileImportDialog.tsx', 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020, jsx: ts.JsxEmit.ReactJSX },
}).outputText
const module = { exports: {} }
vm.runInNewContext(source, {
  module, exports: module.exports,
  require(name) {
    if (name === '../deviceModel') return deviceModel
    if (name === '../appConfig') return {
      buttons: [{ id: 'power', label: '电源' }],
      behaviorSummary: behavior => behavior.key,
      normalizeProfileName: name => name.trim(),
    }
    return require(name)
  },
})

test('profile import preview counts and lists only the target device and explains its switch', async () => {
  const behaviors = createEmptyBehaviorMap()
  behaviors.power.click = [createBehavior({ type: 'key', key: 'Esc' }), createBehavior({ type: 'key', key: 'Enter' })]
  behaviors['mouse.top.up'].click = [createBehavior({ type: 'key', key: 'PageUp' })]
  for (const [deviceId, inputCount, stepCount, visible, hidden, switchName] of [
    ['rc003', '1个遥控器按键', '2个行为步骤', '电源：Esc', 'PageUp', '映射总开关'],
    ['mouse', '1个鼠标输入', '1个行为步骤', 'PageUp', '电源：Esc', '系统鼠标映射开关'],
  ]) {
    let view
    await act(async () => { view = Renderer.create(React.createElement(module.exports.ProfileImportDialog, {
      fileName: 'device.json', suggestedName: '测试', deviceId, behaviors, platform: 'macos', enabled: false,
      onCancel() {}, onSave() {},
    })) })
    try {
      const content = text(view.toJSON())
      for (const expected of [inputCount, stepCount, visible, switchName]) assert.ok(content.includes(expected), expected)
      assert.ok(!content.includes(hidden), `must not preview another device: ${hidden}`)
    } finally { await act(async () => view.unmount()) }
  }
})

test('legacy mouse imports without a device switch show no switch application notice', async () => {
  let view
  await act(async () => { view = Renderer.create(React.createElement(module.exports.ProfileImportDialog, {
    fileName: 'legacy.json', suggestedName: '旧配置', deviceId: 'mouse', behaviors: createEmptyBehaviorMap(), platform: 'macos',
    onCancel() {}, onSave() {},
  })) })
  try { assert.ok(!text(view.toJSON()).includes('保存后会一并应用')) }
  finally { await act(async () => view.unmount()) }
})
