import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import vm from 'node:vm'
import ts from 'typescript'
import React from 'react'
import Renderer, { act } from 'react-test-renderer'

const require = createRequire(import.meta.url)
const module = { exports: {} }
const source = ts.transpileModule(readFileSync('src/components/WorkflowToolbox.tsx', 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020, jsx: ts.JsxEmit.ReactJSX },
}).outputText
vm.runInNewContext(source, { require, module, exports: module.exports })
const { WorkflowToolbox } = module.exports
const step = (type, name, description = '') => ({ type, name, componentType: 'task', properties: { description } })
const delay = step('delay', '等待', '300 毫秒')
const key = step('key', '组合键', 'Ctrl Enter')
const paste = step('paste', '粘贴文本', '发送消息')
const palettes = [
  { name: '基础', groups: [{ name: '控制', steps: [delay, paste] }, { name: '键盘', steps: [key] }] },
  { name: '常用', groups: [{ name: '聊天预置', steps: [step('send', '发送', 'Enter')] }] },
]
const text = node => typeof node === 'string' ? node : (node.children ?? []).map(text).join('')
const items = view => view.root.findAll(node => node.type === 'div' && node.props.className?.startsWith('sqd-toolbox-item '))
function render() {
  let view
  const drags = []
  function Harness() {
    const [selectedCategory, onCategoryChange] = React.useState('all')
    return React.createElement(WorkflowToolbox, { palettes, iconUrls: {}, selectedCategory, onCategoryChange, api: { toolbox: { tryDrag: (...args) => drags.push(args) } } })
  }
  act(() => { view = Renderer.create(React.createElement(Harness)) })
  return { view, drags }
}

test('category filtering and global search retain the selected category when the query is cleared', () => {
  const { view } = render()
  try {
    assert.equal(items(view).length, 4)
    const keyboard = view.root.findAllByType('button').find(node => text(node) === '键盘')
    act(() => keyboard.props.onClick())
    assert.equal(items(view).length, 1)
    assert.equal(keyboard.props['aria-pressed'], true)
    const search = view.root.findByType('input')
    act(() => search.props.onChange({ target: { value: '发送' } }))
    assert.equal(items(view).length, 2, 'search matches descriptions and names outside the current category')
    assert.equal(keyboard.props['aria-pressed'], false)
    act(() => search.props.onChange({ target: { value: '' } }))
    assert.equal(items(view).length, 1)
    assert.equal(keyboard.props['aria-pressed'], true)
    act(() => search.props.onChange({ target: { value: 'not-present' } }))
    assert.equal(items(view).length, 0)
    assert.equal(text(view.root.findByType('p')), '没有匹配的行为')
    act(() => keyboard.props.onClick())
    assert.equal(search.props.value, '')
    assert.equal(items(view).length, 1)
  } finally { act(() => view.unmount()) }
})

test('filtered palette items pass their original definition and pointer position to the designer', () => {
  const { view, drags } = render()
  try {
    const item = items(view)[0]
    const event = { button: 0, clientX: 120, clientY: 240, preventDefault() {}, stopPropagation() {} }
    act(() => item.props.onMouseDown({ ...event, button: 2 }))
    assert.equal(drags.length, 0)
    act(() => item.props.onMouseDown(event))
    assert.equal(drags[0][1], delay)
    assert.equal(drags[0][0].x, 120)
    assert.equal(drags[0][0].y, 240)
    act(() => item.props.onTouchStart({ ...event, touches: [{ clientX: 30, clientY: 40 }] }))
    assert.equal(drags[1][1], delay)
    assert.equal(drags[1][0].x, 30)
    assert.equal(drags[1][0].y, 40)
  } finally { act(() => view.unmount()) }
})
