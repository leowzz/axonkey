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

test('Windows integration presents capabilities while preserving explicit install and uninstall actions', () => {
  const actions = []
  let continues = 0, view
  const state = setupModel.createDefaultSetupState()
  state.currentStep = 'inputDriver'
  state.device.status = 'disconnected'
  state.drivers.input.status = 'missing'
  state.drivers.audio.status = 'missing'
  const props = {
    platform: 'windows', macPermissions: {}, state,
    onDriverAction: (kind, action) => actions.push([kind, action]),
    onCompleteStep: () => continues++,
  }
  const button = label => view.root.findAllByType('button').find(node => text(node).trim() === label)
  const render = () => act(() => {
    const element = React.createElement(SetupDialog, props)
    if (view) view.update(element)
    else view = Renderer.create(element)
  })
  try {
    render()
    assert.equal(text(view.root.findByType('h2')), '完成遥控器集成')
    assert.deepEqual(view.root.findAllByType('h3').map(text), ['按键控制', '语音输入'])
    assert.deepEqual(actions, [])
    assert.equal(button('集成按键控制').props.disabled, true)
    assert.equal(button('启用语音输入').props.disabled, false)
    assert.equal(button('移除按键集成').props.disabled, false)
    assert.equal(button('完成按键集成后继续').props.disabled, true)
    assert.match(text(view.toJSON()), /管理员授权/)
    assert.match(text(view.toJSON()), /重新连接设备或重启 Windows/)
    assert.match(text(view.toJSON()), /执行该设备的卸载操作/)

    state.device.status = 'connected'
    render()
    assert.equal(button('集成按键控制').props.disabled, false)
    act(() => {
      button('集成按键控制').props.onClick()
      button('启用语音输入').props.onClick()
    })
    assert.deepEqual(actions, [['input', 'install'], ['audio', 'install']])

    state.drivers.input.status = 'installed'
    state.drivers.audio.status = 'installed'
    render()
    act(() => {
      button('移除按键集成').props.onClick()
      button('卸载语音输入支持').props.onClick()
      button('继续').props.onClick()
    })
    assert.deepEqual(actions.slice(2), [['input', 'uninstall'], ['audio', 'uninstall']])
    assert.equal(continues, 1)

    state.drivers.input.restartRequired = true
    state.drivers.input.status = 'restartRequired'
    render()
    assert.equal(button('继续，稍后重启').props.disabled, false)

    state.drivers.input.status = 'error'
    state.drivers.input.action = { kind: 'install', status: 'failed', error: 'Quarbor HID: ERROR_DEVICE_NOT_CONNECTED (1167)' }
    render()
    assert.match(text(view.toJSON()), /按键控制集成失败，请重试/)
    assert.match(text(view.toJSON()), /Quarbor HID: ERROR_DEVICE_NOT_CONNECTED \(1167\)/)
  } finally {
    act(() => view?.unmount())
  }
})

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

test('completed cleanup disables the action until reboot', () => {
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
    const button = view.root.findAllByType('button').find(node => text(node).includes('等待重启'))
    assert.ok(button)
    assert.equal(button.props.disabled, true)
    assert.match(text(view.toJSON()), /卸载已完成，请重启/)
  } finally {
    act(() => view?.unmount())
  }
})
