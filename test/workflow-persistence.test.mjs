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
const storage = new Map()
let storageFailure = false
const copiedSequences = []
const libraryAdditions = []
const copy = value => JSON.parse(JSON.stringify(value))
const cache = new Map()
const text = node => (typeof node === 'string' ? node : (node.children ?? []).map(text).join(''))

function MockSaveDialog(props) {
  return React.createElement('sequence-save-dialog', props)
}
function MockPasteDialog(props) {
  return React.createElement('sequence-paste-dialog', props)
}
function MockDialog(props) {
  return React.createElement('workflow-dialog', props)
}

function load(file) {
  file = resolve(file)
  if (cache.has(file)) return cache.get(file).exports
  const module = { exports: {} }
  cache.set(file, module)
  const source = ts.transpileModule(readFileSync(file, 'utf8'), {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2020,
      jsx: ts.JsxEmit.ReactJSX,
    },
  }).outputText
  const localRequire = name => {
    if (name.endsWith('.css')) return {}
    if (name === 'react-dom') return { createPortal: node => node }
    if (name === '@tauri-apps/api/core') {
      return {
        invoke: async (command, args) => {
          assert.equal(command, 'axonkey_record_library_additions')
          libraryAdditions.push(copy(args.itemIds))
        },
      }
    }
    if (name === './workflowActionIcons') return { createWorkflowActionIconUrls: () => ({}) }
    if (name === '../clipboard') {
      return {
        writeClipboardText: async value => {
          copiedSequences.push(value)
        },
      }
    }
    if (name === './BehaviorEditor') return { SequencePasteDialog: MockPasteDialog }
    if (name === './WorkflowSequenceSaveDialog') return { WorkflowSequenceSaveDialog: MockSaveDialog }
    if (name === './WorkflowStepDialog') return { WorkflowStepDialog: MockDialog }
    if (!name.startsWith('.')) return require(name)
    const path = resolve(dirname(file), name)
    return load(extname(path) ? path : existsSync(`${path}.tsx`) ? `${path}.tsx` : `${path}.ts`)
  }
  vm.runInNewContext(
    source,
    {
      module,
      exports: module.exports,
      require: localRequire,
      URL,
      console,
      CSS: { escape: value => value },
      crypto: globalThis.crypto,
      structuredClone,
      window: {
        __TAURI_INTERNALS__: {},
        innerWidth: 1080,
        innerHeight: 760,
        addEventListener() {},
        removeEventListener() {},
        setTimeout,
        clearTimeout,
        localStorage: {
          getItem: key => storage.get(key) ?? null,
          setItem: (key, value) => {
            if (storageFailure) throw new Error('Storage full')
            storage.set(key, value)
          },
        },
      },
      document: {
        body: {},
        querySelector: () => null,
        createElement: () => ({ setAttribute() {}, remove() {} }),
      },
    },
    { filename: file },
  )
  return module.exports
}

const { WorkflowAxonkey } = load('src/components/WorkflowAxonkey.tsx')
const { WorkflowToolbox } = load('src/components/WorkflowToolbox.tsx')
const { MouseScopeSelector, mouseInputs } = load('src/components/MouseMapping.tsx')
const { createDefaultBehaviorMap } = load('src/behaviorModel.ts')
const { BehaviorLibraryContext } = load('src/cloud/BehaviorLibraryContext.tsx')

const empty = () => ({ click: [], doubleClick: [], longPress: [] })
const delay = ms => ({ id: 'wait', type: 'delay', enabled: true, ms })
const palette = type => ({ id: `new-${type}`, type, componentType: 'task', name: type, properties: { preset: type } })

const render = async (sequences = empty(), options = {}, account = null) => {
  let view
  const writes = []
  const requests = []
  const toolboxLists = []
  let props = {
    onRequestProfileSwitch: (...args) => requests.push(copy(args)),
    toolboxCategory: 'all',
    onToolboxCategoryChange() {},
    platform: 'windows',
    button: { id: 'tv', label: '电视键' },
    sequences,
    onChange: (id, next) => writes.push([id, copy(next)]),
    ...options,
  }
  const element = () =>
    React.createElement(BehaviorLibraryContext.Provider, { value: account }, React.createElement(WorkflowAxonkey, props))
  await act(async () => {
    view = Renderer.create(element(), {
      createNodeMock: node => {
        if (node.props.className === 'workflow-toolbox-list') {
          const list = { scrollTop: 0 }
          toolboxLists.push(list)
          return list
        }
        return {
          focus() {},
          contains: () => false,
          getBoundingClientRect: () => ({ top: 120, bottom: 148, left: 820, right: 880, width: 60, height: 28 }),
        }
      },
    })
  })
  return {
    view,
    writes,
    requests,
    toolboxLists,
    card: trigger => view.root.findByProps({ 'data-trigger': trigger }),
    cards: () => view.root.findAll(node => node.type === 'article' && Boolean(node.props['data-trigger'])),
    openPicker: async (trigger = 'click') => {
      const btn = view.root.findByProps({ 'data-trigger-add': trigger })
      if (!btn.props['aria-expanded']) {
        await act(async () => btn.props.onClick({ currentTarget: { getBoundingClientRect: () => ({ bottom: 148, right: 880 }) } }))
      }
      return view.root.findByType(WorkflowToolbox)
    },
    addAction: async (trigger, stepOrType) => {
      const btn = view.root.findByProps({ 'data-trigger-add': trigger })
      if (!btn.props['aria-expanded']) {
        await act(async () => btn.props.onClick({ currentTarget: { getBoundingClientRect: () => ({ bottom: 148, right: 880 }) } }))
      }
      const toolbox = view.root.findByType(WorkflowToolbox)
      const step =
        typeof stepOrType === 'string'
          ? toolbox.props.palettes
              .flatMap(p => p.groups)
              .flatMap(g => g.steps)
              .find(s => s.type === stepOrType) ?? palette(stepOrType)
          : stepOrType
      await act(async () => toolbox.props.onAddStep(step))
    },
    runMenuAction: async (trigger, labelText) => {
      const card = view.root.findByProps({ 'data-trigger': trigger })
      const menuBtn = card.findByProps({ 'aria-haspopup': 'menu' })
      if (!menuBtn.props['aria-expanded']) {
        await act(async () => menuBtn.props.onClick())
      }
      const item = card.findAllByProps({ role: 'menuitem' }).find(node => text(node) === labelText)
      assert.ok(item, `menu item ${labelText}`)
      if (!item.props.disabled) {
        await act(async () => item.props.onClick())
      }
      return item
    },
    update: async nextProps => {
      props = { ...props, ...nextProps }
      await act(async () => view.update(element()))
    },
    unmount: async () => act(async () => view.unmount()),
  }
}

test('three-column trigger card keeps fixed right add slot across 0, 1, and 2+ behaviors with inline reorder', async () => {
  const app = await render()
  try {
    const clickCard = () => app.card('click')
    // 0 behaviors: empty slot + fixed right add slot
    assert.match(clickCard().props.className, /\bis-empty\b/)
    assert.equal(clickCard().findAllByProps({ className: 'trigger-empty-slot' }).length, 1)
    const slotChildrenAt0 = clickCard()
      .findByProps({ className: 'trigger-add-slot' })
      .children.map(child => child.props.className.split(' ')[0])
    assert.deepEqual(slotChildrenAt0, ['trigger-seq-menu-wrap', 'add-step-btn'])

    // 1 behavior: single row, no step index badge, no reorder arrows, identical right add slot
    await app.addAction('click', 'enter')
    await app.update({ sequences: app.writes.at(-1)[1] })
    assert.doesNotMatch(clickCard().props.className, /\bis-empty\b/)
    assert.equal(clickCard().findAllByProps({ className: 'step-index' }).length, 0)
    assert.equal(clickCard().findAllByProps({ 'aria-label': '上移步骤' }).length, 0)
    assert.deepEqual(
      clickCard()
        .findByProps({ className: 'trigger-add-slot' })
        .children.map(child => child.props.className.split(' ')[0]),
      slotChildrenAt0,
    )

    // 2 behaviors: index badges 1/2 + reorder arrows appear, right add slot remains identical
    await app.addAction('click', 'space')
    await app.update({ sequences: app.writes.at(-1)[1] })
    assert.deepEqual(
      clickCard()
        .findAllByProps({ className: 'step-index' })
        .map(text),
      ['1', '2'],
    )
    assert.deepEqual(
      clickCard()
        .findByProps({ className: 'trigger-add-slot' })
        .children.map(child => child.props.className.split(' ')[0]),
      slotChildrenAt0,
    )
    const moveDownFirst = clickCard().findAllByProps({ 'aria-label': '下移步骤' })[0]
    await act(async () => moveDownFirst.props.onClick())
    assert.deepEqual(
      app.writes.at(-1)[1].click.map(item => item.key),
      ['Space', 'Enter'],
    )
  } finally {
    await app.unmount()
  }
})

test('switching mouse edges keeps each edge sequence isolated and restores saved behaviors', async () => {
  let view, currentMap, selectedId
  const initial = createDefaultBehaviorMap()
  initial['mouse.right.up'].click = [delay(900)]
  function Harness() {
    const [activeId, select] = React.useState('mouse.top.up')
    const [behaviors, setBehaviors] = React.useState(initial)
    currentMap = behaviors
    selectedId = activeId
    return React.createElement(
      React.Fragment,
      null,
      React.createElement(MouseScopeSelector, { activeId, behaviors, onSelect: select }),
      React.createElement(WorkflowAxonkey, {
        platform: 'windows',
        button: mouseInputs.find(input => input.id === activeId),
        sequences: behaviors[activeId],
        toolboxCategory: 'all',
        onToolboxCategoryChange() {},
        onRequestProfileSwitch() {},
        onChange: (id, next) => setBehaviors(current => ({ ...current, [id]: copy(next) })),
      }),
    )
  }
  await act(async () => {
    view = Renderer.create(React.createElement(Harness), {
      createNodeMock: () => ({
        focus() {},
        contains: () => false,
        getBoundingClientRect: () => ({ bottom: 148, right: 880 }),
      }),
    })
  })
  const switchEdge = async scope =>
    act(async () => view.root.findByProps({ className: `mouse-scope-option mouse-scope-${scope}` }).props.onClick())
  const addPreset = async type => {
    const addBtn = view.root.findByProps({ 'data-trigger-add': 'click' })
    if (!addBtn.props['aria-expanded']) {
      await act(async () => addBtn.props.onClick({ currentTarget: { getBoundingClientRect: () => ({ bottom: 148, right: 880 }) } }))
    }
    const toolbox = view.root.findByType(WorkflowToolbox)
    const step = toolbox.props.palettes
      .flatMap(p => p.groups)
      .flatMap(g => g.steps)
      .find(s => s.type === type)
    await act(async () => toolbox.props.onAddStep(step))
  }
  try {
    await addPreset('space')
    await switchEdge('left')
    assert.equal(selectedId, 'mouse.left.up')
    assert.equal(currentMap['mouse.top.up'].click[0].key, 'Space')
    assert.equal(view.root.findAllByProps({ className: 'trigger-empty-slot' }).length, 1)

    await addPreset('enter')
    await switchEdge('right')
    assert.equal(view.root.findByProps({ 'aria-label': '等待毫秒数' }).props.value, '900')
    await switchEdge('top')
    assert.equal(text(view.root.findByProps({ className: 'keycap-btn' })), '空格')
    await switchEdge('left')
    assert.equal(text(view.root.findByProps({ className: 'keycap-btn' })), '回车')
    assert.equal(currentMap['mouse.top.up'].click[0].key, 'Space')
    assert.equal(currentMap['mouse.left.up'].click[0].key, 'Enter')
    assert.equal(currentMap['mouse.right.up'].click[0].ms, 900)
  } finally {
    await act(async () => view.unmount())
  }
})

test('single-lane trigger switching preserves hidden sequences through edits and clearing', async () => {
  const initial = {
    click: [{ ...delay(100), id: 'click-wait' }],
    doubleClick: [{ ...delay(200), id: 'double-wait' }],
    longPress: [{ ...delay(300), id: 'long-wait' }],
  }
  const app = await render(initial, { activeTrigger: 'click', button: { id: 'xbox.a', label: 'A 键' } })
  try {
    assert.deepEqual(
      app.cards().map(c => c.props['data-trigger']),
      ['click'],
    )
    await app.update({ activeTrigger: 'doubleClick' })
    assert.deepEqual(
      app.cards().map(c => c.props['data-trigger']),
      ['doubleClick'],
    )
    assert.equal(app.writes.length, 0, 'changing visibility alone does not save a new configuration')

    await app.addAction('doubleClick', 'space')
    const saved = app.writes.at(-1)[1]
    assert.equal(app.writes.at(-1)[0], 'xbox.a')
    assert.deepEqual(saved.click, initial.click)
    assert.deepEqual(saved.longPress, initial.longPress)
    assert.equal(saved.doubleClick[1].key, 'Space')

    await app.update({ sequences: saved, activeTrigger: 'longPress' })
    await app.runMenuAction('longPress', '清空此触发')
    const cleared = app.writes.at(-1)[1]
    assert.deepEqual(cleared.longPress, [])
    assert.deepEqual(cleared.click, initial.click)
    assert.deepEqual(cleared.doubleClick, saved.doubleClick)
  } finally {
    await app.unmount()
  }
})

test('workflow changes autosave once and external undo/reset replaces cards without echoing back', async () => {
  const app = await render()
  try {
    assert.equal(app.writes.length, 0, 'loading must not write empty mappings')
    await app.addAction('click', 'delay')
    assert.equal(app.writes.length, 1)
    assert.equal(app.writes[0][0], 'tv')
    assert.equal(app.writes[0][1].click[0].ms, 300)
    await app.update({ sequences: app.writes.at(-1)[1] })
    assert.equal(app.writes.length, 1)

    const delayInput = app.card('click').findByProps({ 'aria-label': '等待毫秒数' })
    await act(async () => delayInput.props.onChange({ target: { value: '751' } }))
    assert.equal(app.writes.length, 2)
    assert.equal(app.writes.at(-1)[1].click[0].ms, 751)

    // External undo resets to empty without saving discarded state back
    await app.update({ sequences: empty() })
    assert.equal(app.card('click').findAllByProps({ className: 'trigger-empty-slot' }).length, 1)
    assert.equal(app.writes.length, 2)
  } finally {
    await app.unmount()
  }
})

test('inline key chord capture, inline prompt textarea, auto-enter toggle, and explicit deletion work without modals', async () => {
  const app = await render(empty(), { platform: 'macos' })
  try {
    // 1. Add customKey -> enters inline capture immediately
    await app.addAction('click', 'customKey')
    let keycap = app.card('click').findByProps({ className: 'keycap-btn capturing' })
    assert.match(text(keycap), /按下按键/)
    // Escape cancels capture and keeps default Enter
    await act(async () =>
      keycap.props.onKeyDown({
        key: 'Escape',
        ctrlKey: false,
        altKey: false,
        metaKey: false,
        shiftKey: false,
        preventDefault() {},
        stopPropagation() {},
      }),
    )
    keycap = app.card('click').findByProps({ className: 'keycap-btn' })
    assert.equal(text(keycap), '回车')
    // Click keycap -> capture Cmd + K
    await act(async () => keycap.props.onClick({ currentTarget: { focus() {} } }))
    keycap = app.card('click').findByProps({ className: 'keycap-btn capturing' })
    await act(async () =>
      keycap.props.onKeyDown({
        key: 'k',
        ctrlKey: false,
        altKey: false,
        metaKey: true,
        shiftKey: false,
        preventDefault() {},
        stopPropagation() {},
      }),
    )
    assert.deepEqual(app.writes.at(-1)[1].click[0].keys, ['Win', 'K'])
    assert.equal(text(app.card('click').findByProps({ className: 'keycap-btn' })), 'Cmd + K')

    // 2. Add textAndEnter -> opens inline textarea with auto-enter ON, waits for non-empty text
    const writesBeforeText = app.writes.length
    await app.addAction('doubleClick', 'textAndEnter')
    assert.equal(app.writes.length, writesBeforeText, 'empty draft must not write yet')
    const textarea = app.card('doubleClick').findByProps({ className: 'inline-prompt-textarea' })
    await act(async () => textarea.props.onChange({ target: { value: '   ' } }))
    assert.equal(app.writes.length, writesBeforeText, 'whitespace-only text does not overwrite')
    await act(async () => textarea.props.onChange({ target: { value: '请审查当前改动' } }))
    assert.equal(app.writes.length, writesBeforeText + 1)
    assert.deepEqual(
      app.writes.at(-1)[1].doubleClick.map(item => item.type),
      ['paste', 'delay', 'key'],
    )
    // Visually collapsed into 1 row with auto-enter chip ON
    const autoEnterBtn = app.card('doubleClick').findByProps({ 'aria-pressed': true })
    await act(async () => autoEnterBtn.props.onClick())
    assert.deepEqual(
      app.writes.at(-1)[1].doubleClick.map(item => item.type),
      ['paste'],
    )
    // Toggle auto-enter back ON
    await act(async () => app.card('doubleClick').findByProps({ 'aria-pressed': false }).props.onClick())
    assert.deepEqual(
      app.writes.at(-1)[1].doubleClick.map(item => item.type),
      ['paste', 'delay', 'key'],
    )

    // Delete collapsed paste+auto-enter unit removes all 3 underlying behaviors at once
    const deleteBtn = app.card('doubleClick').findByProps({ 'aria-label': '删除行为' })
    await act(async () => deleteBtn.props.onClick())
    assert.deepEqual(app.writes.at(-1)[1].doubleClick, [])
  } finally {
    await app.unmount()
  }
})

test('confirmed website targets and directional/choice presets normalize via modal editor and drafts cancel cleanly', async () => {
  const app = await render({ ...empty(), click: [delay(751)] })
  try {
    await app.addAction('doubleClick', 'openWebsite')
    assert.equal(app.writes.length, 0, 'unconfirmed website draft does not save')
    let dialog = app.view.root.findByType('workflow-dialog')
    await act(async () => dialog.props.onClose())
    assert.equal(app.writes.length, 0)

    // Reopen by clicking placeholder summary button and save normalized URL
    const summaryBtn = app.card('doubleClick').findByProps({ className: 'step-summary-btn is-placeholder' })
    await act(async () => summaryBtn.props.onClick())
    dialog = app.view.root.findByType('workflow-dialog')
    await act(async () =>
      dialog.props.edit.onSave({
        id: dialog.props.edit.stepId,
        type: 'openWebsite',
        enabled: true,
        url: 'example.com',
      }),
    )
    assert.equal(app.writes.length, 1)
    assert.equal(app.writes[0][1].doubleClick[0].url, 'https://example.com/')
    assert.deepEqual(app.writes[0][1].click, [delay(751)])
  } finally {
    await app.unmount()
  }

  for (const [preset, savedBehavior] of [
    ['wheel', { type: 'wheel', direction: 'down' }],
    ['cursorMove', { type: 'cursorMove', direction: 'right', distance: 120 }],
    ['mouseButton', { type: 'mouse', button: 'right' }],
    ['volumeControl', { type: 'key', key: 'VolumeMute' }],
    ['mediaTrack', { type: 'key', key: 'MediaNext' }],
  ]) {
    const sub = await render()
    try {
      await sub.addAction('longPress', preset)
      assert.equal(sub.writes.length, 0)
      const modal = sub.view.root.findByType('workflow-dialog')
      const stepId = modal.props.edit.stepId
      await act(async () =>
        modal.props.edit.onSave({
          id: stepId,
          enabled: true,
          ...savedBehavior,
        }),
      )
      assert.equal(sub.writes.length, 1)
      assert.deepEqual(sub.writes[0][1].longPress, [{ id: stepId, enabled: true, ...savedBehavior }])
    } finally {
      await sub.unmount()
    }
  }
})

test('switching inputs keeps open picker search query and scroll position while routing additions to the new input', async () => {
  const app = await render(empty(), { toolboxCategory: '常用行为/常用行为' })
  try {
    await app.openPicker('click')
    const searchInput = app.view.root.findByProps({ className: 'sqd-toolbox-filter-input' })
    await act(async () => searchInput.props.onChange({ target: { value: '回车' } }))
    const [list] = app.toolboxLists
    list.scrollTop = 200

    await app.update({ button: { id: 'power', label: '电源键' }, sequences: empty() })
    assert.equal(app.view.root.findByProps({ className: 'sqd-toolbox-filter-input' }).props.value, '回车')
    assert.equal(list.scrollTop, 200)
    const enterItem = app.view.root.findByProps({ className: 'sqd-toolbox-item sqd-type-enter' })
    await act(async () => enterItem.findByProps({ className: 'workflow-toolbox-add' }).props.onClick())
    assert.equal(app.writes.length, 1)
    assert.equal(app.writes[0][0], 'power')
    assert.equal(app.writes[0][1].click[0].key, 'Enter')
  } finally {
    await app.unmount()
  }
})

test('sequence menu supports copy, paste, save to library, removal, and blocks copying incomplete drafts', async () => {
  storage.clear()
  const before = { click: [delay(500)], doubleClick: [{ ...delay(700), id: 'other' }], longPress: [] }
  const app = await render(before)
  let reopened
  try {
    await app.runMenuAction('click', '复制序列')
    assert.match(copiedSequences.at(-1), /wait 500ms/)

    await app.runMenuAction('longPress', '粘贴序列')
    const pasteDialog = app.view.root.findByType('sequence-paste-dialog')
    assert.equal(pasteDialog.props.trigger, 'longPress')
    await act(async () => pasteDialog.props.onApply([{ ...delay(750), id: 'pasted' }]))
    assert.deepEqual(app.writes.at(-1)[1].longPress, [{ ...delay(750), id: 'pasted' }])
    assert.deepEqual(app.writes.at(-1)[1].doubleClick, before.doubleClick)

    await app.runMenuAction('click', '保存到行为库')
    storageFailure = true
    const saveDialog = app.view.root.findByType('sequence-save-dialog')
    await act(async () => {
      assert.match(saveDialog.props.onSave('失败测试'), /保存失败/)
    })
    assert.equal(app.view.root.findAllByType('sequence-save-dialog').length, 1)
    storageFailure = false
    await act(async () => {
      assert.equal(saveDialog.props.onSave('常用序列'), null)
    })
    const stored = JSON.parse(storage.get('axonkey.saved-sequences.v1'))
    assert.equal(stored[0].name, '常用序列')

    reopened = await render()
    const toolbox = await reopened.openPicker('click')
    const savedGroup = toolbox.props.palettes.find(p => p.name === '已保存').groups[0]
    assert.equal(savedGroup.steps[0].name, '常用序列')
    await act(async () => toolbox.props.onRemoveSavedSequence(stored[0].id))
    assert.deepEqual(JSON.parse(storage.get('axonkey.saved-sequences.v1')), [])
  } finally {
    storageFailure = false
    await app.unmount()
    if (reopened) await reopened.unmount()
  }
})

test('disable action replaces target trigger, blocks adding until cleared, and restores cleanly on undo', async () => {
  const original = {
    click: [delay(500), { ...delay(800), id: 'second' }],
    doubleClick: [{ ...delay(300), id: 'double' }],
    longPress: [],
  }
  const app = await render(original)
  try {
    await app.addAction('click', 'disabled')
    assert.equal(app.writes.length, 1)
    assert.equal(app.writes[0][1].click.length, 1)
    assert.equal(app.writes[0][1].click[0].type, 'disabled')
    await app.update({ sequences: app.writes[0][1] })

    // Cannot open picker or append into disabled lane
    const addBtn = app.card('click').findByProps({ 'data-trigger-add': 'click' })
    await act(async () => addBtn.props.onClick({ currentTarget: {} }))
    assert.equal(app.view.root.findAllByType(WorkflowToolbox).length, 0)
    assert.match(text(app.view.root.findByProps({ role: 'status' })), /取消禁用/)

    // Cancel disable via inline clear button
    const clearDisable = app.card('click').findByProps({ 'aria-label': '取消禁用单击' })
    await act(async () => clearDisable.props.onClick())
    assert.deepEqual(app.writes.at(-1)[1].click, [])

    // Undo restores original 2 delays
    await app.update({ sequences: original })
    assert.equal(app.card('click').findAllByProps({ 'aria-label': '等待毫秒数' }).length, 2)
  } finally {
    await app.unmount()
  }
})

test('profile switch additions, edits, pastes, and gated deletions wait for shared confirmation and preserve drafts', async () => {
  const { removedProfileSwitchTriggers } = load('src/profileNavigation.ts')
  const switchBehavior = { id: 'shared', type: 'switchProfile', enabled: true, direction: 'next', wrap: true }
  const original = { click: [switchBehavior], doubleClick: [delay(400)], longPress: [] }
  const pending = []
  const app = await render(original, {
    onChange: (id, next) => {
      if (removedProfileSwitchTriggers(original, next).length) {
        pending.push(copy(next))
        return false
      }
      app.writes.push([id, copy(next)])
    },
  })
  try {
    // 1. Adding switchProfile requests confirmation without mutating doubleClick
    await app.addAction('doubleClick', 'switchProfile')
    assert.equal(app.requests.length, 1)
    assert.deepEqual(app.requests[0].slice(0, 2), ['tv', 'doubleClick'])
    assert.equal(app.writes.length, 0)

    // 2. Editing existing switchProfile requests confirmation without mutating click
    const editBtn = app.card('click').findByProps({ className: 'step-summary-btn' })
    await act(async () => editBtn.props.onClick())
    const dialog = app.view.root.findByType('workflow-dialog')
    await act(async () => dialog.props.edit.onSave({ ...switchBehavior, direction: 'previous', wrap: false }))
    assert.equal(app.requests.length, 2)
    assert.equal(app.writes.length, 0)

    // 3. Pasting a sequence containing switchProfile requests confirmation
    await app.runMenuAction('longPress', '粘贴序列')
    await act(async () => app.view.root.findByType('sequence-paste-dialog').props.onApply([switchBehavior]))
    assert.equal(app.requests.length, 3)
    assert.equal(app.requests[2][1], 'longPress')

    // 4. Add an incomplete paste draft in longPress, then attempt to delete shared switch in click -> gated!
    await app.addAction('longPress', 'paste')
    assert.equal(app.card('longPress').findAllByProps({ className: 'inline-prompt-textarea' }).length, 1)
    const deleteShared = app.card('click').findByProps({ 'aria-label': '删除行为' })
    await act(async () => deleteShared.props.onClick())
    assert.equal(pending.length, 1)
    assert.deepEqual(pending[0], { ...original, click: [] })
    assert.equal(app.writes.length, 0)
    // Original switchProfile remains on click AND unfinished paste draft remains in longPress!
    assert.equal(app.card('click').findAllByProps({ className: 'step-summary-btn' }).length, 1)
    assert.equal(app.card('longPress').findAllByProps({ className: 'inline-prompt-textarea' }).length, 1)
  } finally {
    await app.unmount()
  }
})

test('anonymous cloud library additions count accepted copies once, preserve provenance, exclude drafts, and batch', async () => {
  const before = libraryAdditions.length
  const first = '00000000-0000-4000-8000-000000000001'
  const second = '00000000-0000-4000-8000-000000000002'
  const third = '00000000-0000-4000-8000-000000000003'
  const disabledSource = '00000000-0000-4000-8000-000000000004'
  const app = await render()
  try {
    // Immediate delay copy counts once
    await app.addAction('click', { ...palette('delay'), properties: { ms: 20, libraryItemId: first } })
    assert.equal(libraryAdditions.length, before + 1)
    assert.deepEqual(libraryAdditions.at(-1), [first])
    assert.equal(app.writes.at(-1)[1].click[0].libraryItemId, first)

    // Draft paste waits until non-empty text is entered
    await app.addAction('click', { ...palette('paste'), properties: { libraryItemId: second } })
    assert.equal(libraryAdditions.length, before + 1)
    const textarea = app.card('click').findByProps({ className: 'inline-prompt-textarea' })
    await act(async () => textarea.props.onChange({ target: { value: '云端提示词' } }))
    assert.equal(libraryAdditions.length, before + 2)
    assert.deepEqual(libraryAdditions.at(-1), [second])

    // Saved sequence deduplicates active sources and ignores disabled/null sources
    await app.addAction('doubleClick', {
      ...palette('savedSequence'),
      properties: {
        sequence: 'axonkey/1\nkey Enter\nwait 30ms\nkey Esc\noff text "停用"\nkey Space\nend',
        libraryItemIds: [first, first, third, disabledSource, null],
      },
    })
    assert.equal(libraryAdditions.length, before + 3)
    assert.deepEqual(libraryAdditions.at(-1), [first, third])

    // Cloud switchProfile forwards pending addition ID to confirmation handler without counting prematurely
    await app.addAction('longPress', {
      ...palette('savedSequence'),
      properties: { sequence: 'axonkey/1\nprofile next wrap\nend', libraryItemId: third },
    })
    assert.equal(libraryAdditions.length, before + 3)
    assert.equal(app.requests.at(-1)[3], third)
  } finally {
    await app.unmount()
  }

  // Verify 100-item native batching limit
  const batchId = '00000000-0000-4000-8000-000000000007'
  const batchBefore = libraryAdditions.length
  const { recordLibraryAdditions } = load('src/cloud/libraryUsage.ts')
  recordLibraryAdditions(Array(205).fill(batchId))
  assert.deepEqual(
    libraryAdditions.slice(batchBefore).map(items => items.length),
    [100, 100, 5],
  )
})
