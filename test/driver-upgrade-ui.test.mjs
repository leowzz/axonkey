import assert from 'node:assert/strict'
import test from 'node:test'
import React from 'react'
import Renderer, { act } from 'react-test-renderer'

import { harness, text } from './helpers/driver-dialog-harness.mjs'

const state = { status: 'required', message: '发现旧驱动', devices: ['设备 A'], rebootRequired: false, logPath: null }

test('migration never offers dismissal, including errors, and traps keyboard focus', () => {
  const h = harness()
  let retries = 0
  let view
  const render = status => act(() => {
    const element = React.createElement(h.DriverMigrationDialog, { state: { ...state, status }, onRetry: () => retries++ })
    if (view) view.update(element)
    else view = Renderer.create(element, { createNodeMock: h.nodeMock })
  })
  try {
    for (const status of ['required', 'running', 'failed']) {
      render(status)
      assert.equal(h.root.inert, true)
      assert.equal(h.document.body.style.overflow, 'hidden')
      const buttons = view.root.findAllByType('button')
      assert.equal(buttons.length, status === 'running' ? 0 : 1)
      if (status !== 'running') act(() => buttons[0].props.onClick())
      const handler = view.root.findByProps({ role: 'presentation' }).props.onKeyDown
      let prevented = false
      handler({ key: 'Escape', preventDefault() { prevented = true }, stopPropagation() {} })
      assert.equal(prevented, true)
      h.document.activeElement = h.action
      handler({ key: 'Tab', shiftKey: false, preventDefault() {}, stopPropagation() {} })
      assert.equal(h.document.activeElement, h.summary)
      assert.match(text(view.toJSON()), /升级完成前无法关闭此窗口/)
    }
    assert.equal(retries, 2)
  } finally { act(() => view.unmount()) }
  assert.equal(h.root.inert, false)
  assert.equal(h.document.body.style.overflow, 'auto')
  assert.equal(h.document.activeElement, h.previous)
})

test('startup keeps children unmounted until native migration is ready; polling never triggers a scan or install', async () => {
  let reply = { ...state, status: 'checking' }
  const calls = []
  const h = harness(async command => { calls.push(command); return reply })
  let mounted = 0
  function Child() { React.useEffect(() => { mounted++ }, []); return React.createElement('main', null, '设备工作区') }
  let view
  await act(async () => { view = Renderer.create(React.createElement(h.DriverMigrationFlow, null, React.createElement(Child)), { createNodeMock: h.nodeMock }) })
  try {
    assert.equal(mounted, 0)
    assert.equal(view.toJSON(), null)
    assert.equal(h.root.inert, false)
    reply = state
    await h.tick()
    assert.match(text(view.toJSON()), /开始升级/)
    reply = { ...state, status: 'failed', message: '授权取消' }
    await h.tick()
    assert.equal(mounted, 0)
    assert.match(text(view.toJSON()), /授权取消/)
    reply = { ...state, status: 'ready' }
    await h.tick()
    assert.equal(mounted, 1)
    assert.match(text(view.toJSON()), /设备工作区/)
    assert(calls.every(command => command === 'get_driver_migration'))
    assert.equal(h.timers.size, 0)
  } finally { act(() => view.unmount()) }
})

test('clean startup stays silent throughout checking and opens the workspace directly', async () => {
  for (const kind of ['migration', 'legacyCleanup']) {
    let reply = { ...state, status: 'checking' }
    const h = harness(async () => reply)
    let view
    await act(async () => { view = Renderer.create(React.createElement(h.DriverMigrationFlow, { kind }, React.createElement('main', null, '正常启动')), { createNodeMock: h.nodeMock }) })
    try {
      assert.equal(view.toJSON(), null)
      await h.tick()
      assert.equal(view.toJSON(), null)
      assert.equal(h.root.inert, false)
      reply = { ...state, status: 'ready' }
      await h.tick()
      assert.match(text(view.toJSON()), /正常启动/)
      assert.equal(view.root.findAllByProps({ role: 'dialog' }).length, 0)
    } finally { act(() => view.unmount()) }
  }
})

test('non-Windows native reply bypasses migration', async () => {
  const h = harness()
  let view
  await act(async () => { view = Renderer.create(React.createElement(h.DriverMigrationFlow, null, React.createElement('main', null, '正常启动')), { createNodeMock: h.nodeMock }) })
  assert.match(text(view.toJSON()), /正常启动/)
  act(() => view.unmount())
})

test('manual entry checks real state and uses the same native upgrade command for install and retry', async () => {
  const commands = []
  let reply = state
  let attempts = 0
  const h = harness(async command => {
    commands.push(command)
    if (command === 'run_driver_migration') {
      attempts++
      reply = { ...state, status: attempts === 1 ? 'failed' : 'ready', message: attempts === 1 ? '安装器授权取消' : '升级完成' }
      return
    }
    if (command === 'get_driver_migration') return reply
  })
  let completed = 0
  let view
  await act(async () => { view = Renderer.create(React.createElement(h.DriverMigrationFlow, { onComplete: () => completed++ }), { createNodeMock: h.nodeMock }) })
  try {
    assert.deepEqual(commands, ['check_driver_migration', 'get_driver_migration'])
    assert.match(text(view.toJSON()), /开始升级/)
    await act(async () => { await view.root.findByType('button').props.onClick() })
    await h.tick()
    assert.match(text(view.toJSON()), /安装器授权取消/)
    assert.match(text(view.toJSON()), /重试/)
    await act(async () => { await view.root.findByType('button').props.onClick() })
    await h.tick()
    assert.match(text(view.toJSON()), /升级完成/)
    act(() => view.root.findByType('button').props.onClick())
    assert.equal(completed, 1)
    assert.equal(commands.filter(command => command === 'run_driver_migration').length, 2)
    assert.equal(commands.filter(command => command === 'check_driver_migration').length, 1)
  } finally { act(() => view.unmount()) }
})

test('manual entry with no old driver shows the native result without uninstalling anything', async () => {
  const commands = []
  const h = harness(async command => {
    commands.push(command)
    return command === 'get_driver_migration' ? { ...state, status: 'ready', devices: [], message: '无待迁移设备' } : undefined
  })
  let completed = 0
  let view
  await act(async () => { view = Renderer.create(React.createElement(h.DriverMigrationFlow, { onComplete: () => completed++ }), { createNodeMock: h.nodeMock }) })
  try {
    assert.match(text(view.toJSON()), /无待迁移设备/)
    assert.deepEqual(commands, ['check_driver_migration', 'get_driver_migration'])
    act(() => view.root.findByType('button').props.onClick())
    assert.equal(completed, 1)
  } finally { act(() => view.unmount()) }
})
