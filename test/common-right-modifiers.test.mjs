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
let clipboardRead = async () => ''
const browserClipboard = { readText: async () => 'browser clipboard', writeText: async () => {} }
const nativeClipboard = { readText: async () => 'native clipboard', writeText: async () => {} }

function load(file) {
  file = resolve(file)
  if (cache.has(file)) return cache.get(file).exports
  const module = { exports: {} }
  cache.set(file, module)
  const source = ts.transpileModule(readFileSync(file, 'utf8'), { compilerOptions: {
    module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020, jsx: ts.JsxEmit.ReactJSX,
  } }).outputText
  const localRequire = name => {
    if (name === '../clipboard') return { readClipboardText: () => clipboardRead() }
    if (name === '@tauri-apps/plugin-clipboard-manager') return nativeClipboard
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
  vm.runInNewContext(source, { module, exports: module.exports, require: localRequire, console, URL, setTimeout, clearTimeout, window: testWindow, navigator: { clipboard: browserClipboard } }, { filename: file })
  return module.exports
}

const { BehaviorEditor, BehaviorEditDialog, SequencePasteDialog } = load('src/components/BehaviorEditor.tsx')
const { normalizeBehavior } = load('src/behaviorModel.ts')
const { keyDisplayName, rightModifierChoices, isRightModifierPreset, rightModifierKeys, getStoredUiState } = load('src/appConfig.tsx')
const { readClipboardText, writeClipboardText } = load('src/clipboard.ts')

const button = { id: 'menu', label: '菜单', icon: 'menu' }
const text = node => typeof node === 'string' ? node : (node.children ?? []).map(text).join('')

const sequenceText = 'axonkey/1\nkey A\nend'

test('saved mapping entries restore the unified mapping page and retain the selected input', () => {
  const previousStorage = testWindow.localStorage
  try {
    for (const activePage of ['mapping', 'mappingFlow']) {
      testWindow.localStorage = { getItem: () => JSON.stringify({
        activePage, selectedDeviceId: 'rc003', activeId: 'tv', selectedBehavior: { buttonId: 'tv', trigger: 'longPress' },
      }) }
      const state = getStoredUiState()
      assert.equal(state.activePage, 'mapping')
      assert.equal(state.activeId, 'tv')
      assert.equal(state.selectedBehavior.buttonId, 'tv')
      assert.equal(state.selectedBehavior.trigger, 'longPress')
    }
  } finally {
    testWindow.localStorage = previousStorage
  }
})

test('clipboard transfers use the native plugin in Tauri and browser APIs in preview', async () => {
  const writes = []
  browserClipboard.writeText = async text => writes.push(['browser', text])
  nativeClipboard.writeText = async text => writes.push(['native', text])
  assert.equal(await readClipboardText(), 'browser clipboard')
  await writeClipboardText(sequenceText)
  testWindow.__TAURI_INTERNALS__ = {}
  try {
    assert.equal(await readClipboardText(), 'native clipboard')
    await writeClipboardText(sequenceText)
    assert.deepEqual(writes, [['browser', sequenceText], ['native', sequenceText]])
  } finally {
    delete testWindow.__TAURI_INTERNALS__
  }
})

async function renderSequenceDialog(read = async () => sequenceText) {
  clipboardRead = read
  let view
  const applied = []
  let closed = 0
  await act(async () => {
    view = Renderer.create(React.createElement(SequencePasteDialog, {
      platform: 'windows', button, trigger: 'click', onClose: () => { closed += 1 }, onApply: sequence => applied.push(sequence),
    }))
  })
  return {
    view, applied, closed: () => closed,
    input: () => view.root.findByProps({ id: 'sequence-paste-value' }),
    apply: () => view.root.findAllByType('button').find(node => text(node) === '应用序列'),
    change: value => act(() => view.root.findByProps({ id: 'sequence-paste-value' }).props.onChange({ target: { value } })),
  }
}

test('paste sequence prefills supported clipboard data and applies only on confirmation', async () => {
  const dialog = await renderSequenceDialog()
  try {
    assert.equal(dialog.input().props.value, sequenceText)
    assert.equal(dialog.apply().props.disabled, false)
    assert.equal(dialog.applied.length, 0)
    assert.ok(text(dialog.view.root.findByProps({ 'aria-label': '待应用的行为序列' })).includes('按键 / 组合键A'))
    assert.equal(dialog.view.root.findByProps({ className: 'sequence-source' }).props.open, false)
    act(() => dialog.apply().props.onClick())
    assert.equal(dialog.applied[0][0].key, 'A')
    dialog.change('invalid')
    assert.equal(dialog.apply().props.disabled, true)
    assert.equal(dialog.input().props['aria-invalid'], true)
    assert.ok(dialog.view.root.findByProps({ role: 'alert' }))
    assert.equal(dialog.view.root.findAllByProps({ 'aria-label': '待应用的行为序列' }).length, 0)
    act(() => dialog.view.root.findByProps({ 'aria-label': '关闭粘贴序列' }).props.onClick())
    assert.equal(dialog.closed(), 1)
  } finally {
    act(() => dialog.view.unmount())
  }
})

test('unrelated clipboard text stays empty and read failures allow manual paste', async () => {
  for (const read of [async () => 'unrelated clipboard text', async () => '{"format":"axonkey-sequence","version":1,"behaviors":[]}', async () => { throw new Error('denied') }]) {
    const dialog = await renderSequenceDialog(read)
    try {
      assert.equal(dialog.input().props.value, '')
      assert.equal(dialog.apply().props.disabled, true)
      dialog.change(sequenceText)
      assert.equal(dialog.apply().props.disabled, false)
      assert.equal(dialog.view.root.findAllByProps({ role: 'alert' }).length, 0)
    } finally {
      act(() => dialog.view.unmount())
    }
  }
})

test('shared sequences preview all steps, full text, paths and disabled state before applying', async () => {
  const shared = '我的操作\n\x60\x60\x60text\naxonkey/1\nkeys Ctrl A\nwait 20ms\ntext "完整的粘贴文本内容，不会被截断\\n第二行"\noff key B\napp "C:\\\\Program Files\\\\Tool.exe"\nend\n\x60\x60\x60\n使用说明'
  const dialog = await renderSequenceDialog(async () => shared)
  try {
    const preview = dialog.view.root.findByProps({ 'aria-label': '待应用的行为序列' })
    assert.equal(preview.findAllByProps({ className: 'behavior-item sequence-preview-item' }).length, 5)
    for (const label of ['Ctrl + A', '等待 20 毫秒', '完整的粘贴文本内容，不会被截断\n第二行', '已停用', 'C:\\Program Files\\Tool.exe']) assert.ok(text(preview).includes(label), label)
    assert.equal(dialog.applied.length, 0)
    act(() => dialog.apply().props.onClick())
    assert.equal(dialog.applied[0].length, 5)
    assert.equal(dialog.applied[0][3].enabled, false)
  } finally {
    act(() => dialog.view.unmount())
  }
})

test('late clipboard reads never overwrite typing or update a closed dialog', async () => {
  for (const close of [false, true]) {
    let resolveRead
    const dialog = await renderSequenceDialog(() => new Promise(resolve => { resolveRead = resolve }))
    if (close) act(() => dialog.view.unmount())
    else dialog.change('manual draft')
    await act(async () => { resolveRead(sequenceText) })
    if (!close) {
      assert.equal(dialog.input().props.value, 'manual draft')
      act(() => dialog.view.unmount())
    }
  }
})

function render(platform, behaviors = []) {
  const applied = []
  const transfers = []
  let view
  act(() => {
    view = Renderer.create(React.createElement(BehaviorEditor, {
      editorRef: { current: null },
      attention: false,
      platform,
      button,
      trigger: 'click',
      behaviors,
      onApplyCommonBehavior: preset => applied.push(preset),
      onAddAdvancedBehavior: () => {},
      onRemoveBehavior: () => {},
      onMoveBehavior: () => {},
      onEditBehavior: () => {},
      onReturnToMappings: () => {},
      onCopySequence: () => transfers.push('copy'),
      onPasteSequence: () => transfers.push('paste'),
      onClearSequence: () => transfers.push('clear'),
    }))
  })
  return { view, applied, transfers }
}

test('current sequence offers copy, paste and clear, with clear disabled when empty', () => {
  const editor = render('macos', [{ id: 'step', type: 'key', key: 'A', enabled: true }])
  const empty = render('macos')
  try {
    for (const label of ['复制序列', '粘贴序列', '清除序列']) {
      const control = editor.view.root.findAllByType('button').find(node => text(node).trim() === label)
      assert.ok(!control.props.disabled)
      act(() => control.props.onClick())
    }
    assert.deepEqual(editor.transfers, ['copy', 'paste', 'clear'])
    assert.equal(empty.view.root.findAllByType('button').find(node => text(node).trim() === '清除序列').props.disabled, true)
  } finally {
    act(() => editor.view.unmount())
    act(() => empty.view.unmount())
  }
})

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
  assert.equal(names('macos'), '右 Ctrl|右 Opt|右 Cmd')
  assert.equal(names('windows'), '右 Ctrl|右 Alt|右 Win')
})

test('common behaviors offer the right-side modifiers with platform names', () => {
  const mac = render('macos')
  const windows = render('windows')
  try {
    for (const label of ['右 Ctrl', '右 Opt', '右 Cmd']) {
      assert.ok(choiceButton(mac.view, label), label)
    }
    assert.equal(choiceButton(mac.view, '右 Win'), undefined)
    assert.equal(text(choiceButton(mac.view, '右 Cmd')), 'Cmd右 Cmd')

    for (const label of ['右 Ctrl', '右 Alt', '右 Win']) {
      assert.ok(choiceButton(windows.view, label), label)
    }
    assert.equal(choiceButton(windows.view, '右 Cmd'), undefined)
    assert.equal(choiceButton(windows.view, '右 Opt'), undefined)
    assert.equal(text(choiceButton(windows.view, '右 Win')), 'Win右 Win')
    assert.equal(text(choiceButton(windows.view, '右 Alt')), 'Alt右 Alt')

    act(() => choiceButton(mac.view, '右 Cmd').props.onClick())
    act(() => choiceButton(windows.view, '右 Win').props.onClick())
    act(() => choiceButton(mac.view, '右 Opt').props.onClick())
    act(() => choiceButton(windows.view, '右 Ctrl').props.onClick())
    assert.deepEqual(mac.applied, ['rightCommand', 'rightAlt'])
    assert.deepEqual(windows.applied, ['rightCommand', 'rightCtrl'])
  } finally {
    act(() => mac.view.unmount())
    act(() => windows.view.unmount())
  }
})

function renderDialog(platform, initial, draft = true, extraProps = {}) {
  let behavior = initial
  let view
  let captureStarts = 0
  let captureFocuses = 0
  const props = {
    platform, button, trigger: 'click', capturing: false, draft,
    onStartCapture() { captureStarts += 1 }, onCancelCapture() {}, onCaptureKey() {}, onClose() {}, onSave() {},
    onUpdate(update) {
      behavior = update(behavior)
      view.update(React.createElement(BehaviorEditDialog, { ...props, behavior }))
    },
    ...extraProps,
  }
  act(() => { view = Renderer.create(React.createElement(BehaviorEditDialog, { ...props, behavior }), {
    createNodeMock: element => element.type === 'section' ? {
      getBoundingClientRect: () => ({ left: 100, right: 700, top: 100, bottom: 500 }),
      querySelector: () => ({ focus() { captureFocuses += 1 } }),
    } : null,
  }) })
  return {
    view,
    behavior: () => JSON.parse(JSON.stringify(behavior)),
    captureStarts: () => captureStarts,
    captureFocuses: () => captureFocuses,
    select: value => act(() => view.root.findByProps({ 'aria-label': '选择主按键或单独修饰键' }).props.onChange({ target: { value } })),
    side: (modifier, value) => act(() => view.root.findByProps({ 'aria-label': `${keyDisplayName(modifier, platform)} 左右侧` }).props.onChange({ target: { value } })),
    toggle: label => act(() => view.root.findAllByType('button').find(node => text(node) === label).props.onClick()),
    save: () => view.root.findAllByType('button').find(node => text(node) === '保存'),
  }
}

test('opening a key or shortcut editor starts capture once without replacing the existing binding', () => {
  for (const draft of [true, false]) {
    for (const initial of [
      { id: 'key', enabled: true, type: 'key', key: 'A' },
      { id: 'shortcut', enabled: true, type: 'shortcut', keys: ['Ctrl', 'A'] },
    ]) {
      const dialog = renderDialog('windows', initial, draft)
      try {
        assert.equal(dialog.captureStarts(), 1)
        assert.equal(dialog.captureFocuses(), 1)
        assert.deepEqual(dialog.behavior(), initial)
        dialog.select('B')
        assert.equal(dialog.captureStarts(), 1, 'manual selection must not restart capture')
      } finally { act(() => dialog.view.unmount()) }
    }
  }
})

test('non-key editors and grouped media choices do not start keyboard capture', () => {
  for (const [initial, extraProps] of [
    [{ id: 'delay', enabled: true, type: 'delay', ms: 300 }, {}],
    [{ id: 'paste', enabled: true, type: 'paste', text: 'text' }, {}],
    [{ id: 'volume', enabled: true, type: 'key', key: 'VolumeUp' }, { actionChoices: { label: '音量动作', options: [] } }],
  ]) {
    const dialog = renderDialog('windows', initial, true, extraProps)
    try { assert.equal(dialog.captureStarts(), 0); assert.equal(dialog.captureFocuses(), 0) }
    finally { act(() => dialog.view.unmount()) }
  }
})

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
        platform === 'macos' ? '当前按键Ctrl + Opt' : '当前按键Ctrl + Alt')
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
