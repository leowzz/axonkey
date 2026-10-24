import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import vm from 'node:vm'
import ts from 'typescript'
import React from 'react'
import Renderer, { act } from 'react-test-renderer'

const require = createRequire(import.meta.url)
const text = node => typeof node === 'string' ? node : (node?.children ?? []).map(text).join('')

function renderDialog({ platform = 'windows', nativeRuntime = true, inert = false, overflow = 'auto' } = {}) {
  const root = { inert }
  const document = {
    body: { style: { overflow } },
    getElementById: id => id === 'root' ? root : null,
    querySelector: () => null,
  }
  class Element {
    isConnected = true
    focusCount = 0
    focus() { this.focusCount++; document.activeElement = this }
  }
  const previousFocus = new Element()
  const fallbackFocus = new Element()
  const buttons = [new Element(), new Element(), new Element()]
  document.querySelector = selector => selector === '.my-devices-integrate' ? fallbackFocus : null
  document.activeElement = previousFocus
  const source = ts.transpileModule(readFileSync('src/components/DeviceIntegrationDialog.tsx', 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020, jsx: ts.JsxEmit.ReactJSX },
  }).outputText
  const module = { exports: {} }
  vm.runInNewContext(source, {
    module, exports: module.exports, document, HTMLElement: Element, SVGElement: Element,
    require: name => name.endsWith('.css') ? {} : require(name),
  })
  const selected = []
  let closed = 0
  let view
  act(() => {
    view = Renderer.create(React.createElement(module.exports.DeviceIntegrationDialog, {
      platform, nativeRuntime,
      onSelect: deviceId => selected.push(deviceId),
      onClose: () => closed++,
    }), {
      createNodeMock: element => element.type === 'section' ? {
        querySelector: () => buttons[0],
        querySelectorAll: () => buttons,
        contains: element => buttons.includes(element),
      } : null,
    })
  })
  return {
    view, root, document, previousFocus, fallbackFocus, buttons, selected,
    get closed() { return closed },
    unmount() { act(() => view.unmount()) },
  }
}

function pressKey(backdrop, key, extra = {}) {
  let prevented = false
  let stopped = false
  act(() => backdrop.props.onKeyDown({
    key, ...extra,
    preventDefault() { prevented = true },
    stopPropagation() { stopped = true },
  }))
  return { prevented, stopped }
}

test('integration offers only supported input sources and delegates each selection once', () => {
  const dialog = renderDialog()
  try {
    const options = dialog.view.root.findAll(node => node.type === 'button' && node.props['data-device-id'])
    assert.deepEqual(options.map(node => node.props['data-device-id']), ['rc003', 'mouse'])
    assert.equal(dialog.view.root.findAllByType('button').length, 3)
    const content = text(dialog.view.toJSON())
    assert.ok(content.includes('RC003'))
    assert.ok(content.includes('蓝牙'))
    assert.ok(content.includes('设备集成'), 'Windows presents setup as device integration')
    assert.ok(content.includes('全部系统鼠标共用输入'))
    assert.ok(!content.includes('当前为浏览器预览'))
    assert.deepEqual(dialog.selected, [])
    for (const option of options) act(() => option.props.onClick())
    assert.deepEqual(dialog.selected, ['rc003', 'mouse'])
    assert.equal(dialog.closed, 0, 'the parent owns navigation and unmounting after selection')
  } finally { dialog.unmount() }
})

test('integration traps keyboard focus, closes through explicit dismissal and restores page state', () => {
  const dialog = renderDialog()
  try {
    const modal = dialog.view.root.findByProps({ role: 'dialog' })
    assert.equal(modal.props['aria-modal'], 'true')
    assert.ok(text(dialog.view.root.findByProps({ id: modal.props['aria-labelledby'] })).includes('集成设备'))
    assert.equal(dialog.root.inert, true)
    assert.equal(dialog.document.body.style.overflow, 'hidden')
    assert.equal(dialog.document.activeElement, dialog.buttons[0], 'initial focus goes to Close')
    const backdrop = dialog.view.root.findByProps({ role: 'presentation' })

    dialog.document.activeElement = dialog.buttons[2]
    assert.deepEqual(pressKey(backdrop, 'Tab'), { prevented: true, stopped: true })
    assert.equal(dialog.document.activeElement, dialog.buttons[0])
    assert.deepEqual(pressKey(backdrop, 'Tab', { shiftKey: true }), { prevented: true, stopped: true })
    assert.equal(dialog.document.activeElement, dialog.buttons[2])
    dialog.document.activeElement = dialog.buttons[1]
    assert.deepEqual(pressKey(backdrop, 'Tab'), { prevented: false, stopped: true })
    assert.deepEqual(pressKey(backdrop, 'z', { ctrlKey: true }), { prevented: false, stopped: true })
    dialog.document.activeElement = dialog.previousFocus
    assert.deepEqual(pressKey(backdrop, 'Tab'), { prevented: true, stopped: true })
    assert.equal(dialog.document.activeElement, dialog.buttons[0], 'escaped focus returns to the first control')
    dialog.document.activeElement = dialog.previousFocus
    assert.deepEqual(pressKey(backdrop, 'Tab', { shiftKey: true }), { prevented: true, stopped: true })
    assert.equal(dialog.document.activeElement, dialog.buttons[2], 'reverse tab returns to the last control')
    assert.equal(dialog.closed, 0)

    assert.deepEqual(pressKey(backdrop, 'Escape'), { prevented: true, stopped: true })
    assert.equal(dialog.closed, 1)
    const background = {}
    act(() => backdrop.props.onMouseDown({ target: {}, currentTarget: background }))
    assert.equal(dialog.closed, 1, 'clicking dialog content does not dismiss it')
    act(() => backdrop.props.onMouseDown({ target: background, currentTarget: background }))
    assert.equal(dialog.closed, 2)
    act(() => dialog.view.root.findByProps({ 'aria-label': '关闭集成设备' }).props.onClick())
    assert.equal(dialog.closed, 3)
    assert.deepEqual(dialog.selected, [], 'dismissal never selects an input source')
  } finally { dialog.unmount() }
  assert.equal(dialog.root.inert, false)
  assert.equal(dialog.document.body.style.overflow, 'auto')
  assert.equal(dialog.document.activeElement, dialog.previousFocus)
  assert.equal(dialog.previousFocus.focusCount, 1)
})

test('browser preview stays explicit and cleanup preserves an already locked page', () => {
  const dialog = renderDialog({ platform: 'unsupported', nativeRuntime: false, inert: true, overflow: 'clip' })
  try {
    assert.ok(text(dialog.view.toJSON()).includes('当前为浏览器预览'))
    assert.equal(dialog.root.inert, true)
    assert.equal(dialog.document.body.style.overflow, 'hidden')
    dialog.previousFocus.isConnected = false
  } finally { dialog.unmount() }
  assert.equal(dialog.root.inert, true)
  assert.equal(dialog.document.body.style.overflow, 'clip')
  assert.equal(dialog.previousFocus.focusCount, 0, 'navigation may remove the original trigger')
  assert.equal(dialog.document.activeElement, dialog.fallbackFocus)
})
