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
const testWindow = { devicePixelRatio: 2 }
const dropListeners = new Set()

function load(file) {
  file = resolve(file)
  if (cache.has(file)) return cache.get(file).exports
  const module = { exports: {} }
  cache.set(file, module)
  const source = ts.transpileModule(readFileSync(file, 'utf8'), { compilerOptions: {
    module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020, jsx: ts.JsxEmit.ReactJSX,
  } }).outputText
  const localRequire = name => {
    if (name === '@tauri-apps/api/webviewWindow') return {
      getCurrentWebviewWindow: () => ({
        onDragDropEvent: callback => {
          dropListeners.add(callback)
          return Promise.resolve(() => dropListeners.delete(callback))
        },
      }),
    }
    if (!name.startsWith('.')) return require(name)
    const path = resolve(dirname(file), name)
    if (extname(path)) return load(path)
    if (existsSync(`${path}.tsx`)) return load(`${path}.tsx`)
    return load(`${path}.ts`)
  }
  vm.runInNewContext(source, { module, exports: module.exports, require: localRequire, console, URL, setTimeout, clearTimeout, window: testWindow }, { filename: file })
  return module.exports
}

const { BehaviorEditor, BehaviorEditDialog } = load('src/components/BehaviorEditor.tsx')
const { normalizeBehavior } = load('src/behaviorModel.ts')
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

function renderDialog(platform, initial, draft = true) {
  let behavior = initial
  let view
  const props = {
    platform, button, trigger: 'click', capturing: false, draft,
    onStartCapture() {}, onCancelCapture() {}, onCaptureKey() {}, onClose() {}, onSave() {},
    onUpdate(update) {
      behavior = update(behavior)
      view.update(React.createElement(BehaviorEditDialog, { ...props, behavior }))
    },
  }
  act(() => { view = Renderer.create(React.createElement(BehaviorEditDialog, { ...props, behavior }), {
    createNodeMock: element => element.type === 'section' ? { getBoundingClientRect: () => ({ left: 100, right: 700, top: 100, bottom: 500 }) } : null,
  }) })
  return {
    view,
    behavior: () => JSON.parse(JSON.stringify(behavior)),
    select: value => act(() => view.root.findByProps({ 'aria-label': '选择主按键或单独修饰键' }).props.onChange({ target: { value } })),
    side: (modifier, value) => act(() => view.root.findByProps({ 'aria-label': `${keyDisplayName(modifier, platform)} 左右侧` }).props.onChange({ target: { value } })),
    toggle: label => act(() => view.root.findAllByType('button').find(node => text(node) === label).props.onClick()),
    save: () => view.root.findAllByType('button').find(node => text(node) === '保存'),
  }
}

test('launch dialogs validate drafts and retain existing targets during incomplete edits', () => {
  for (const [type, field, target, invalid] of [
    ['openApp', 'path', 'C:\\Program Files\\Tool.exe', 'relative.exe'],
    ['openWebsite', 'url', 'https://example.com/', 'javascript:alert(1)'],
  ]) {
    const initial = { id: 'launch', enabled: true, type, [field]: target }
    const draft = renderDialog('windows', { ...initial, [field]: '' })
    const existing = renderDialog('windows', initial, false)
    const change = (dialog, value) => act(() => dialog.view.root.findByProps({ id: 'behavior-launch-target' }).props.onChange({ target: { value } }))
    try {
      assert.equal(draft.save().props.disabled, true)
      change(draft, invalid)
      assert.equal(draft.save().props.disabled, true)
      assert.ok(draft.view.root.findByProps({ role: 'alert' }))
      change(draft, target)
      assert.equal(draft.save().props.disabled, false)
      assert.equal(draft.behavior()[field], target)
      change(existing, invalid)
      assert.deepEqual(existing.behavior(), initial)
      change(existing, target)
      assert.equal(existing.behavior()[field], target)
      if (type === 'openApp') assert.equal(draft.view.root.findByProps({ 'aria-label': '选择应用' }).props.disabled, true)
    } finally {
      act(() => draft.view.unmount())
      act(() => existing.view.unmount())
    }
  }
})

test('native application drops preserve shortcut paths, reject invalid drops and clean up listeners', async () => {
  testWindow.__TAURI_INTERNALS__ = {}
  const dialog = renderDialog('windows', { id: 'drop', enabled: true, type: 'openApp', path: '' })
  const send = payload => act(() => { for (const callback of dropListeners) callback({ payload }) })
  const position = { x: 600, y: 400 }
  try {
    await act(async () => {})
    assert.equal(dropListeners.size, 1)
    send({ type: 'enter', paths: ['C:\\桌面\\Tool.lnk'], position })
    assert.ok(dialog.view.root.findByProps({ role: 'dialog' }).props.className.includes('application-drag-over'))
    send({ type: 'leave' })
    assert.equal(dialog.view.root.findByProps({ role: 'dialog' }).props.className.includes('application-drag-over'), false)
    send({ type: 'drop', paths: ['C:\\桌面\\Tool.lnk'], position })
    assert.equal(dialog.behavior().path, 'C:\\桌面\\Tool.lnk')
    assert.equal(dialog.save().props.disabled, false)
    assert.equal(dialog.view.root.findByProps({ id: 'behavior-launch-target' }).props.value, 'C:\\桌面\\Tool.lnk')
    send({ type: 'drop', paths: ['C:\\Other.exe'], position: { x: 20, y: 20 } })
    assert.equal(dialog.behavior().path, 'C:\\桌面\\Tool.lnk')
    send({ type: 'drop', paths: ['C:\\A.exe', 'C:\\B.exe'], position })
    assert.ok(text(dialog.view.root.findByProps({ role: 'alert' })).includes('一个'))
    send({ type: 'drop', paths: ['C:\\File.txt'], position })
    assert.ok(text(dialog.view.root.findByProps({ role: 'alert' })).includes('不支持'))
    assert.equal(dialog.behavior().path, 'C:\\桌面\\Tool.lnk')
    send({ type: 'drop', paths: ['C:\\Program Files\\Tool.exe'], position })
    assert.equal(dialog.behavior().path, 'C:\\Program Files\\Tool.exe')
    assert.equal(dialog.view.root.findAllByProps({ role: 'alert' }).length, 0)
    assert.equal(dropListeners.size, 1)
  } finally {
    act(() => dialog.view.unmount())
    delete testWindow.__TAURI_INTERNALS__
  }
  assert.equal(dropListeners.size, 0)
})

test('native drag listener is removed when its subscription resolves after dialog close', async () => {
  testWindow.__TAURI_INTERNALS__ = {}
  const dialog = renderDialog('macos', { id: 'drop', enabled: true, type: 'openApp', path: '/Applications/Test.app' })
  act(() => dialog.view.unmount())
  delete testWindow.__TAURI_INTERNALS__
  await act(async () => {})
  assert.equal(dropListeners.size, 0)
  testWindow.__TAURI_INTERNALS__ = {}
  const website = renderDialog('windows', { id: 'web', enabled: true, type: 'openWebsite', url: 'https://example.com/' })
  try {
    assert.equal(dropListeners.size, 0)
  } finally {
    act(() => website.view.unmount())
    delete testWindow.__TAURI_INTERNALS__
  }
})

for (const platform of ['macos', 'windows']) {
  test(`${platform}: both sides can be selected together and retained while editing`, () => {
    const dialog = renderDialog(platform, { id: 'both', enabled: true, type: 'shortcut', keys: ['Win'] })
    let reopened
    try {
      dialog.side('Win', 'both')
      assert.deepEqual(dialog.behavior().keys, ['Win', 'RWin'])
      reopened = renderDialog(platform, normalizeBehavior(dialog.behavior()), false)
      assert.equal(reopened.view.root.findByProps({ 'aria-label': `${keyDisplayName('Win', platform)} 左右侧` }).props.value, 'both')
      assert.equal(reopened.view.root.findByProps({ 'aria-label': '选择主按键或单独修饰键' }).props.value, '')
      reopened.toggle('Shift')
      reopened.select('C')
      assert.deepEqual(reopened.behavior().keys, ['Shift', 'Win', 'RWin', 'C'])
      reopened.side('Win', 'right')
      assert.deepEqual(reopened.behavior().keys, ['Shift', 'RWin', 'C'])
      reopened.side('Win', 'both')
      reopened.toggle(keyDisplayName('Win', platform))
      assert.deepEqual(reopened.behavior().keys, ['Shift', 'C'])
      for (const modifier of ['Ctrl', 'Alt', 'Win']) reopened.toggle(keyDisplayName(modifier, platform))
      for (const modifier of ['Ctrl', 'Shift', 'Alt', 'Win']) reopened.side(modifier, 'both')
      assert.deepEqual(reopened.behavior().keys, ['Ctrl', 'RCtrl', 'Shift', 'RShift', 'Alt', 'RAlt', 'Win', 'RWin', 'C'])
    } finally {
      act(() => dialog.view.unmount())
      if (reopened) act(() => reopened.view.unmount())
    }
  })

  test(`${platform}: each modifier side switches independently and survives reopening`, () => {
    const initial = { id: 'sides', enabled: true, type: 'shortcut', keys: ['Ctrl', 'Shift', 'Alt', 'Win'] }
    const dialog = renderDialog(platform, initial)
    let reopened
    try {
      for (const modifier of ['Ctrl', 'Shift', 'Alt', 'Win']) dialog.side(modifier, 'right')
      assert.deepEqual(dialog.behavior().keys, ['RCtrl', 'RShift', 'RAlt', 'RWin'])
      assert.equal(dialog.view.root.findByProps({ 'aria-label': '选择主按键或单独修饰键' }).props.value, '')
      dialog.side('Shift', 'left')
      dialog.side('Alt', 'left')
      assert.deepEqual(dialog.behavior().keys, ['RCtrl', 'Shift', 'Alt', 'RWin'])
      const persisted = normalizeBehavior(JSON.parse(JSON.stringify(dialog.behavior())))
      reopened = renderDialog(platform, persisted, false)
      for (const [modifier, side] of [['Ctrl', 'right'], ['Shift', 'left'], ['Alt', 'left'], ['Win', 'right']]) {
        const select = reopened.view.root.findByProps({ 'aria-label': `${keyDisplayName(modifier, platform)} 左右侧` })
        assert.equal(select.props.value, side)
        assert.equal(select.props.disabled, false)
      }
      reopened.select('C')
      assert.deepEqual(reopened.behavior().keys, ['RCtrl', 'Shift', 'Alt', 'RWin', 'C'])
      reopened.toggle(keyDisplayName('Ctrl', platform))
      assert.deepEqual(reopened.behavior().keys, ['Shift', 'Alt', 'RWin', 'C'])
      reopened.side('Win', 'left')
      assert.deepEqual(reopened.behavior().keys, ['Shift', 'Alt', 'Win', 'C'])
    } finally {
      act(() => dialog.view.unmount())
      if (reopened) act(() => reopened.view.unmount())
    }
  })

  test(`${platform}: existing explicit left Alt remains a modifier when editing other keys`, () => {
    const dialog = renderDialog(platform, { id: 'left', enabled: true, type: 'shortcut', keys: ['LAlt', 'RWin', 'V'] })
    try {
      assert.equal(dialog.view.root.findByProps({ 'aria-label': '选择主按键或单独修饰键' }).props.value, 'V')
      dialog.toggle(keyDisplayName('Ctrl', platform))
      assert.deepEqual(dialog.behavior().keys, ['Ctrl', 'LAlt', 'RWin', 'V'])
      dialog.side('Alt', 'right')
      assert.deepEqual(dialog.behavior().keys, ['Ctrl', 'RAlt', 'RWin', 'V'])
    } finally {
      act(() => dialog.view.unmount())
    }
  })

  test(`${platform}: editing keeps an incomplete selection out of autosaved settings`, () => {
    const initial = { id: 'chord', enabled: true, type: 'key', key: 'C' }
    const dialog = renderDialog(platform, initial, false)
    try {
      dialog.select('')
      assert.deepEqual(dialog.behavior(), initial)
      assert.equal(dialog.view.root.findByProps({ 'aria-label': '选择主按键或单独修饰键' }).props.value, '')
      assert.equal(text(dialog.view.root.findByProps({ className: 'behavior-current-value' })), '当前按键未设置')
      dialog.toggle('Shift')
      assert.deepEqual(dialog.behavior(), { id: 'chord', enabled: true, type: 'shortcut', keys: ['Shift'] })
      dialog.toggle('Shift')
      assert.deepEqual(dialog.behavior().keys, ['Shift'])
      dialog.select('Enter')
      assert.deepEqual(dialog.behavior(), { ...initial, key: 'Enter' })
    } finally {
      act(() => dialog.view.unmount())
    }
  })

  test(`${platform}: empty base preserves selected modifiers through save and reopen`, () => {
    const initial = { id: 'chord', enabled: true, type: 'shortcut', keys: ['Ctrl', 'Alt', 'C'] }
    const dialog = renderDialog(platform, initial)
    let reopened
    try {
      const empty = dialog.view.root.findAllByType('option').find(node => node.props.value === '')
      assert.equal(text(empty), '空')
      assert.ok(!empty.props.disabled)
      dialog.select('')
      assert.deepEqual(dialog.behavior(), { ...initial, keys: ['Ctrl', 'Alt'] })
      assert.equal(dialog.save().props.disabled, false)
      const persisted = normalizeBehavior(JSON.parse(JSON.stringify(dialog.behavior())))
      reopened = renderDialog(platform, persisted)
      assert.equal(reopened.view.root.findByProps({ 'aria-label': '选择主按键或单独修饰键' }).props.value, '')
      assert.equal(text(reopened.view.root.findByProps({ className: 'behavior-current-value' })),
        platform === 'macos' ? '当前按键Control + Option' : '当前按键Ctrl + Alt')
      reopened.select('V')
      assert.deepEqual(reopened.behavior(), { ...initial, keys: ['Ctrl', 'Alt', 'V'] })
    } finally {
      act(() => dialog.view.unmount())
      if (reopened) act(() => reopened.view.unmount())
    }
  })

  test(`${platform}: empty base supports one modifier and disables saving an empty chord`, () => {
    const dialog = renderDialog(platform, { id: 'chord', enabled: true, type: 'key', key: 'C' })
    try {
      dialog.select('')
      assert.deepEqual(dialog.behavior().keys, [])
      assert.equal(dialog.save().props.disabled, true)
      dialog.toggle('Shift')
      assert.deepEqual(dialog.behavior().keys, ['Shift'])
      assert.equal(dialog.view.root.findByProps({ 'aria-label': '选择主按键或单独修饰键' }).props.value, '')
      assert.equal(dialog.save().props.disabled, false)
      dialog.toggle(keyDisplayName('Ctrl', platform))
      assert.deepEqual(dialog.behavior().keys, ['Ctrl', 'Shift'])
      dialog.toggle('Shift')
      dialog.toggle(keyDisplayName('Ctrl', platform))
      assert.deepEqual(dialog.behavior().keys, [])
      assert.equal(dialog.save().props.disabled, true)
      dialog.select('Enter')
      assert.equal(dialog.behavior().type, 'key')
      assert.equal(dialog.behavior().key, 'Enter')
      assert.equal(dialog.save().props.disabled, false)
    } finally {
      act(() => dialog.view.unmount())
    }
  })

  test(`${platform}: standalone modifiers remain independent and can switch to an empty base`, () => {
    const dialog = renderDialog(platform, { id: 'chord', enabled: true, type: 'shortcut', keys: ['Ctrl', 'Alt'] })
    try {
      dialog.select('RCtrl')
      assert.deepEqual(dialog.behavior(), { id: 'chord', enabled: true, type: 'key', key: 'RCtrl' })
      assert.ok(dialog.view.root.findAllByProps({ 'aria-pressed': false }).every(node => node.props.disabled))
      dialog.select('')
      dialog.toggle('Shift')
      assert.deepEqual(dialog.behavior().keys, ['Shift'])
    } finally {
      act(() => dialog.view.unmount())
    }
  })
}
