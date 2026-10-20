import assert from 'node:assert/strict'
import test from 'node:test'
import { createBehavior, createEmptyBehaviorMap, createMappingExport, parseMappingImport, parseStoredBehaviors } from '../src/behaviorModel.ts'
import { behaviorToWorkflowStep, behaviorsToWorkflow, insertedWorkflowSteps, isWorkflowLaneDisabled, setWorkflowLaneDisabled, updateWorkflowInput, workflowBranches, workflowToBehaviors } from '../src/components/workflowBehaviorBridge.ts'
import { workflowBehaviorProperties } from '../src/components/workflowStepEditing.ts'

const label = behavior => behavior.type
const empty = () => ({ click: [], doubleClick: [], longPress: [] })
const palette = (type, id = type) => ({ id, type, componentType: 'task', name: type, properties: { preset: type } })
const allBehaviors = [
  { type: 'key', key: 'RAlt' }, { type: 'shortcut', keys: ['Ctrl', 'RShift', 'A'] },
  { type: 'paste', text: '完整文本\n第二行' }, { type: 'paste', text: '' },
  { type: 'delay', ms: 0 }, { type: 'delay', ms: 300000 },
  { type: 'openApp', path: 'C:\\Program Files\\App\\app.exe' }, { type: 'openWebsite', url: 'https://example.com/' },
  ...['up', 'down', 'left', 'right'].flatMap(direction => [{ type: 'wheel', direction }, { type: 'cursorMove', direction, distance: 123 }]),
  ...['left', 'right', 'forward', 'back'].map(button => ({ type: 'mouse', button })),
  { type: 'disabled' },
].map((options, index) => createBehavior({ ...options, id: `old-${index}`, enabled: index % 2 === 0 }))

test('lane switches match the active legacy disabled action and change only their own trigger', () => {
  const off = createBehavior({ type: 'disabled', id: 'off' })
  const inactive = createBehavior({ type: 'disabled', enabled: false, id: 'inactive' })
  const sequences = { click: [allBehaviors[0]], doubleClick: [off], longPress: [inactive] }
  const workflow = behaviorsToWorkflow(sequences, label)
  const branches = workflowBranches(workflow)
  assert.equal(isWorkflowLaneDisabled(branches.click), false)
  assert.equal(isWorkflowLaneDisabled(branches.doubleClick), true)
  assert.equal(isWorkflowLaneDisabled(branches.longPress), false)
  assert.equal(setWorkflowLaneDisabled(workflow, 'doubleClick', true, label), false)
  assert.equal(setWorkflowLaneDisabled(workflow, 'click', true, label), true)
  let saved = workflowToBehaviors(workflow)
  assert.equal(saved.click.length, 1)
  assert.equal(saved.click[0].type, 'disabled')
  assert.equal(saved.click[0].enabled, true)
  assert.deepEqual(saved.doubleClick, [off])
  assert.deepEqual(saved.longPress, [inactive])
  assert.equal(setWorkflowLaneDisabled(workflow, 'doubleClick', false, label), true)
  saved = workflowToBehaviors(workflow)
  assert.deepEqual(saved.doubleClick, [])
  assert.equal(isWorkflowLaneDisabled(workflowBranches(behaviorsToWorkflow(saved, label)).click), true)
  assert.deepEqual(sequences.click, [allBehaviors[0]], 'switching must not mutate shared settings')
})

test('all legacy behavior types round trip across all triggers without changing IDs, flags or parameters', () => {
  const sequences = { click: allBehaviors, doubleClick: [...allBehaviors].reverse(), longPress: allBehaviors.slice(3) }
  const before = structuredClone(sequences)
  const workflow = behaviorsToWorkflow(sequences, label)
  assert.deepEqual(workflowToBehaviors(workflow), before)
  workflowBranches(workflow).click[1].properties.keys.push('B')
  assert.deepEqual(sequences, before, 'designer mutations must not alter shared state')
})

test('toolbox actions use the same key tokens and macro execution order as the old mapping page', () => {
  const expected = {
    escape: 'Esc', enter: 'Enter', space: 'Space', tab: 'Tab', rightCtrl: 'RCtrl', rightAlt: 'RAlt', rightCommand: 'RWin',
    arrowUp: 'Up', arrowDown: 'Down', arrowLeft: 'Left', arrowRight: 'Right', backspace: 'Backspace', delete: 'Delete',
    keyHome: 'Home', keyEnd: 'End', pageUp: 'PageUp', pageDown: 'PageDown', volumeUp: 'VolumeUp', volumeDown: 'VolumeDown',
    volumeMute: 'VolumeMute', mediaPlayPause: 'MediaPlayPause', mediaPrevious: 'MediaPrevious', mediaNext: 'MediaNext', mediaStop: 'MediaStop',
  }
  for (const platform of ['windows', 'macos']) {
    const read = preset => {
      const definition = behaviorsToWorkflow(empty(), label)
      workflowBranches(definition).click = insertedWorkflowSteps(palette(preset), platform, label)
      return workflowToBehaviors(definition).click
    }
    for (const [preset, key] of Object.entries(expected)) assert.deepEqual(read(preset), [{ id: preset, enabled: true, type: 'key', key }])
    assert.deepEqual(read('previousTab')[0].keys, ['Ctrl', 'Shift', 'Tab'])
    assert.deepEqual(read('nextTab')[0].keys, ['Ctrl', 'Tab'])
    const macro = read('deleteAllText')
    assert.deepEqual(macro.map(({ id, ...behavior }) => behavior), [
      { type: 'shortcut', enabled: true, keys: [platform === 'macos' ? 'Win' : 'Ctrl', 'C'] },
      { type: 'delay', enabled: true, ms: 30 },
      { type: 'shortcut', enabled: true, keys: [platform === 'macos' ? 'Win' : 'Ctrl', 'X'] },
    ])
    for (const preset of ['wheelUp', 'wheelDown', 'wheelLeft', 'wheelRight', 'mouseLeft', 'mouseRight', 'cursorUp', 'cursorDown', 'cursorLeft', 'cursorRight', 'delay']) {
      assert.equal(read(preset).length, 1, preset)
      assert.ok(read(preset)[0].enabled)
    }
  }
})

test('incomplete drafts, including text-and-enter macros, never leak into stored actions', () => {
  const sequences = { ...empty(), click: [allBehaviors[0]] }
  for (const preset of ['paste', 'customKey', 'openApp', 'openWebsite', 'textAndEnter']) {
    const workflow = behaviorsToWorkflow(sequences, label)
    const nodes = insertedWorkflowSteps(palette(preset), 'windows', label)
    workflowBranches(workflow).longPress.push(...nodes)
    assert.deepEqual(workflowToBehaviors(workflow), sequences)
    if (preset === 'textAndEnter') {
      nodes[0].properties = workflowBehaviorProperties(nodes[0], { id: nodes[0].id, enabled: true, type: 'paste', text: '确认发送' })
      for (const node of nodes) delete node.properties.draftGroup
      const saved = workflowToBehaviors(workflow)
      assert.deepEqual(saved.longPress.map(item => item.type), ['paste', 'delay', 'key'])
      assert.equal(saved.longPress[0].text, '确认发送')
      assert.equal(saved.longPress[1].ms, 30)
      assert.equal(saved.longPress[2].key, 'Enter')
    }
  }
})

test('move, duplicate, delete and clear retain order and independent trigger branches', () => {
  const workflow = behaviorsToWorkflow({ click: allBehaviors.slice(0, 3), doubleClick: [], longPress: [] }, label)
  const branches = workflowBranches(workflow)
  const moved = branches.click.splice(1, 1)[0]
  branches.doubleClick.push(moved)
  const copy = structuredClone(moved)
  copy.id = 'copy'
  branches.doubleClick.push(...insertedWorkflowSteps(copy, 'windows', label))
  branches.click.reverse()
  const saved = workflowToBehaviors(workflow)
  assert.deepEqual(saved.click.map(item => item.id), ['old-2', 'old-0'])
  assert.deepEqual(saved.doubleClick.map(item => item.id), ['old-1', 'copy'])
  assert.deepEqual(saved.doubleClick[1].keys, allBehaviors[1].keys)
  branches.click.length = 0
  assert.deepEqual(workflowToBehaviors(workflow).click, [])
  branches.longPress.push(palette('unknown'))
  assert.equal(workflowToBehaviors(workflow), null, 'invalid actions must not silently truncate a sequence')
})

test('saving targets an explicit input and preserves every other remote and mouse mapping', () => {
  const map = createEmptyBehaviorMap()
  const remote = { ...empty(), click: [allBehaviors[0]] }
  const mouse = { ...empty(), doubleClick: [allBehaviors[1]] }
  const first = updateWorkflowInput(map, 'power', remote)
  const second = updateWorkflowInput(first, 'mouse.top.up', mouse)
  assert.equal(map.power.click.length, 0)
  assert.equal(second.power, first.power)
  assert.equal(second.voice, map.voice)
  assert.deepEqual(second['mouse.top.up'], mouse)
  mouse.doubleClick[0] = { ...mouse.doubleClick[0], keys: ['B'] }
  assert.deepEqual(second['mouse.top.up'].doubleClick[0].keys, ['Ctrl', 'RShift', 'A'])
  assert.equal(updateWorkflowInput(second, 'power', structuredClone(remote)), second, 'save echoes do not add history')
})

test('legacy stored mappings and flow edits stay compatible with the existing JSON transfer format', () => {
  const old = parseStoredBehaviors({ power: 'Ctrl+V' })
  const sequences = workflowToBehaviors(behaviorsToWorkflow(old.power, label))
  assert.deepEqual(sequences, old.power)
  const map = updateWorkflowInput(old, 'tv', { ...empty(), longPress: allBehaviors })
  const exported = createMappingExport(map, true)
  const imported = parseMappingImport(JSON.stringify(exported))
  assert.deepEqual(imported.behaviors, map)
  assert.equal(imported.enabled, true)
  assert.deepEqual(workflowToBehaviors(behaviorsToWorkflow(imported.behaviors.tv, label)), map.tv)
})
