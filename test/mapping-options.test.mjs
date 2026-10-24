import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import vm from 'node:vm'
import ts from 'typescript'
import React from 'react'
import Renderer from 'react-test-renderer'

const require = createRequire(import.meta.url)
const source = ts.transpileModule(readFileSync(new URL('../src/components/MappingOptions.tsx', import.meta.url), 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX },
}).outputText

function mount({ audioCalibration } = {}) {
  const listeners = new Map()
  const module = { exports: {} }
  vm.runInNewContext(source, {
    module, exports: module.exports, require,
    document: {
      addEventListener: (type, listener) => listeners.set(type, listener),
      removeEventListener: (type, listener) => { if (listeners.get(type) === listener) listeners.delete(type) },
    },
  })
  const calls = []
  const inside = {}
  let focused = false
  const element = {
    open: true,
    contains: (target) => target === inside,
    querySelector: () => ({ focus: () => { focused = true } }),
  }
  let renderer
  Renderer.act(() => {
    renderer = Renderer.create(React.createElement(module.exports.MappingOptions, {
      onImport: () => calls.push('import'),
      onExport: () => calls.push('export'),
      onReset: () => calls.push('reset'),
      flowEditor: true,
      onFlowEditorChange: (enabled) => calls.push(enabled),
      audioCalibration: audioCalibration ? { disabled: audioCalibration === 'disabled', onOpen: () => calls.push('calibrate') } : undefined,
    }), { createNodeMock: (node) => node.type === 'details' ? element : null })
  })
  return {
    renderer, element, inside, listeners, calls,
    details: renderer.root.findByType('details'),
    focused: () => focused,
    unmount: () => Renderer.act(() => renderer.unmount()),
  }
}

test('unknown blur targets preserve the menu until buttons and checkbox receive their clicks', () => {
  const menu = mount()
  try {
    for (const button of menu.renderer.root.findAllByType('button')) {
      menu.details.props.onBlur({ currentTarget: menu.element, relatedTarget: null })
      assert.equal(menu.element.open, true)
      button.props.onClick()
    }
    menu.details.props.onBlur({ currentTarget: menu.element, relatedTarget: null })
    assert.equal(menu.element.open, true)
    menu.renderer.root.findByType('input').props.onChange({ target: { checked: false } })
    assert.deepEqual(menu.calls, ['import', 'export', 'reset', false])
  } finally { menu.unmount() }
})

test('pointer dismissal distinguishes inside and outside clicks and cleans up on unmount', () => {
  const menu = mount()
  try {
    menu.listeners.get('pointerdown')({ target: menu.inside })
    assert.equal(menu.element.open, true)
    menu.listeners.get('pointerdown')({ target: {} })
    assert.equal(menu.element.open, false)
  } finally { menu.unmount() }
  assert.equal(menu.listeners.size, 0)
})

test('keyboard focus can move within the menu and dismiss it when leaving', () => {
  const menu = mount()
  try {
    menu.details.props.onBlur({ currentTarget: menu.element, relatedTarget: menu.inside })
    assert.equal(menu.element.open, true)
    menu.details.props.onBlur({ currentTarget: menu.element, relatedTarget: {} })
    assert.equal(menu.element.open, false)
  } finally { menu.unmount() }
})

test('Escape dismisses the menu and restores focus to its trigger', () => {
  const menu = mount()
  try {
    menu.details.props.onKeyDown({ key: 'Enter', currentTarget: menu.element })
    assert.equal(menu.element.open, true)
    menu.details.props.onKeyDown({ key: 'Escape', currentTarget: menu.element })
    assert.equal(menu.element.open, false)
    assert.equal(menu.focused(), true)
  } finally { menu.unmount() }
})

test('audio calibration is absent without a supported device action and closes the menu when opened', () => {
  const plainMenu = mount()
  try {
    assert.equal(plainMenu.renderer.root.findAllByType('button').length, 3)
    assert.ok(!JSON.stringify(plainMenu.renderer.toJSON()).includes('校准音量'))
  } finally { plainMenu.unmount() }
  const remoteMenu = mount({ audioCalibration: 'enabled' })
  try {
    const calibration = remoteMenu.renderer.root.findAllByType('button').find(button => button.children.includes(' 校准音量'))
    assert.ok(calibration)
    assert.equal(calibration.props.disabled, false)
    calibration.props.onClick()
    assert.equal(remoteMenu.element.open, false)
    assert.deepEqual(remoteMenu.calls, ['calibrate'])
  } finally { remoteMenu.unmount() }
})

test('browser preview exposes disabled calibration without a native action handler', () => {
  const menu = mount({ audioCalibration: 'disabled' })
  try {
    const calibration = menu.renderer.root.findAllByType('button').find(button => button.children.includes(' 校准音量'))
    assert.equal(calibration.props.disabled, true)
    assert.equal(calibration.props.onClick, undefined)
    assert.match(calibration.props.title, /桌面应用/)
    assert.deepEqual(menu.calls, [])
  } finally { menu.unmount() }
})
