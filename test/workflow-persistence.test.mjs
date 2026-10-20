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
const copy = value => JSON.parse(JSON.stringify(value))
const cache = new Map()
function MockDialog(props) { return React.createElement('workflow-dialog', props) }
const Designer = {
  create(_canvas, definition, configuration) {
    const listeners = []
    const instance = {
      definition, configuration, destroyed: false,
      emit(changeType, stepId = null) {
        const event = { definition, changeType, stepId }
        return Promise.resolve().then(() => { for (const callback of listeners) callback(event) })
      },
      onReady: { subscribe() {} }, onDefinitionChanged: { subscribe(callback) { listeners.push(callback) } },
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
    if (name === '../appConfig') return { behaviorSummary: behavior => `${behavior.type}:${behavior.ms ?? behavior.text ?? behavior.key ?? ''}`, keyDisplayName: key => key, rightModifierChoices: () => [] }
    if (name === './workflowActionIcons') return { createWorkflowActionIconUrls: () => ({}) }
    if (name === './WorkflowToolbox') return { WorkflowToolbox: () => null }
    if (name === './WorkflowStepDialog') return { WorkflowStepDialog: MockDialog }
    if (name === './WorkflowTriggerRoot') {
      const original = load('src/components/WorkflowTriggerRoot.ts')
      return { ...original, createTriggerRootExtension: onToggle => ({ ...original.createTriggerRootExtension(onToggle), toggle: onToggle }) }
    }
    if (!name.startsWith('.')) return require(name)
    const path = resolve(dirname(file), name)
    return load(extname(path) ? path : existsSync(`${path}.tsx`) ? `${path}.tsx` : `${path}.ts`)
  }
  vm.runInNewContext(source, {
    module, exports: module.exports, require: localRequire, URL, console,
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
const toggleLane = (instance, trigger, disabled) => instance.configuration.extensions.find(extension => extension.rootComponent).rootComponent.toggle(trigger, disabled)
const render = async (sequences = empty()) => {
  let view
  const writes = []
  let props = { platform: 'windows', button: { id: 'tv', label: '电视键' }, sequences, onChange: (id, next) => writes.push([id, copy(next)]) }
  await act(async () => { view = Renderer.create(React.createElement(WorkflowAxonkey, { ...props, key: props.button.id }), { createNodeMock: () => ({}) }) })
  return {
    view, writes, current: () => instances.at(-1),
    update: async update => { props = { ...props, ...update }; await act(async () => view.update(React.createElement(WorkflowAxonkey, { ...props, key: props.button.id }))) },
    unmount: async () => act(async () => view.unmount()),
  }
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
    await app.update({ sequences: app.writes.at(-1)[1] })
    assert.equal(app.current(), instance)
    assert.equal(instance.destroyed, false)
    await act(async () => app.view.root.findByType('workflow-dialog').props.edit.onSave({ id: node.id, type: 'delay', enabled: true, ms: 751 }))
    assert.equal(app.writes.length, 2)
    assert.equal(app.writes.at(-1)[1].click[0].ms, 751)
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

test('lane switches autosave legacy disabled actions and shared undo restores the original sequence', async () => {
  const original = { click: [delay(751)], doubleClick: [], longPress: [] }
  const app = await render(original)
  try {
    const instance = app.current()
    await act(async () => toggleLane(instance, 'click', true))
    assert.equal(app.writes.length, 1)
    assert.equal(app.writes[0][0], 'tv')
    assert.equal(app.writes[0][1].click[0].type, 'disabled')
    assert.deepEqual(app.writes[0][1].doubleClick, [])
    await app.update({ sequences: app.writes.at(-1)[1] })
    assert.equal(app.current(), instance)
    const target = branches(instance).click
    assert.equal(instance.configuration.steps.canInsertStep(palette('paste'), target), false)
    assert.equal(instance.configuration.steps.isDeletable(target[0], target), false)
    await act(async () => toggleLane(instance, 'click', false))
    assert.deepEqual(app.writes.at(-1)[1].click, [])
    // Feed the previous shared-history snapshot back into the controlled component.
    await app.update({ sequences: original })
    assert.equal(branches(app.current()).click[0].properties.ms, 751)
    assert.equal(app.writes.length, 2)
  } finally { await app.unmount() }
})

test('legacy disabled actions loaded on any lane can be cleared without touching other lanes', async () => {
  const off = { id: 'off', type: 'disabled', enabled: true }
  const app = await render({ click: [delay(300)], doubleClick: [off], longPress: [off] })
  try {
    await act(async () => toggleLane(app.current(), 'longPress', false))
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
    await act(async () => app.view.root.findByType('workflow-dialog').props.edit.onSave({ id: node.id, type: 'openWebsite', enabled: true, url: 'example.com' }))
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
      const draft = app.view.root.findByType('workflow-dialog').props.edit.behavior
      assert.equal(draft.type, behaviorType)
      assert.equal(draft.direction, 'up')
      if (preset === 'cursorMove') assert.equal(draft.distance, 50)
      await act(async () => app.view.root.findByType('workflow-dialog').props.onClose())
      assert.equal(branches(instance).doubleClick.length, 0)
      assert.equal(app.writes.length, 0)
      await insert()
      const behavior = { id: `new-${preset}`, type: behaviorType, enabled: true, direction, ...parameters }
      await act(async () => app.view.root.findByType('workflow-dialog').props.edit.onSave(behavior))
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
      assert.deepEqual(copy(app.view.root.findByType('workflow-dialog').props.edit.behavior), { id: `new-${preset}`, enabled: true, ...options[0][1] })
      await act(async () => app.view.root.findByType('workflow-dialog').props.onClose())
      assert.equal(branches(instance).longPress.length, 0)
      assert.equal(app.writes.length, 0)
      await insert()
      const behavior = { id: `new-${preset}`, enabled: true, ...value }
      await act(async () => app.view.root.findByType('workflow-dialog').props.edit.onSave(behavior))
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
    await act(async () => app.view.root.findByType('workflow-dialog').props.onClose())
    assert.equal(branches(instance).doubleClick.length, 0)
    assert.equal(app.writes.length, 0)
    await insert('textAndEnter')
    assert.equal(app.writes.length, 0)
    await act(async () => app.view.root.findByType('workflow-dialog').props.edit.onSave({ id: 'new-textAndEnter', type: 'paste', enabled: true, text: '发送' }))
    assert.equal(app.writes.length, 1)
    assert.deepEqual(app.writes[0][1].doubleClick.map(item => item.type), ['paste', 'delay', 'key'])
    assert.deepEqual(app.writes[0][1].click, [delay(751)])
  } finally { await app.unmount() }
})
