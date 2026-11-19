import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync, existsSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, extname, resolve } from 'node:path'
import vm from 'node:vm'
import ts from 'typescript'
import React from 'react'
import Renderer, { act } from 'react-test-renderer'

const require = createRequire(import.meta.url)
const cache = new Map()
const root = { inert: false }
let activeElement = null
const document = { body: { style: { overflow: '' } }, getElementById: () => root,
  get activeElement() { return activeElement }, querySelector: () => null }
class Element { isConnected = true; focus() { activeElement = this }; getClientRects() { return [{}] } }
function load(file) {
  file = resolve(file)
  if (cache.has(file)) return cache.get(file).exports
  const module = { exports: {} }
  cache.set(file, module)
  const source = ts.transpileModule(readFileSync(file, 'utf8'), { compilerOptions: {
    module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020, jsx: ts.JsxEmit.ReactJSX,
  } }).outputText
  vm.runInNewContext(source, { module, exports: module.exports, document, console,
    window: { addEventListener() {}, removeEventListener() {} }, navigator: {}, crypto, URL, setTimeout, clearTimeout,
    HTMLElement: Element, SVGElement: Element, CSS: { escape: value => value },
    require(name) {
      if (name.endsWith('.css')) return {}
      if (name === 'react-dom') return { createPortal: node => node }
      if (!name.startsWith('.')) return require(name)
      const path = resolve(dirname(file), name)
      return load(extname(path) ? path : existsSync(path + '.tsx') ? path + '.tsx' : path + '.ts')
    },
  }, { filename: file })
  return module.exports
}
const { LegacyMappingEditor } = load('src/components/LegacyMappingEditor.tsx')
const { BehaviorEditor, BehaviorEditDialog, SequencePasteDialog, TextInputPresetDialog } = load('src/components/BehaviorEditor.tsx')
const { WorkflowStepDialog } = load('src/components/WorkflowStepDialog.tsx')
const { SettingsPage } = load('src/components/SettingsPage.tsx')
const copy = value => JSON.parse(JSON.stringify(value))

test('settings exposes a labelled native editor selector and reports both editor choices', () => {
  let view
  const changed = []
  const driver = { status: 'missing', action: { status: 'idle' } }
  act(() => { view = Renderer.create(React.createElement(SettingsPage, {
    section: 'remote', platform: 'windows', nativeRuntime: false, permissions: {}, inputDriver: driver,
    audioDriver: driver, backup: {}, mappingStyle: 'legacy', onMappingStyleChange: style => changed.push(style),
  })) })
  try {
    const select = view.root.findByProps({ id: 'settings-mapping-editor' }).findByType('select')
    assert.equal(select.props.value, 'legacy')
    assert.equal(view.root.findByProps({ htmlFor: select.props.id }).type, 'label')
    assert.deepEqual(select.findAllByType('option').map(option => option.props.value), ['flow', 'legacy'])
    act(() => select.props.onChange({ target: { value: 'flow' } }))
    assert.deepEqual(changed, ['flow'])
  } finally { act(() => view.unmount()) }
})

function legacyHarness() {
  let view, sequences = { click: [{ id: 'initial', type: 'key', enabled: true, key: 'A' }], doubleClick: [], longPress: [] }
  const writes = [], requests = []
  const render = () => React.createElement(LegacyMappingEditor, {
    platform: 'windows', button: { id: 'device-custom-id', label: '语音键', icon: 'mic' }, sequences,
    onRequestProfileSwitch: (...args) => requests.push(args),
    onChange: (id, next) => { writes.push([id, copy(next)]); sequences = next; view.update(render()) },
  })
  act(() => { view = Renderer.create(render(), { createNodeMock: () => ({
    contains: () => false, querySelector: () => null, querySelectorAll: () => [],
  }) }) })
  return { view, writes, requests, editor: () => view.root.findByType(BehaviorEditor),
    sequences: () => copy(sequences), unmount: () => act(() => view.unmount()) }
}

test('legacy device editor adds, edits, reorders and removes real behaviors while preserving other triggers', () => {
  const app = legacyHarness()
  try {
    act(() => app.view.root.findByType('select').props.onChange({ target: { value: 'longPress' } }))
    act(() => app.editor().props.onApplyCommonBehavior('rightCtrl'))
    assert.equal(app.sequences().longPress[0].key, 'RCtrl')
    assert.equal(app.sequences().click[0].key, 'A')
    assert.equal(app.writes[0][0], 'device-custom-id')
    act(() => app.editor().props.onAddAdvancedBehavior('paste'))
    let dialog = app.view.root.findByType(WorkflowStepDialog)
    assert.equal(app.sequences().longPress.length, 1, 'incomplete text stays local')
    act(() => dialog.props.edit.onSave({ ...dialog.props.edit.behavior, text: '你好' }))
    const textId = app.sequences().longPress[1].id
    act(() => app.editor().props.onEditBehavior(textId))
    dialog = app.view.root.findByType(WorkflowStepDialog)
    act(() => dialog.props.edit.onSave({ ...dialog.props.edit.behavior, text: '修改' }))
    act(() => app.editor().props.onMoveBehavior(textId, -1))
    assert.equal(app.sequences().longPress[0].text, '修改')
    act(() => app.editor().props.onRemoveBehavior(textId))
    assert.equal(app.sequences().longPress.length, 1)
    assert.equal(app.sequences().click[0].key, 'A')
    act(() => app.editor().props.onApplyCommonBehavior('textAndEnter'))
    dialog = app.view.root.findByType(WorkflowStepDialog)
    act(() => dialog.props.edit.onSave({ ...dialog.props.edit.behavior, text: '发送' }))
    assert.deepEqual(app.sequences().longPress.map(item => item.type), ['paste', 'delay', 'key'])
    assert.equal(app.sequences().longPress[2].key, 'Enter')
  } finally { app.unmount() }
})

test('workflow shortcut dialog starts in navigation mode, traps Tab, cancels capture with Escape and restores focus', () => {
  const previous = new Element(), first = new Element(), last = new Element()
  activeElement = previous
  let closed = 0, view
  const controls = [first, last]
  const edit = { stepId: 'shortcut', trigger: 'click', behavior: { id: 'shortcut', type: 'shortcut', keys: [], enabled: true }, onSave() {} }
  act(() => { view = Renderer.create(React.createElement(WorkflowStepDialog, {
    edit, platform: 'windows', button: { id: 'power', label: '电源' }, onClose: () => closed++,
  }), { createNodeMock: node => node.type === 'div' && node.props.className?.includes('workflow-step-editor') ? {
    contains: element => controls.includes(element), querySelector: () => first, querySelectorAll: () => controls,
  } : null }) })
  try {
    assert.equal(root.inert, true)
    assert.equal(activeElement, first)
    let form = view.root.findByType(BehaviorEditDialog)
    assert.equal(form.props.capturing, false)
    assert.equal(form.props.autoCapture, false)
    const wrapper = view.root.findByProps({ className: 'mapping-active workflow-step-editor' })
    const event = { preventDefault() {}, stopPropagation() {} }
    activeElement = last
    act(() => wrapper.props.onKeyDownCapture({ ...event, key: 'Tab' }))
    assert.equal(activeElement, first)
    act(() => wrapper.props.onKeyDownCapture({ ...event, key: 'Tab', shiftKey: true }))
    assert.equal(activeElement, last)
    act(() => form.props.onStartCapture())
    assert.equal(view.root.findByType(BehaviorEditDialog).props.capturing, true)
    act(() => wrapper.props.onKeyDownCapture({ ...event, key: 'Escape' }))
    assert.equal(view.root.findByType(BehaviorEditDialog).props.capturing, false)
    assert.equal(closed, 0)
    act(() => wrapper.props.onKeyDownCapture({ ...event, key: 'Escape' }))
    assert.equal(closed, 1)
  } finally { act(() => view.unmount()) }
  assert.equal(root.inert, false)
  assert.equal(activeElement, previous)
})

test('text dialogs restore their opener even when a child autofocuses during mounting', () => {
  const button = { id: 'power', label: '电源' }
  for (const [Component, props] of [
    [WorkflowStepDialog, { edit: { stepId: 'text', trigger: 'click', behavior: { id: 'text', type: 'paste', text: '文字', enabled: true }, onSave() {} } }],
    [BehaviorEditDialog, { autoCapture: false, behavior: { id: 'text', type: 'paste', text: '文字', enabled: true }, draft: true, onUpdate() {} }],
    [SequencePasteDialog, {}],
    [TextInputPresetDialog, { value: '', onChange() {}, onSave() {} }],
  ]) {
    const previous = new Element(), first = new Element(), last = new Element(), hidden = new Element()
    hidden.getClientRects = () => []
    const controls = [first, last, hidden]
    activeElement = previous
    let view
    act(() => { view = Renderer.create(React.createElement(Component, {
      platform: 'windows', button, trigger: 'click', onClose() {}, ...props,
    }), { createNodeMock: node => {
      if (node.type === 'textarea') { activeElement = last; return last }
      return { contains: element => controls.includes(element), querySelector: () => first, querySelectorAll: () => controls }
    } }) })
    try {
      assert.equal(root.inert, true)
      const container = view.root.findAll(node => typeof node.props.onKeyDownCapture === 'function' || typeof node.props.onKeyDown === 'function')[0]
      activeElement = last
      act(() => (container.props.onKeyDownCapture ?? container.props.onKeyDown)({ key: 'Tab', preventDefault() {} }))
      assert.equal(activeElement, first, Component.name)
    } finally { act(() => view.unmount()) }
    assert.equal(root.inert, false)
    assert.equal(activeElement, previous, Component.name)
  }
})

test('inline and modal editors keep independent accessible field labels', () => {
  for (const [behavior, fieldLabel] of [
    [{ type: 'paste', text: '内容' }, '文本内容'],
    [{ type: 'openWebsite', url: 'https://example.com' }, '网站地址'],
    [{ type: 'delay', ms: 300 }, '等待时间'],
    [{ type: 'cursorMove', direction: 'up', distance: 50 }, '移动距离'],
    [{ type: 'quickOverlay', profileId: '' }, '关联配置：'],
  ]) {
    let view
    act(() => { view = Renderer.create(React.createElement(React.Fragment, null, ...[true, false].map(inline => React.createElement(BehaviorEditDialog, {
      key: String(inline), inline, platform: 'windows', button: { id: 'power', label: '电源' }, trigger: 'click',
      behavior: { id: 'test', enabled: true, ...behavior }, autoCapture: false, onClose() {},
    })))) })
    try {
      const labels = view.root.findAll(node => node.type === 'label' && node.children.join('') === fieldLabel)
      assert.equal(labels.length, 2)
      assert.notEqual(labels[0].props.htmlFor, labels[1].props.htmlFor)
      for (const label of labels) assert.equal(view.root.findAll(node => typeof node.type === 'string' && node.props.id === label.props.htmlFor).length, 1)
    } finally { act(() => view.unmount()) }
  }
})
