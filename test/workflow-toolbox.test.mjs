import assert from 'node:assert/strict'
import test from 'node:test'
import React from 'react'
import Renderer, { act } from 'react-test-renderer'

import { libraryHarness } from './helpers/behavior-library-harness.mjs'

const { WorkflowToolbox } = libraryHarness().load('components/WorkflowToolbox.tsx')
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
const mainButton = item => item.findByProps({ className: 'workflow-toolbox-item-main' })
const toolboxActions = { onAddStep() {}, addLabel: '添加到单击', getStepPreview: item => [item.name] }
function render() {
  let view
  const drags = []
  function Harness() {
    const [selectedCategory, onCategoryChange] = React.useState('all')
    return React.createElement(WorkflowToolbox, { ...toolboxActions, palettes, iconUrls: {}, selectedCategory, onCategoryChange, api: { toolbox: { tryDrag: (...args) => drags.push(args) } } })
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
    act(() => mainButton(item).props.onMouseDown({ ...event, button: 2 }))
    assert.equal(drags.length, 0)
    act(() => mainButton(item).props.onMouseDown(event))
    assert.equal(drags[0][1], delay)
    assert.equal(drags[0][0].x, 120)
    assert.equal(drags[0][0].y, 240)
    act(() => mainButton(item).props.onTouchStart({ ...event, touches: [{ clientX: 30, clientY: 40 }] }))
    assert.equal(drags[1][1], delay)
    assert.equal(drags[1][0].x, 30)
    assert.equal(drags[1][0].y, 40)
  } finally { act(() => view.unmount()) }
})

test('saved items remain independently draggable and deleting one never starts a drag', () => {
  const saved = ['first', 'second'].map(id => ({ ...step('savedSequence', id), properties: { savedSequenceId: id, sequence: 'axonkey/1\nwait 30ms' } }))
  const removed = []
  const drags = []
  let view
  let category = 'all'
  const renderToolbox = () => React.createElement(WorkflowToolbox, {
    ...toolboxActions, palettes: [...palettes, { name: '已保存', groups: [{ name: '已保存', steps: saved }] }],
    iconUrls: {}, selectedCategory: category, onCategoryChange() {},
    onRemoveSavedSequence: id => removed.push(id), api: { toolbox: { tryDrag: (...args) => drags.push(args) } },
  })
  act(() => { view = Renderer.create(renderToolbox()) })
  try {
    const search = view.root.findByType('input')
    act(() => search.props.onChange({ target: { value: 'not-present' } }))
    assert.equal(items(view).length, 0)
    category = '已保存/已保存'
    act(() => view.update(renderToolbox()))
    assert.equal(search.props.value, '', 'saving while searching reveals the saved category')
    assert.equal(items(view).length, 2)
    const remove = view.root.findAllByType('button').find(node => node.props['aria-label'] === '删除已保存的first')
    act(() => remove.props.onClick())
    assert.deepEqual(removed, ['first'])
    assert.equal(drags.length, 0)
    act(() => mainButton(items(view)[1]).props.onMouseDown({ button: 0, clientX: 10, clientY: 20, preventDefault() {}, stopPropagation() {} }))
    assert.equal(drags[0][1], saved[1])
  } finally { act(() => view.unmount()) }
})


test('basic and my tabs isolate their searches and preserve the empty and failed library states', () => {
  const saved = { ...step('savedSequence', '我的发送序列'), properties: { savedSequenceId: 'mine' } }
  let view
  function Harness({ error = '', savedSteps = [saved] }) {
    const [selectedCategory, onCategoryChange] = React.useState('all')
    return React.createElement(WorkflowToolbox, { ...toolboxActions, palettes: [...palettes, { name: '已保存', groups: [{ name: '已保存', steps: savedSteps }] }], selectedCategory, onCategoryChange, savedError: error, iconUrls: {}, api: { toolbox: { tryDrag() {} } } })
  }
  act(() => { view = Renderer.create(React.createElement(Harness)) })
  try {
    const tabs = view.root.findByProps({ 'aria-label': '行为来源' })
    assert.deepEqual(tabs.findAllByType('button').map(text), ['基础', '我的'])
    const search = view.root.findByType('input')
    act(() => search.props.onChange({ target: { value: '我的发送序列' } }))
    assert.equal(items(view).length, 0)
    act(() => tabs.findAllByType('button')[1].props.onClick())
    assert.equal(search.props.value, '')
    assert.equal(items(view).length, 1)
    act(() => search.props.onChange({ target: { value: '300 毫秒' } }))
    assert.equal(items(view).length, 0, 'my search cannot leak built-in results')
    act(() => search.props.onChange({ target: { value: '' } }))
    act(() => view.update(React.createElement(Harness, { savedSteps: [] })))
    assert.equal(text(view.root.findByType('p')), '暂无已保存的行为序列')
    act(() => view.update(React.createElement(Harness, { error: '读取失败', savedSteps: [] })))
    assert.equal(text(view.root.findByProps({ role: 'alert' })), '读取失败')
    assert.equal(view.root.findAllByType('p').length, 1, 'failure does not also claim an empty library')
  } finally { act(() => view.unmount()) }
})

test('preview and add controls use the original palette action without starting a drag', () => {
  let view
  const added = [], drags = []
  act(() => { view = Renderer.create(React.createElement(WorkflowToolbox, { ...toolboxActions, palettes, selectedCategory: 'all', onCategoryChange() {}, iconUrls: {}, getStepPreview: item => ['预览：' + item.name], onAddStep: item => added.push(item), api: { toolbox: { tryDrag: (...args) => drags.push(args) } } })) })
  try {
    act(() => items(view)[0].findByProps({ className: 'workflow-toolbox-add' }).props.onClick())
    assert.equal(added[0], delay)
    assert.equal(drags.length, 0)
    act(() => mainButton(items(view)[0]).props.onClick({ detail: 0 }))
    const dialog = view.root.findByType('dialog')
    assert.equal(text(dialog.findByType('li')), '预览：等待')
    act(() => dialog.findAllByType('button').at(-1).props.onClick())
    assert.equal(added[1], delay)
    assert.equal(view.root.findAllByType('dialog').length, 0)
    assert.equal(drags.length, 0)
  } finally { act(() => view.unmount()) }
})
