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

test('shared deletion uses an ordinary confirmation, previews every affected location and supports cancel, focus and explicit confirmation', () => {
  const root = { inert: false }
  const document = { body: { style: { overflow: 'auto' } }, getElementById: () => root }
  class Element {
    isConnected = true
    focus() { document.activeElement = this }
  }
  const previousFocus = new Element()
  document.activeElement = previousFocus
  const buttons = [new Element(), new Element(), new Element()]
  const source = ts.transpileModule(readFileSync('src/components/ProfileSwitchDeleteDialog.tsx', 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020, jsx: ts.JsxEmit.ReactJSX },
  }).outputText
  const module = { exports: {} }
  vm.runInNewContext(source, {
    module, exports: module.exports, document, HTMLElement: Element, SVGElement: Element,
    require: name => name === '../appConfig' ? { triggerLabels: { click: '单击', doubleClick: '双击', longPress: '长按' } } : require(name),
  })
  let canceled = 0
  let confirmed = 0
  let view
  act(() => { view = Renderer.create(React.createElement(module.exports.ProfileSwitchDeleteDialog, {
    button: { id: 'tv', label: '电视键' },
    targets: [
      { trigger: 'click', profiles: [{ id: 'a', name: '工作' }, { id: 'b', name: '游戏' }] },
      { trigger: 'longPress', profiles: [{ id: 'a', name: '工作' }, { id: 'c', name: '阅读' }] },
    ],
    onCancel: () => canceled++, onConfirm: () => confirmed++,
  }), { createNodeMock: element => element.type === 'section' ? {
    querySelector: () => buttons[1], querySelectorAll: () => buttons,
  } : null }) })
  try {
    const content = text(view.toJSON())
    for (const expected of ['删除切换配置文件行为', '同步删除', '电视键 · 单击', '电视键 · 长按', '工作、游戏', '工作、阅读']) assert.ok(content.includes(expected), expected)
    const confirm = view.root.findAllByType('button').find(node => text(node) === '确认删除')
    assert.equal(confirm.props.className, 'button primary')
    assert.equal(view.root.findByProps({ role: 'dialog' }).props['aria-modal'], 'true')
    assert.equal(confirmed, 0)
    assert.equal(root.inert, true)
    assert.equal(document.body.style.overflow, 'hidden')
    assert.equal(document.activeElement, buttons[1], 'initial focus goes to Cancel')
    const backdrop = view.root.findByProps({ role: 'presentation' })
    document.activeElement = buttons[2]
    let prevented = false
    let stopped = false
    act(() => backdrop.props.onKeyDown({ key: 'Tab', preventDefault() { prevented = true }, stopPropagation() { stopped = true } }))
    assert.equal(prevented, true)
    assert.equal(stopped, true)
    assert.equal(document.activeElement, buttons[0], 'Tab stays inside the dialog')
    act(() => backdrop.props.onKeyDown({ key: 'Escape', preventDefault() {}, stopPropagation() {} }))
    assert.equal(canceled, 1)
    assert.equal(confirmed, 0)
    stopped = false
    act(() => backdrop.props.onKeyDown({ key: 'z', ctrlKey: true, stopPropagation() { stopped = true } }))
    assert.equal(stopped, true, 'history shortcuts cannot edit the background while confirmation is open')
    act(() => confirm.props.onClick())
    assert.equal(confirmed, 1)
  } finally { act(() => view.unmount()) }
  assert.equal(root.inert, false)
  assert.equal(document.body.style.overflow, 'auto')
  assert.equal(document.activeElement, previousFocus)
})
