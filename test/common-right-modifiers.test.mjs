import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync, existsSync } from 'node:fs'
import { createRequire } from 'node:module'
import { resolve, dirname, extname } from 'node:path'
import vm from 'node:vm'
import ts from 'typescript'
import React from 'react'
import Renderer, { act } from 'react-test-renderer'

const require = createRequire(import.meta.url)
const cache = new Map()

function load(file) {
  file = resolve(file)
  if (cache.has(file)) return cache.get(file).exports
  const module = { exports: {} }
  cache.set(file, module)
  const source = ts.transpileModule(readFileSync(file, 'utf8'), { compilerOptions: {
    module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020, jsx: ts.JsxEmit.ReactJSX,
  } }).outputText
  const localRequire = name => {
    if (!name.startsWith('.')) return require(name)
    const path = resolve(dirname(file), name)
    if (extname(path)) return load(path)
    if (existsSync(`${path}.tsx`)) return load(`${path}.tsx`)
    return load(`${path}.ts`)
  }
  vm.runInNewContext(source, { module, exports: module.exports, require: localRequire, console }, { filename: file })
  return module.exports
}

const { BehaviorEditor } = load('src/components/BehaviorEditor.tsx')
const { keyDisplayName, rightModifierChoices, isRightModifierPreset, rightModifierKeys } = load('src/appConfig.tsx')

const button = { id: 'menu', label: '菜单', icon: 'menu' }
const text = node => typeof node === 'string' ? node : (node.children ?? []).map(text).join('')

function render(platform) {
  const applied = []
  let view
  act(() => {
    view = Renderer.create(React.createElement(BehaviorEditor, {
      editorRef: { current: null },
      attention: false,
      platform,
      button,
      trigger: 'click',
      behaviors: [],
      onApplyCommonBehavior: preset => applied.push(preset),
      onAddAdvancedBehavior: () => {},
      onRemoveBehavior: () => {},
      onMoveBehavior: () => {},
      onEditBehavior: () => {},
      onReturnToMappings: () => {},
    }))
  })
  return { view, applied }
}

function choiceButton(view, label) {
  const panel = view.root.findByProps({ id: 'behavior-menu-click-common-panel' })
  return panel.findAllByType('button').find(item => text(item).includes(label))
}

test('right modifier presets keep one key token and platform-specific names', () => {
  const names = (platform) => rightModifierChoices().map(item => keyDisplayName(item.key, platform)).join('|')
  assert.equal(rightModifierChoices().map(item => item.key).join('|'), 'RCtrl|RAlt|RWin')
  assert.equal(isRightModifierPreset('rightCommand'), true)
  assert.equal(isRightModifierPreset('escape'), false)
  assert.equal(isRightModifierPreset('toString'), false)
  assert.equal(rightModifierKeys.rightCommand, 'RWin')
  assert.equal(names('macos'), '右 Control|右 Option|右 Command')
  assert.equal(names('windows'), '右 Ctrl|右 Alt|右 Windows')
})

test('common behaviors offer the right-side modifiers with platform names', () => {
  const mac = render('macos')
  const windows = render('windows')
  try {
    for (const label of ['右 Control', '右 Option', '右 Command']) {
      assert.ok(choiceButton(mac.view, label), label)
    }
    assert.equal(choiceButton(mac.view, '右 Windows'), undefined)
    assert.equal(text(choiceButton(mac.view, '右 Command')), 'Cmd右 Command')

    for (const label of ['右 Ctrl', '右 Alt', '右 Windows']) {
      assert.ok(choiceButton(windows.view, label), label)
    }
    assert.equal(choiceButton(windows.view, '右 Command'), undefined)
    assert.equal(choiceButton(windows.view, '右 Option'), undefined)
    assert.equal(text(choiceButton(windows.view, '右 Windows')), 'Win右 Windows')
    assert.equal(text(choiceButton(windows.view, '右 Alt')), 'Alt右 Alt')

    act(() => choiceButton(mac.view, '右 Command').props.onClick())
    act(() => choiceButton(windows.view, '右 Windows').props.onClick())
    act(() => choiceButton(mac.view, '右 Option').props.onClick())
    act(() => choiceButton(windows.view, '右 Ctrl').props.onClick())
    assert.deepEqual(mac.applied, ['rightCommand', 'rightAlt'])
    assert.deepEqual(windows.applied, ['rightCommand', 'rightCtrl'])
  } finally {
    act(() => mac.view.unmount())
    act(() => windows.view.unmount())
  }
})
