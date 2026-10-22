import assert from 'node:assert/strict'
import test from 'node:test'
import { ClickCommandType, SelectStepBehaviorEndToken, Vector } from 'sequential-workflow-designer'
import { createWorkflowStepInteraction } from '../src/components/WorkflowStepInteraction.ts'
import { findWorkflowStepEditor, workflowBehaviorProperties, workflowStepBehavior } from '../src/components/workflowStepEditing.ts'
import { workflowActionChoiceGroup } from '../src/components/workflowActionChoices.ts'
import { behaviorToWorkflowStep } from '../src/components/workflowBehaviorBridge.ts'

const step = (type, properties = {}, id = type) => ({ id, type, componentType: 'task', name: type, properties: { preset: type, ...properties } })
const definition = (branches) => ({ properties: {}, sequence: [{
  id: 'triggers', type: 'axonkeyTriggers', componentType: 'switch', name: '触发方式', properties: {},
  branches: { click: [], doubleClick: [], longPress: [], ...branches },
}] })

test('editable blocks start with empty fields or the default delay', () => {
  for (const [type, expected] of [
    ['delay', { type: 'delay', ms: 300 }],
    ['paste', { type: 'paste', text: '' }],
    ['customKey', { type: 'shortcut', keys: [] }],
    ['openApp', { type: 'openApp', path: '' }],
    ['openWebsite', { type: 'openWebsite', url: '' }],
    ['cursorMove', { type: 'cursorMove', direction: 'up', distance: 50 }],
  ]) {
    assert.deepEqual(workflowStepBehavior(step(type)), { id: type, enabled: true, ...expected })
  }
  assert.equal(workflowStepBehavior(step('enter')), null)
})

test('saved values reopen on the same node with its current trigger', () => {
  const cases = [
    ['delay', { type: 'delay', ms: 751 }],
    ['paste', { type: 'paste', text: '第一行\n第二行' }],
    ['customKey', { type: 'shortcut', keys: ['Ctrl', 'Shift', 'A'] }],
    ['openApp', { type: 'openApp', path: 'C:\\Program Files\\Example\\App.exe' }],
    ['openWebsite', { type: 'openWebsite', url: 'https://example.com/' }],
    ['cursorMove', { type: 'cursorMove', direction: 'right', distance: 123 }],
  ]
  for (const [type, value] of cases) {
    const node = step(type, {}, 'original')
    const behavior = { id: node.id, enabled: true, ...value }
    node.properties = workflowBehaviorProperties(node, behavior)
    const original = definition({ doubleClick: [node] })
    const editor = findWorkflowStepEditor(original, node.id)
    assert.equal(editor.trigger, 'doubleClick')
    assert.deepEqual(editor.behavior, behavior)
    assert.equal(node.properties.preset, type)
    // A duplicated or moved node uses its own identity, rather than a stored behavior ID.
    const copy = structuredClone(node)
    copy.id = 'copy'
    assert.equal(findWorkflowStepEditor(definition({ longPress: [copy] }), 'copy').behavior.id, 'copy')
    assert.equal(findWorkflowStepEditor(original, 'missing'), null)
  }
})

test('key and shortcut edits replace each other without aliasing the dialog draft', () => {
  const node = step('customKey', { key: 'Enter' })
  const draft = { id: node.id, enabled: true, type: 'shortcut', keys: ['Ctrl', 'V'] }
  const properties = workflowBehaviorProperties(node, draft)
  assert.equal(node.properties.key, 'Enter')
  node.properties = properties
  draft.keys.push('A')
  assert.deepEqual(workflowStepBehavior(node).keys, ['Ctrl', 'V'])
  const reopened = workflowStepBehavior(node)
  reopened.keys.push('B')
  assert.deepEqual(node.properties.keys, ['Ctrl', 'V'])
  node.properties = workflowBehaviorProperties(node, { id: node.id, enabled: true, type: 'key', key: 'Space' })
  assert.deepEqual(workflowStepBehavior(node), { id: node.id, enabled: true, type: 'key', key: 'Space' })
})

test('saving validates targets and rejects incomplete or mismatched edits', () => {
  const behavior = (type, data) => ({ id: type, enabled: true, type, ...data })
  assert.equal(workflowBehaviorProperties(step('paste'), behavior('paste', { text: ' ' })), null)
  assert.equal(workflowBehaviorProperties(step('customKey'), behavior('shortcut', { keys: [] })), null)
  assert.equal(workflowBehaviorProperties(step('openApp'), behavior('openApp', { path: 'app.exe' })), null)
  assert.equal(workflowBehaviorProperties(step('openWebsite'), behavior('openWebsite', { url: 'javascript:alert(1)' })), null)
  assert.equal(workflowBehaviorProperties(step('paste'), behavior('openWebsite', { url: 'https://example.com' })), null)
  assert.equal(workflowBehaviorProperties(step('openWebsite'), behavior('openWebsite', { url: 'example.com' })).url, 'https://example.com/')
})

test('only a double click on the same node opens an editor', () => {
  const opened = []
  const extension = createWorkflowStepInteraction((id) => opened.push(id))
  let token = new SelectStepBehaviorEndToken('paste', 1000)
  const behavior = { onStart() {}, onMove() {}, onEnd() { return token } }
  const wrapped = extension.clickBehaviorWrapperExtension.create().wrap(behavior, {
    type: ClickCommandType.selectStep, component: { step: step('paste') },
  })
  assert.equal(wrapped.onEnd(false, null, null), token)
  assert.deepEqual(opened, [])
  const previous = token
  token = new SelectStepBehaviorEndToken('paste', 1250)
  assert.equal(wrapped.onEnd(false, null, previous), undefined)
  assert.deepEqual(opened, ['paste'])
  wrapped.onEnd(false, null, new SelectStepBehaviorEndToken('openApp', 1200))
  wrapped.onEnd(false, null, new SelectStepBehaviorEndToken('paste', 500))
  wrapped.onEnd(false, null, new SelectStepBehaviorEndToken('paste', 1500))
  wrapped.onEnd(true, null, null)
  assert.deepEqual(opened, ['paste'])
})

test('dragging switches to the designer drag behavior without opening an editor', () => {
  const opened = []
  const extension = createWorkflowStepInteraction((id) => opened.push(id))
  const drag = { onStart() {}, onMove() {}, onEnd() {} }
  const click = { onStart() {}, onMove() { return drag }, onEnd() {} }
  const wrapper = extension.clickBehaviorWrapperExtension.create()
  const wrapped = wrapper.wrap(click, { type: ClickCommandType.selectStep, component: { step: step('openApp') } })
  assert.equal(wrapped.onMove(new Vector(20, 0)), drag)
  drag.onEnd(false, null, null)
  assert.deepEqual(opened, [])
  assert.equal(wrapper.wrap(click, { type: ClickCommandType.selectStep, component: { step: step('enter') } }), click)
})

test('group completion runs synchronously after the designer drag ends, for editable and ordinary steps', () => {
  for (const type of ['openApp', 'enter']) {
    const calls = []
    const extension = createWorkflowStepInteraction(() => {}, (interrupt) => calls.push(['finish', interrupt]))
    const drag = { onStart() {}, onMove() {}, onEnd(interrupt) { calls.push(['designer', interrupt]) } }
    const click = { onStart() {}, onMove() { return drag }, onEnd() {} }
    const wrapped = extension.clickBehaviorWrapperExtension.create().wrap(click, { type: ClickCommandType.selectStep, component: { step: step(type) } })
    const next = wrapped.onMove(new Vector(20, 0))
    next.onEnd(false, null, null)
    assert.deepEqual(calls, [['designer', false], ['finish', false]])
  }
})

test('blank drags never invoke the designer pan behavior', () => {
  const extension = createWorkflowStepInteraction(() => {})
  const moved = []
  const behavior = {
    onStart(position) { moved.push(['start', position]) },
    onMove(delta) { moved.push(['move', delta]); return undefined },
    onEnd() { moved.push(['end']) },
  }
  const wrapped = extension.clickBehaviorWrapperExtension.create().wrap(behavior, null)
  const start = new Vector(32, 48)
  const delta = new Vector(120, 75)
  wrapped.onStart(start)
  wrapped.onMove(delta)
  wrapped.onEnd(false, null, null)
  assert.deepEqual(moved, [])
})

test('delay editing preserves nonnegative integers and rejects invalid durations', () => {
  const node = step('delay', { ms: 300 })
  for (const ms of [0, 1, 751, 300000]) {
    const properties = workflowBehaviorProperties(node, { id: 'delay', enabled: true, type: 'delay', ms })
    assert.equal(workflowStepBehavior({ ...node, properties }).ms, ms)
  }
  for (const ms of [-1, 1.5, NaN, Infinity, 300001]) {
    assert.equal(workflowBehaviorProperties(node, { id: 'delay', enabled: true, type: 'delay', ms }), null)
    assert.equal(workflowStepBehavior(step('delay', { ms })).ms, 300)
  }
  assert.equal(node.properties.ms, 300)
})

test('directional scroll nodes reopen with their direction and can change direction without changing identity or enabled state', () => {
  for (const direction of ['up', 'down', 'left', 'right']) {
    const node = step(`wheel${direction[0].toUpperCase()}${direction.slice(1)}`, { enabled: false }, 'old-wheel')
    const editor = findWorkflowStepEditor(definition({ longPress: [node] }), node.id)
    assert.deepEqual(editor.behavior, { id: 'old-wheel', enabled: false, type: 'wheel', direction })
    assert.equal(editor.trigger, 'longPress')
    const saved = workflowBehaviorProperties(node, { ...editor.behavior, direction: 'left' })
    assert.equal(saved.direction, 'left')
    assert.equal(saved.enabled, false)
  }
  assert.equal(workflowBehaviorProperties(step('wheel'), { id: 'wheel', type: 'wheel', enabled: true, direction: 'invalid' }), null)
})

test('legacy mouse and media choices reopen in their group and switch actions while preserving identity and flags', () => {
  const groups = [
    ['mouseButton', [{ type: 'mouse', button: 'left' }, { type: 'mouse', button: 'right' }]],
    ['volumeControl', ['VolumeUp', 'VolumeDown', 'VolumeMute'].map(key => ({ type: 'key', key }))],
    ['mediaTrack', ['MediaPrevious', 'MediaNext'].map(key => ({ type: 'key', key }))],
  ]
  for (const [preset, values] of groups) for (const value of values) {
    const original = { id: 'legacy', enabled: false, ...value }
    const node = behaviorToWorkflowStep(original, behavior => behavior.type)
    const editor = findWorkflowStepEditor(definition({ doubleClick: [node] }), node.id)
    assert.deepEqual(editor.behavior, original)
    assert.equal(workflowActionChoiceGroup(editor.behavior).preset, preset)
    for (const next of values) {
      const behavior = { id: 'legacy', enabled: false, ...next }
      assert.ok(workflowBehaviorProperties(node, behavior))
      assert.deepEqual(workflowStepBehavior(behaviorToWorkflowStep(behavior, () => 'choice')), behavior)
      const generic = step(preset)
      generic.properties = workflowBehaviorProperties(generic, behavior)
      assert.deepEqual(workflowStepBehavior(generic), { ...behavior, id: preset, enabled: true })
    }
    assert.equal(workflowBehaviorProperties(node, { id: 'bad', enabled: true, type: 'key', key: 'Enter' }), null)
    if (value.type === 'key') {
      const legacyKey = step('customKey', { key: value.key }, 'legacy')
      assert.equal(workflowActionChoiceGroup(workflowStepBehavior(legacyKey)).preset, preset)
    }
  }
  assert.equal(workflowActionChoiceGroup({ id: 'normal', enabled: true, type: 'key', key: 'Enter' }), undefined)
})
