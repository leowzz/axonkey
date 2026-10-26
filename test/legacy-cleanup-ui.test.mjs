import assert from 'node:assert/strict'
import test from 'node:test'
import React from 'react'
import Renderer, { act } from 'react-test-renderer'
import { harness, text } from './helpers/driver-dialog-harness.mjs'

test('standalone cleanup blocks startup, retries failure, and requires a real Windows restart', async () => {
  let state = { status: 'required', message: '检测到 Interception', logPath: null }
  const commands = []
  let attempts = 0
  const h = harness(async command => {
    commands.push(command)
    if (command === 'get_legacy_cleanup') return state
    if (command === 'run_legacy_cleanup') {
      attempts++
      state = attempts === 1
        ? { status: 'failed', message: '管理员授权取消，请重试', logPath: 'cleanup.log' }
        : { status: 'rebootRequired', message: '请重启电脑后再打开 Axonkey', logPath: 'cleanup.log' }
    }
  })
  let mounted = 0
  function Child() { React.useEffect(() => { mounted++ }, []); return React.createElement('main', null, '后续启动流程') }
  let view
  await act(async () => { view = Renderer.create(React.createElement(h.LegacyCleanupFlow, null, React.createElement(Child)), { createNodeMock: h.nodeMock }) })
  const click = async () => act(async () => { await view.root.findByType('button').props.onClick() })
  try {
    assert.equal(mounted, 0)
    assert.match(text(view.toJSON()), /先卸载旧驱动/)
    assert.match(text(view.toJSON()), /uninstall-old-driver\.exe/)
    assert.doesNotMatch(text(view.toJSON()), /QuarborUniversal/)
    await click(); await h.tick()
    assert.match(text(view.toJSON()), /管理员授权取消/)
    await click(); await h.tick()
    assert.match(text(view.toJSON()), /请重启电脑/)
    assert.equal(mounted, 0)
    assert.equal(h.timers.size, 0)
    assert.equal(view.root.findAllByType('button').length, 1)
    assert.match(text(view.root.findByType('button')), /重新检测重启状态/)
    let prevented = false
    view.root.findByProps({ role: 'presentation' }).props.onKeyDown({ key: 'Escape', preventDefault() { prevented = true }, stopPropagation() {} })
    assert.equal(prevented, true)
    assert.equal(h.root.inert, true)
    await click()
    assert.equal(mounted, 0)
    assert.match(text(view.toJSON()), /请重启电脑/)
    state = { status: 'ready', message: '旧驱动已清理', logPath: null }
    await click()
    assert.equal(mounted, 1)
    assert.equal(commands.filter(c => c === 'run_legacy_cleanup').length, 2)
    assert.equal(commands.filter(c => c === 'check_legacy_cleanup').length, 2)
  } finally { act(() => view.unmount()) }
})

test('startup after uninstall still blocks when the backend reports no Windows restart', async () => {
  const h = harness(async () => ({ status: 'rebootRequired', message: 'Windows 尚未重启', logPath: null }))
  let view
  await act(async () => { view = Renderer.create(React.createElement(h.LegacyCleanupFlow, null, React.createElement('main')), { createNodeMock: h.nodeMock }) })
  try {
    assert.equal(view.root.findAllByType('main').length, 0)
    assert.match(text(view.toJSON()), /Windows 尚未重启/)
    assert.doesNotMatch(text(view.root.findByType('button')), /卸载|继续|关闭/)
  } finally { act(() => view.unmount()) }
})

test('manual settings entry uses the real checker and returns only when clear', async () => {
  const commands = []
  const h = harness(async command => {
    commands.push(command)
    if (command === 'get_legacy_cleanup') return { status: 'ready', message: '未检测到旧驱动', logPath: null }
  })
  let done = 0, view
  await act(async () => { view = Renderer.create(React.createElement(h.LegacyCleanupFlow, { onComplete: () => done++ }), { createNodeMock: h.nodeMock }) })
  try {
    assert.deepEqual(commands, ['check_legacy_cleanup', 'get_legacy_cleanup'])
    assert.match(text(view.toJSON()), /未检测到旧驱动/)
    act(() => view.root.findByType('button').props.onClick())
    assert.equal(done, 1)
  } finally { act(() => view.unmount()) }
})
