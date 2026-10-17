import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import vm from 'node:vm'
import ts from 'typescript'
import React from 'react'
import Renderer, { act } from 'react-test-renderer'
import * as setupModel from '../src/setupModel.ts'

const require = createRequire(import.meta.url)
const module = { exports: {} }
vm.runInNewContext(ts.transpileModule(readFileSync('src/components/SetupDialog.tsx', 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX },
}).outputText, {
  module, exports: module.exports,
  require: name => name === '../setupModel' ? setupModel : require(name),
})
const { SetupDialog } = module.exports
const text = node => typeof node === 'string' ? node : (node.children ?? []).map(text).join('')

test('repair service alone shows migration, supports recheck, and blocks cleanup while checking', () => {
  let rechecks = 0
  let cleanups = 0
  let state = setupModel.setLegacyCleanupProbe(
    setupModel.skipSetup(setupModel.createDefaultSetupState()),
    { frida: false, interception: false, interceptionFix: true, namedPipeServer: false },
  )
  const props = {
    platform: 'windows', macPermissions: {}, onProbeLegacyCleanup: () => rechecks++, onCleanupLegacy: () => cleanups++,
  }
  let view
  const button = label => view.root.findAllByType('button').find(node => text(node).includes(label))
  const render = () => act(() => {
    const element = React.createElement(SetupDialog, { ...props, state })
    if (view) view.update(element)
    else view = Renderer.create(element)
  })
  try {
    render()
    assert.equal(view.root.findByType('h2').children.join(''), '先卸载旧驱动')
    const residuals = view.root.findAll(node => node.type === 'section' && node.props.className === 'legacy-cleanup-item present')
    assert.equal(residuals.length, 1)
    assert.match(text(residuals[0]), /AxonkeyInterceptionFix/)
    assert.equal(button('一键卸载旧组件').props.disabled, false)
    act(() => button('重新检测').props.onClick())
    assert.equal(rechecks, 1)
    act(() => button('一键卸载旧组件').props.onClick())
    assert.equal(cleanups, 1)

    state = setupModel.setLegacyCleanupProbe(state, state.legacyCleanup.components, { checking: true })
    render()
    assert.equal(button('一键卸载旧组件').props.disabled, true)
    assert.equal(button('检测中').props.disabled, true)

    state = setupModel.setLegacyCleanupProbe(state, state.legacyCleanup.components, { error: '工具不可用' })
    render()
    assert.match(text(view.toJSON()), /旧驱动检测失败/)
    assert.match(text(view.toJSON()), /工具不可用/)
    assert.equal(button('继续连接').props.disabled, true)
    assert.equal(button('重新检测').props.disabled, false)
  } finally {
    act(() => view?.unmount())
  }
})

test('completed cleanup can be run again without a reboot lock', () => {
  let state = setupModel.setLegacyCleanupProbe(
    setupModel.skipSetup(setupModel.createDefaultSetupState()),
    { frida: false, interception: false, interceptionFix: true, namedPipeServer: false },
  )
  state = setupModel.finishLegacyCleanup(state, { success: true, logPath: 'cleanup.log' })
  const props = {
    platform: 'windows', macPermissions: {}, state, onProbeLegacyCleanup: () => {}, onCleanupLegacy: () => {},
  }
  let view
  const render = () => act(() => {
    const element = React.createElement(SetupDialog, props)
    if (view) view.update(element)
    else view = Renderer.create(element)
  })
  try {
    render()
    const button = view.root.findAllByType('button').find(node => text(node).includes('一键卸载旧组件'))
    assert.equal(button.props.disabled, false)
    assert.doesNotMatch(text(view.toJSON()), /重启前不会再次执行卸载/)
  } finally {
    act(() => view?.unmount())
  }
})
