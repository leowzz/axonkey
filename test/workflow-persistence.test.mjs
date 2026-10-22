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
const library = require('sequential-workflow-designer')
const instances = []
const storage = new Map()
let storageFailure = false
const copiedSequences = []
function MockSaveDialog(props) { return React.createElement('sequence-save-dialog', props) }
function MockPasteDialog(props) { return React.createElement('sequence-paste-dialog', props) }
function MockToolbox() { return null }
const copy = value => JSON.parse(JSON.stringify(value))
const cache = new Map()
function MockDialog(props) { return React.createElement('workflow-dialog', props) }
const Designer = {
  create(_canvas, definition, configuration) {
    const listeners = []
    const instance = {
      definition, configuration, destroyed: false, coalesceChanges: false, delivering: false,
      emit(changeType, stepId = null) {
        if (this.coalesceChanges && this.delivering) return Promise.resolve()
        const event = { definition, changeType, stepId }
        return Promise.resolve().then(() => {
          this.delivering = true
          try { for (const callback of listeners) callback(event) }
          finally { this.delivering = false }
        })
      },
      onReady: { subscribe() {} }, onDefinitionChanged: { subscribe(callback) { listeners.push(callback) } },
      onSelectedStepIdChanged: new library.SimpleEvent(), onRootComponentUpdated: new library.SimpleEvent(),
      onIsDraggingChanged: new library.SimpleEvent(),
      getDefinition: () => definition,
      isDragging: () => false, updateLayout() {}, resetViewport() {}, destroy() { this.destroyed = true },
    }
    const api = { editor: {
      isReadonly: () => false, getDefinition: () => definition,
      createStepEditorContext: id => ({
        notifyChildrenChanged: () => instance.emit(library.DefinitionChangeType.stepChildrenChanged, id),
      }),
    } }
    for (const extension of configuration.extensions) {
      for (const component of extension.uiComponents ?? []) component.create({ appendChild() {} }, api)
    }
    instances.push(instance)
    return instance
  },
}

function load(file) {
  file = resolve(file)
  if (cache.has(file)) return cache.get(file).exports
  const module = { exports: {} }
  cache.set(file, module)
  const source = ts.transpileModule(readFileSync(file, 'utf8'), { compilerOptions: {
    module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020, jsx: ts.JsxEmit.ReactJSX,
  } }).outputText
  const localRequire = name => {
    if (name.endsWith('.css')) return {}
    if (name === 'sequential-workflow-designer') return { ...library, Designer }
    if (name === 'react-dom') return { createPortal: node => node }
    if (name === '../appConfig') return { triggerLabels: { click: '单击', doubleClick: '双击', longPress: '长按' }, behaviorSummary: behavior => `${behavior.type}:${behavior.ms ?? behavior.text ?? behavior.key ?? ''}`, keyDisplayName: key => key, rightModifierChoices: () => [] }
    if (name === './workflowActionIcons') return { createWorkflowActionIconUrls: () => ({}) }
    if (name === './WorkflowToolbox') return { WorkflowToolbox: MockToolbox }
    if (name === '../clipboard') return { writeClipboardText: async text => { copiedSequences.push(text) } }
    if (name === './BehaviorEditor') return { SequencePasteDialog: MockPasteDialog }
    if (name === './WorkflowSequenceSaveDialog') return { WorkflowSequenceSaveDialog: MockSaveDialog }
    if (name === './WorkflowStepDialog') return { WorkflowStepDialog: MockDialog }
    if (name === './WorkflowTriggerRoot') {
      const original = load('src/components/WorkflowTriggerRoot.ts')
      return { ...original, createTriggerRootExtension: (onClear, onScroll, onAction) => ({ ...original.createTriggerRootExtension(onClear, onScroll, onAction), clear: onClear, action: onAction }) }
    }
    if (!name.startsWith('.')) return require(name)
    const path = resolve(dirname(file), name)
    return load(extname(path) ? path : existsSync(`${path}.tsx`) ? `${path}.tsx` : `${path}.ts`)
  }
  vm.runInNewContext(source, {
    module, exports: module.exports, require: localRequire, URL, console, crypto: globalThis.crypto,
    window: { addEventListener() {}, removeEventListener() {}, setTimeout, clearTimeout, localStorage: {
      getItem: key => storage.get(key) ?? null,
      setItem: (key, value) => { if (storageFailure) throw new Error('Storage full'); storage.set(key, value) },
    } },
    document: { body: {}, createElement: () => ({ setAttribute() {}, remove() {} }) },
    ResizeObserver: class { observe() {} disconnect() {} },
  }, { filename: file })
  return module.exports
}

const { WorkflowAxonkey } = load('src/components/WorkflowAxonkey.tsx')
const empty = () => ({ click: [], doubleClick: [], longPress: [] })
const delay = ms => ({ id: 'wait', type: 'delay', enabled: true, ms })
const palette = type => ({ id: `new-${type}`, type, componentType: 'task', name: type, properties: { preset: type } })
const branches = instance => instance.definition.sequence[0].branches
const clearLane = (instance, trigger) => instance.configuration.extensions.find(extension => extension.rootComponent).rootComponent.clear(trigger)
const render = async (sequences = empty()) => {
  let view
  const writes = []
  let props = { toolboxCategory: 'all', onToolboxCategoryChange() {}, platform: 'windows', button: { id: 'tv', label: '电视键' }, sequences, onChange: (id, next) => writes.push([id, copy(next)]) }
  await act(async () => { view = Renderer.create(React.createElement(WorkflowAxonkey, { ...props, key: props.button.id }), { createNodeMock: () => ({ addEventListener() {}, removeEventListener() {}, setAttribute() {}, classList: { toggle() {} } }) }) })
  return {
    view, writes, current: () => instances.at(-1),
    update: async update => { props = { ...props, ...update }; await act(async () => view.update(React.createElement(WorkflowAxonkey, { ...props, key: props.button.id }))) },
    unmount: async () => act(async () => view.unmount()),
  }
}
const openContextEditor = async (app, trigger, index = 0) => {
  const instance = app.current()
  const branch = branches(instance)[trigger]
  const provider = instance.configuration.extensions.find(extension => extension.contextMenu).contextMenu.createItemsProvider()
  await act(async () => provider.getItems(branch[index], branch)[0].callback())
  return app.view.root.findByType('workflow-dialog')
}

test('workflow changes autosave once, and the save echo retains the designer and viewport', async () => {
  const app = await render()
  try {
    const instance = app.current()
    assert.equal(app.writes.length, 0, 'loading must not write empty mappings')
    const node = palette('delay')
    branches(instance).click.push(node)
    await act(async () => instance.emit(library.DefinitionChangeType.stepInserted, node.id))
    assert.equal(app.writes.length, 1)
    assert.equal(app.writes[0][0], 'tv')
    assert.equal(app.writes[0][1].click[0].ms, 300)
    assert.equal(app.view.root.findAllByType('workflow-dialog').length, 0)
    await app.update({ sequences: app.writes.at(-1)[1] })
    assert.equal(app.current(), instance)
    assert.equal(instance.destroyed, false)
    const dialog = await openContextEditor(app, 'click')
    await act(async () => dialog.props.edit.onSave({ id: node.id, type: 'delay', enabled: true, ms: 751 }))
    assert.equal(app.writes.length, 2)
    assert.equal(app.writes.at(-1)[1].click[0].ms, 751)
  } finally { await app.unmount() }
})

test('a dropped block autosaves when the real designer coalesces its nested normalization event', async () => {
  const app = await render()
  try {
    const instance = app.current()
    // sequential-workflow-designer's race() drops changes emitted during
    // delivery of the current event; normalization cannot depend on a second event.
    instance.coalesceChanges = true
    const node = palette('delay')
    branches(instance).doubleClick.push(node)
    await act(async () => instance.emit(library.DefinitionChangeType.stepInserted, node.id))
    assert.equal(app.writes.length, 1)
    assert.equal(app.writes[0][1].doubleClick[0].ms, 300)
    await app.update({ sequences: app.writes[0][1] })
    assert.equal(app.current(), instance)
    assert.equal(app.writes.length, 1)
  } finally { await app.unmount() }
})

test('external undo/reset replaces the canvas without saving the discarded definition back', async () => {
  const app = await render({ ...empty(), click: [delay(751)] })
  try {
    const previous = app.current()
    await app.update({ sequences: empty() })
    assert.equal(previous.destroyed, true)
    assert.notEqual(app.current(), previous)
    assert.equal(branches(app.current()).click.length, 0)
    assert.equal(app.writes.length, 0)
    await act(async () => previous.emit(library.DefinitionChangeType.stepDeleted, 'wait'))
    assert.equal(app.writes.length, 0, 'events from a destroyed designer must be ignored')
  } finally { await app.unmount() }
})

test('the first custom context-menu action reopens an editable block and disabled lanes have no edit action', async () => {
  const app = await render({ ...empty(), click: [delay(751)] })
  try {
    const instance = app.current()
    const provider = instance.configuration.extensions.find(extension => extension.contextMenu).contextMenu.createItemsProvider()
    const branch = branches(instance).click
    const [edit] = provider.getItems(branch[0], branch)
    assert.equal(edit.label, '编辑')
    assert.ok(edit.order < 0, 'edit precedes the library title and built-in actions')
    assert.equal(provider.getItems(null, branch).length, 0)
    assert.equal(provider.getItems({ ...branch[0], type: 'mediaPlayPause' }, branch).length, 0)
    assert.equal(provider.getItems(branch[0], [...branch, { type: 'disabled', properties: {} }]).length, 0)
    await act(async () => edit.callback())
    const dialog = app.view.root.findByType('workflow-dialog')
    assert.equal(dialog.props.edit.behavior.ms, 751)
    await act(async () => dialog.props.edit.onSave({ ...delay(900) }))
    assert.equal(app.writes.at(-1)[1].click[0].ms, 900)
  } finally { await app.unmount() }
})

test('clear autosaves once, keeps other lanes editable and shared undo restores the complete sequence', async () => {
  const original = { click: [delay(751), { ...delay(900), id: 'wait-2' }], doubleClick: [{ ...delay(300), id: 'double' }], longPress: [] }
  const app = await render(original)
  try {
    const instance = app.current()
    await act(async () => clearLane(instance, 'click'))
    assert.equal(app.writes.length, 1)
    assert.equal(app.writes[0][0], 'tv')
    assert.deepEqual(app.writes[0][1].click, [])
    assert.deepEqual(app.writes[0][1].doubleClick, original.doubleClick)
    await app.update({ sequences: app.writes.at(-1)[1] })
    assert.equal(app.current(), instance)
    const target = branches(instance).click
    assert.equal(instance.configuration.steps.canInsertStep(palette('paste'), target), true)
    await act(async () => clearLane(instance, 'click'))
    assert.equal(app.writes.length, 1, 'repeated clear must not save or add an undo entry')
    // Feed the previous shared-history snapshot back into the controlled component.
    await app.update({ sequences: original })
    assert.deepEqual(branches(app.current()).click.map(step => step.properties.ms), [751, 900])
    assert.equal(app.writes.length, 1)
  } finally { await app.unmount() }
})

test('legacy disabled actions loaded on any lane can be cleared without touching other lanes', async () => {
  const off = { id: 'off', type: 'disabled', enabled: true }
  const app = await render({ click: [delay(300)], doubleClick: [off], longPress: [off] })
  try {
    await act(async () => clearLane(app.current(), 'longPress'))
    assert.deepEqual(app.writes[0][1], { click: [delay(300)], doubleClick: [off], longPress: [] })
  } finally { await app.unmount() }
})

test('confirmed website targets use the same normalized value in the node and stored mapping', async () => {
  const app = await render()
  try {
    const instance = app.current()
    const node = palette('openWebsite')
    branches(instance).click.push(node)
    await act(async () => instance.emit(library.DefinitionChangeType.stepInserted, node.id))
    const dialog = await openContextEditor(app, 'click')
    await act(async () => dialog.props.edit.onSave({ id: node.id, type: 'openWebsite', enabled: true, url: 'example.com' }))
    assert.equal(branches(instance).click[0].properties.url, 'https://example.com/')
    assert.equal(app.writes.length, 1)
    assert.equal(app.writes[0][1].click[0].url, 'https://example.com/')
  } finally { await app.unmount() }
})

for (const [preset, behaviorType, nodePrefix, parameters] of [
  ['wheel', 'wheel', 'wheel', {}],
  ['cursorMove', 'cursorMove', 'cursor', { distance: 123 }],
]) test(`${preset} opens a draft, cancels without saving, and commits a directional node for each choice`, async () => {
  for (const direction of ['up', 'down', 'left', 'right']) {
    const app = await render({ ...empty(), click: [delay(751)] })
    try {
      const instance = app.current()
      const insert = async () => {
        const node = palette(preset)
        branches(instance).doubleClick.push(node)
        await act(async () => instance.emit(library.DefinitionChangeType.stepInserted, node.id))
      }
      await insert()
      assert.equal(app.writes.length, 0)
      const firstDialog = await openContextEditor(app, 'doubleClick')
      const draft = firstDialog.props.edit.behavior
      assert.equal(draft.type, behaviorType)
      assert.equal(draft.direction, 'up')
      if (preset === 'cursorMove') assert.equal(draft.distance, 50)
      await act(async () => firstDialog.props.onClose())
      assert.equal(branches(instance).doubleClick.length, 1)
      assert.equal(app.writes.length, 0)
      // The close icon only dismisses the editor; explicit deletion removes
      // the draft before the next insertion in this test.
      branches(instance).doubleClick.splice(0, 1)
      await insert()
      const behavior = { id: `new-${preset}`, type: behaviorType, enabled: true, direction, ...parameters }
      const secondDialog = await openContextEditor(app, 'doubleClick')
      await act(async () => secondDialog.props.edit.onSave(behavior))
      assert.equal(app.writes.length, 1)
      const saved = app.writes[0][1]
      assert.deepEqual(saved.doubleClick, [behavior])
      assert.deepEqual(saved.click, [delay(751)])
      const node = branches(instance).doubleClick[0]
      assert.equal(node.type, `${nodePrefix}${direction[0].toUpperCase()}${direction.slice(1)}`)
      assert.equal(node.properties.draftGroup, undefined)
      await app.update({ sequences: saved })
      assert.equal(app.current(), instance)
    } finally { await app.unmount() }
  }
})

test('grouped mouse and media actions cancel without writes and save each choice in the legacy format', async () => {
  const groups = [
    ['mouseButton', [
      ['mouseLeft', { type: 'mouse', button: 'left' }], ['mouseRight', { type: 'mouse', button: 'right' }],
    ]],
    ['volumeControl', [
      ['volumeUp', { type: 'key', key: 'VolumeUp' }], ['volumeDown', { type: 'key', key: 'VolumeDown' }], ['volumeMute', { type: 'key', key: 'VolumeMute' }],
    ]],
    ['mediaTrack', [
      ['mediaPrevious', { type: 'key', key: 'MediaPrevious' }], ['mediaNext', { type: 'key', key: 'MediaNext' }],
    ]],
  ]
  for (const [preset, options] of groups) for (const [nodeType, value] of options) {
    const app = await render({ ...empty(), click: [delay(751)] })
    try {
      const instance = app.current()
      const insert = async () => {
        const node = palette(preset)
        branches(instance).longPress.push(node)
        await act(async () => instance.emit(library.DefinitionChangeType.stepInserted, node.id))
      }
      await insert()
      assert.equal(app.writes.length, 0)
      const firstDialog = await openContextEditor(app, 'longPress')
      assert.deepEqual(copy(firstDialog.props.edit.behavior), { id: `new-${preset}`, enabled: true, ...options[0][1] })
      await act(async () => firstDialog.props.onClose())
      assert.equal(branches(instance).longPress.length, 1)
      assert.equal(app.writes.length, 0)
      branches(instance).longPress.splice(0, 1)
      await insert()
      const behavior = { id: `new-${preset}`, enabled: true, ...value }
      const secondDialog = await openContextEditor(app, 'longPress')
      await act(async () => secondDialog.props.edit.onSave(behavior))
      assert.equal(app.writes.length, 1)
      assert.deepEqual(app.writes[0][1], { click: [delay(751)], doubleClick: [], longPress: [behavior] })
      assert.equal(branches(instance).longPress[0].type, nodeType)
      assert.equal(branches(instance).longPress[0].properties.draftGroup, undefined)
      await app.update({ sequences: app.writes[0][1] })
      assert.equal(app.current(), instance)
      assert.equal(instance.destroyed, false)
    } finally { await app.unmount() }
  }
})

test('switching inputs flushes a pending designer event into the outgoing input only', async () => {
  const app = await render({ ...empty(), click: [delay(751)] })
  try {
    const previous = app.current()
    branches(previous).click[0].properties.ms = 900
    // Switch before the designer publishes its batched change event.
    await app.update({ button: { id: 'power', label: '电源键' }, sequences: empty() })
    assert.deepEqual(app.writes, [['tv', { ...empty(), click: [delay(900)] }]])
    assert.equal(branches(app.current()).click.length, 0)
    await act(async () => previous.emit(library.DefinitionChangeType.stepPropertyChanged, 'wait'))
    assert.equal(app.writes.length, 1)
  } finally { await app.unmount() }
})

test('canceling incomplete actions keeps saved mappings intact; confirming a macro saves all steps together', async () => {
  const app = await render({ ...empty(), click: [delay(751)] })
  try {
    const instance = app.current()
    const insert = async type => {
      const node = palette(type)
      branches(instance).doubleClick.push(node)
      await act(async () => instance.emit(library.DefinitionChangeType.stepInserted, node.id))
    }
    await insert('openWebsite')
    assert.equal(app.writes.length, 0)
    const websiteDialog = await openContextEditor(app, 'doubleClick')
    await act(async () => websiteDialog.props.onClose())
    assert.equal(branches(instance).doubleClick.length, 1)
    assert.equal(app.writes.length, 0)
    branches(instance).doubleClick.splice(0, 1)
    await insert('textAndEnter')
    assert.equal(app.writes.length, 0)
    const textDialog = await openContextEditor(app, 'doubleClick')
    await act(async () => textDialog.props.edit.onSave({ id: 'new-textAndEnter', type: 'paste', enabled: true, text: '发送' }))
    assert.equal(app.writes.length, 1)
    assert.deepEqual(app.writes[0][1].doubleClick.map(item => item.type), ['paste', 'delay', 'key'])
    assert.deepEqual(app.writes[0][1].click, [delay(751)])
  } finally { await app.unmount() }
})

const laneAction = (app, trigger, action) => act(async () => app.current().configuration.extensions.find(extension => extension.rootComponent).rootComponent.action(trigger, action))

test('lane copy reads the live definition; paste replaces only its target and participates in shared undo', async () => {
  const before = { click: [delay(500)], doubleClick: [{ ...delay(700), id: 'other' }], longPress: [] }
  const app = await render(before)
  try {
    branches(app.current()).click[0].properties.ms = 750
    await laneAction(app, 'click', 'copy')
    assert.match(copiedSequences.at(-1), /wait 750ms/)
    await laneAction(app, 'longPress', 'paste')
    const dialog = app.view.root.findByType('sequence-paste-dialog')
    assert.equal(dialog.props.trigger, 'longPress')
    await act(async () => dialog.props.onApply([{ ...delay(750), id: 'pasted' }]))
    assert.deepEqual(app.writes.at(-1)[1].longPress, [{ ...delay(750), id: 'pasted' }])
    assert.deepEqual(app.writes.at(-1)[1].doubleClick, before.doubleClick)
    await app.update({ sequences: app.writes.at(-1)[1] })
    await app.update({ sequences: before })
    assert.equal(branches(app.current()).longPress.length, 0)
  } finally { await app.unmount() }
})

test('save persists a snapshot without modifying mappings, restores on reopen and supports deletion', async () => {
  storage.clear()
  const app = await render({ ...empty(), click: [delay(650)] })
  let reopened
  try {
    await laneAction(app, 'click', 'save')
    const dialog = app.view.root.findByType('sequence-save-dialog')
    await act(async () => { assert.equal(dialog.props.onSave('常用序列'), null) })
    assert.equal(app.writes.length, 0)
    const stored = JSON.parse(storage.get('axonkey.saved-sequences.v1'))
    assert.equal(stored[0].name, '常用序列')
    assert.match(stored[0].sequence, /wait 650ms/)
    reopened = await render()
    const toolbox = reopened.view.root.findByType(MockToolbox)
    const savedGroup = toolbox.props.palettes.find(palette => palette.name === '已保存').groups[0]
    assert.equal(savedGroup.steps[0].name, '常用序列')
    await act(async () => toolbox.props.onRemoveSavedSequence(stored[0].id))
    assert.deepEqual(JSON.parse(storage.get('axonkey.saved-sequences.v1')), [])
  } finally { await app.unmount(); if (reopened) await reopened.unmount() }
})

test('failed library writes keep the save dialog open and incomplete drafts cannot be copied or saved', async () => {
  storage.clear()
  const app = await render({ ...empty(), click: [delay(600)] })
  try {
    await laneAction(app, 'click', 'save')
    storageFailure = true
    const dialog = app.view.root.findByType('sequence-save-dialog')
    await act(async () => { assert.match(dialog.props.onSave('测试'), /保存失败/) })
    assert.equal(storage.has('axonkey.saved-sequences.v1'), false)
    assert.equal(app.view.root.findAllByType('sequence-save-dialog').length, 1)
    await act(async () => dialog.props.onClose())
    branches(app.current()).click[0].properties.draftGroup = 'draft'
    const copies = copiedSequences.length
    await laneAction(app, 'click', 'copy')
    await laneAction(app, 'click', 'save')
    assert.equal(copiedSequences.length, copies)
    assert.equal(app.view.root.findAllByType('sequence-save-dialog').length, 0)
  } finally { storageFailure = false; await app.unmount() }
})
