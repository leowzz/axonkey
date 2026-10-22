import assert from 'node:assert/strict'
import test from 'node:test'
import { createBehavior, parseSequenceImport } from '../src/behaviorModel.ts'
import { createSavedSequence, parseSavedSequences } from '../src/savedSequences.ts'
import { insertedWorkflowSteps, behaviorsToWorkflow, workflowBranches, workflowToBehaviors } from '../src/components/workflowBehaviorBridge.ts'

const original = [
  createBehavior({ type: 'shortcut', keys: ['Ctrl', 'A'] }),
  createBehavior({ type: 'delay', ms: 30 }),
  createBehavior({ type: 'paste', text: '第一行\n第二行', enabled: false }),
]
const withoutIds = list => list.map(({ id, ...behavior }) => behavior)

test('saved sequences persist complete ordered independent snapshots and reusable inserts get fresh IDs', () => {
  const saved = createSavedSequence('  发送消息  ', original)
  assert.equal(saved.name, '发送消息')
  const restored = parseSavedSequences(JSON.stringify([saved]))
  assert.deepEqual(restored, [saved])
  assert.deepEqual(withoutIds(parseSequenceImport(saved.sequence)), withoutIds(original))
  const palette = { id: 'saved-drag', type: 'savedSequence', componentType: 'task', name: saved.name, properties: { sequence: saved.sequence } }
  const first = insertedWorkflowSteps(palette, 'windows', behavior => behavior.type)
  const second = insertedWorkflowSteps({ ...palette, id: 'second-drag' }, 'windows', behavior => behavior.type)
  const workflow = behaviorsToWorkflow({ click: [], doubleClick: [], longPress: [] }, behavior => behavior.type)
  workflowBranches(workflow).click.push(...first)
  workflowBranches(workflow).longPress.push(...second)
  const result = workflowToBehaviors(workflow)
  assert.deepEqual(withoutIds(result.click), withoutIds(original))
  assert.deepEqual(withoutIds(result.longPress), withoutIds(original))
  const ids = [...original, ...result.click, ...result.longPress].map(item => item.id)
  assert.equal(new Set(ids).size, ids.length)
  first[0].properties.keys.push('B')
  assert.deepEqual(second[0].properties.keys, ['Ctrl', 'A'])
  assert.deepEqual(parseSequenceImport(saved.sequence)[0].keys, ['Ctrl', 'A'])
  assert.deepEqual(original[0].keys, ['Ctrl', 'A'])
})

test('missing libraries start empty; corrupt libraries and incomplete entries are rejected as a whole', () => {
  assert.deepEqual(parseSavedSequences(null), [])
  const valid = createSavedSequence('test', original)
  for (const value of ['{', '{}', JSON.stringify([valid, { ...valid, id: 'bad', sequence: 'axonkey/1\ninvalid' }]), JSON.stringify([valid, valid]), JSON.stringify([{ ...valid, name: ' ' }]), JSON.stringify([{ ...valid, sequence: 'axonkey/1' }])]) assert.throws(() => parseSavedSequences(value))
  assert.throws(() => createSavedSequence(' ', original))
  assert.throws(() => createSavedSequence('empty', []))
})
