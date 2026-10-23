import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import vm from 'node:vm'
import ts from 'typescript'
import React from 'react'
import Renderer, { act } from 'react-test-renderer'
import * as geometry from '../src/remoteControlGeometry.ts'

const require = createRequire(import.meta.url)
const module = { exports: {} }
const remoteArtworkUrl = `data:image/svg+xml,${encodeURIComponent(readFileSync(new URL('../public/rc003-remote-keymap.svg', import.meta.url), 'utf8'))}`
const storage = new Map()
const testWindow = new EventTarget()
testWindow.localStorage = { getItem: key => storage.get(key), setItem: (key, value) => storage.set(key, value) }
const testDocument = Object.assign(new EventTarget(), { hidden: false })
test.beforeEach(() => { storage.clear(); testDocument.hidden = false })
const source = ts.transpileModule(readFileSync(new URL('../src/components/RemoteControl.tsx', import.meta.url), 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020, jsx: ts.JsxEmit.ReactJSX },
}).outputText
vm.runInNewContext(source, {
  module, exports: module.exports,
  window: testWindow, document: testDocument,
  require: name => name === '../remoteControlGeometry' ? geometry
    : name === '../../public/rc003-remote-keymap.svg?inline' ? { default: remoteArtworkUrl }
    : require(name),
})
const { RemoteControl } = module.exports
const buttons = Object.keys(geometry.remoteKeyRegions).map(id => ({ id, label: id }))
const keyboardEvent = (key, repeat = false) => ({ key, repeat, preventDefault() {}, stopPropagation() {} })

function mount(props = {}) {
  const selected = []
  let view
  act(() => { view = Renderer.create(React.createElement(RemoteControl, {
    buttons, activeId: 'confirm', pressedId: null, mappedIds: [], onSelect: id => selected.push(id), ...props,
  })) })
  const key = id => view.root.findByProps({ 'data-remote-key': id })
  return { view, key, selected }
}

test('each accessible SVG key selects its own input without activating its neighbours', () => {
  const { view, key, selected } = mount()
  for (const button of buttons) {
    assert.equal(key(button.id).props.role, 'button')
    assert.equal(key(button.id).props.tabIndex, 0)
    assert.equal(key(button.id).props['aria-label'], button.label)
    act(() => key(button.id).props.onClick())
  }
  assert.deepEqual(selected, buttons.map(button => button.id))
  act(() => view.unmount())
})

test('Enter activates once; Space waits for release, ignores repeats, and cancels on blur', () => {
  const { view, key, selected } = mount()
  act(() => {
    key('up').props.onKeyDown(keyboardEvent('Enter'))
    key('up').props.onKeyDown(keyboardEvent('Enter', true))
  })
  assert.match(key('up').props.className, /keyboard-pressed/)
  act(() => key('up').props.onKeyUp(keyboardEvent('Enter')))
  assert.doesNotMatch(key('up').props.className, /keyboard-pressed/)
  assert.deepEqual(selected, ['up'])
  act(() => {
    key('down').props.onKeyDown(keyboardEvent(' '))
    key('down').props.onKeyDown(keyboardEvent(' ', true))
  })
  assert.deepEqual(selected, ['up'])
  assert.match(key('down').props.className, /keyboard-pressed/)
  act(() => key('down').props.onKeyUp(keyboardEvent(' ')))
  assert.deepEqual(selected, ['up', 'down'])
  assert.doesNotMatch(key('down').props.className, /keyboard-pressed/)
  act(() => {
    key('voice').props.onKeyDown(keyboardEvent(' '))
    key('voice').props.onBlur()
    key('voice').props.onKeyUp(keyboardEvent(' '))
    key('home').props.onKeyDown(keyboardEvent('ArrowDown'))
  })
  assert.deepEqual(selected, ['up', 'down'])
  assert.doesNotMatch(key('voice').props.className, /keyboard-pressed/)
  act(() => view.unmount())
})

test('physical press feedback stays independent of selection and clears on release', () => {
  const props = { buttons, activeId: 'confirm', pressedId: 'voice', mappedIds: ['home'], onSelect() {} }
  const { view, key } = mount(props)
  assert.equal(key('confirm').props['aria-pressed'], true)
  assert.equal(key('voice').props['aria-pressed'], false)
  assert.match(key('voice').props.className, /\bpressed\b/)
  assert.match(key('home').props.className, /\bmapped\b/)
  act(() => view.update(React.createElement(RemoteControl, { ...props, pressedId: null })))
  assert.doesNotMatch(key('voice').props.className, /\bpressed\b/)
  assert.equal(key('confirm').props['aria-pressed'], true)
  act(() => view.unmount())
})

test('pointer and keyboard focus notify overview highlighting without selecting a key', () => {
  const highlighted = []
  const { view, key, selected } = mount({ onHover: id => highlighted.push(id) })
  act(() => {
    key('left').props.onPointerEnter()
    key('left').props.onPointerLeave()
    key('tv').props.onFocus()
    key('tv').props.onBlur()
  })
  assert.deepEqual(highlighted, ['left', null, 'tv', null])
  assert.deepEqual(selected, [])
  act(() => view.unmount())
})

test('primary pointer feedback clears on release, leaving the key, and cancellation without selecting', () => {
  const { view, key, selected } = mount()
  for (const event of [{ button: 2, isPrimary: true }, { button: 0, isPrimary: false }]) {
    act(() => key('home').props.onPointerDown(event))
    assert.doesNotMatch(key('home').props.className, /pointer-pressed/)
  }
  for (const release of ['onPointerUp', 'onPointerLeave', 'onPointerCancel']) {
    act(() => key('home').props.onPointerDown({ button: 0, isPrimary: true }))
    assert.match(key('home').props.className, /pointer-pressed/)
    act(() => key('home').props[release]())
    assert.doesNotMatch(key('home').props.className, /pointer-pressed/)
  }
  assert.deepEqual(selected, [])
  act(() => view.unmount())
})

test('window blur and hiding the page cancel held keys without a later Space activation', () => {
  const { view, key, selected } = mount()
  for (const cancel of [
    () => testWindow.dispatchEvent(new Event('blur')),
    () => { testDocument.hidden = true; testDocument.dispatchEvent(new Event('visibilitychange')) },
  ]) {
    act(() => {
      key('home').props.onPointerDown({ button: 0, isPrimary: true })
      key('voice').props.onKeyDown(keyboardEvent(' '))
    })
    act(cancel)
    assert.doesNotMatch(key('home').props.className, /pointer-pressed/)
    assert.doesNotMatch(key('voice').props.className, /keyboard-pressed/)
    act(() => key('voice').props.onKeyUp(keyboardEvent(' ')))
  }
  assert.deepEqual(selected, [])
  act(() => view.unmount())
})

test('the first-use hint stays dismissed when switching between remote views', () => {
  const first = mount()
  assert.equal(first.view.root.findByProps({ className: 'remote-control-hint' }).props['aria-hidden'], false)
  act(() => first.key('home').props.onClick())
  assert.equal(first.view.root.findByProps({ className: 'remote-control-hint dismissed' }).props['aria-hidden'], true)
  act(() => first.view.unmount())
  const second = mount()
  assert.equal(second.view.root.findByProps({ className: 'remote-control-hint dismissed' }).props['aria-hidden'], true)
  act(() => second.view.unmount())
})

test('unavailable browser storage does not prevent key selection or dismissing the hint', () => {
  const localStorage = testWindow.localStorage
  testWindow.localStorage = {
    getItem() { throw new Error('storage unavailable') },
    setItem() { throw new Error('storage unavailable') },
  }
  let mounted
  try {
    mounted = mount()
    act(() => mounted.key('home').props.onClick())
    assert.deepEqual(mounted.selected, ['home'])
    assert.equal(mounted.view.root.findByProps({ className: 'remote-control-hint dismissed' }).props['aria-hidden'], true)
  } finally {
    if (mounted) act(() => mounted.view.unmount())
    testWindow.localStorage = localStorage
  }
})
