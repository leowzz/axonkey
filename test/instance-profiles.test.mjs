import test from 'node:test'
import assert from 'node:assert/strict'
import {
  updateInstanceSequence,
  applyInstanceProfileSwitch,
  removeInstanceProfileSwitch,
  addInstanceProfile,
  createInstanceBehaviorHistory,
  instanceBehaviorHistoryReducer,
  replaceInstanceProfileBehaviors,
} from '../src/devices/integration/instanceProfiles.ts'

const empty = () => ({ click: [], doubleClick: [], longPress: [] })
const action = { id: 'a', type: 'delay', enabled: true, ms: 50 }
const initial = () => ({ id: 'one', kind: 'rc003', profiles: [{ id: 'default', name: '默认配置', behaviors: {} }], activeProfileId: 'default' })
const profiles = () => [{ id: 'work', name: '工作', behaviors: { power: { ...empty(), click: [action] } } }, { id: 'media', name: '媒体', behaviors: {} }]





test('workflow edits and profile changes are isolated between profiles and same-model devices', () => {
  const first = { ...initial(), profiles: profiles(), activeProfileId: 'work' }
  const second = structuredClone({ ...first, id: 'two' })
  const changed = updateInstanceSequence(first, 'work', 'power', { ...empty(), longPress: [action] })
  assert.equal(changed.profiles[0].behaviors.power.click.length, 0)
  assert.equal(changed.profiles[0].behaviors.power.longPress.length, 1)
  assert.equal(first.profiles[0].behaviors.power.click.length, 1)
  assert.deepEqual(changed.profiles[1], first.profiles[1])
  assert.deepEqual(second.profiles, first.profiles)
})

test('switch gestures survive new and duplicated profiles, and removal covers only the affected gesture', () => {
  const base = { ...initial(), profiles: profiles(), activeProfileId: 'work' }
  const switched = applyInstanceProfileSwitch(base, 'power', 'longPress', { id: 'switch', type: 'switchProfile', enabled: true, direction: 'next', wrap: true })
  const blank = addInstanceProfile(switched, false)
  const copy = addInstanceProfile(switched, true)
  assert.equal(blank.profiles.at(-1).behaviors.power.click.length, 0)
  assert.equal(blank.profiles.at(-1).behaviors.power.longPress[0].type, 'switchProfile')
  assert.equal(copy.profiles.at(-1).behaviors.power.click[0].type, 'delay')
  const cleared = removeInstanceProfileSwitch(switched, 'work', 'power', ['longPress'], { ...empty(), click: [action] })
  assert.ok(cleared.profiles.every(p => p.behaviors.power.longPress.length === 0))
  assert.equal(cleared.profiles[0].behaviors.power.click[0].type, 'delay')
  assert.equal(switched.profiles[0].behaviors.power.longPress.length, 1)
})

test('instance behavior history supports undo, redo, canonical sync and profile isolation', () => {
  const stepA = { id: 'step-a', type: 'key', enabled: true, key: 'Space' }
  const stepB = { id: 'step-b', type: 'delay', enabled: true, ms: 80 }
  let history = createInstanceBehaviorHistory('work', {})

  assert.strictEqual(instanceBehaviorHistoryReducer(history, { type: 'change', inputId: 'power', sequences: empty() }), history)

  history = instanceBehaviorHistoryReducer(history, { type: 'change', inputId: 'power', sequences: { ...empty(), click: [stepA] } })
  history = instanceBehaviorHistoryReducer(history, { type: 'change', inputId: 'voice', sequences: { ...empty(), longPress: [stepB] } })
  assert.equal(history.past.length, 2)
  assert.equal(history.future.length, 0)

  const reorderedFromBackend = {
    voice: { click: [], doubleClick: [], longPress: [{ enabled: true, id: 'step-b', ms: 80, type: 'delay' }] },
    power: { click: [{ enabled: true, id: 'step-a', key: 'Space', type: 'key' }], doubleClick: [], longPress: [] },
    home: empty(),
  }
  assert.strictEqual(
    instanceBehaviorHistoryReducer(history, { type: 'sync', profileId: 'work', present: reorderedFromBackend }),
    history,
    'backend key-sorted poll snapshots preserve undo and redo stacks',
  )

  history = instanceBehaviorHistoryReducer(history, { type: 'undo' })
  assert.equal(history.past.length, 1)
  assert.equal(history.future.length, 1)
  assert.equal(history.present.voice, undefined)
  assert.equal(history.present.power.click[0].key, 'Space')

  const updatedInstance = replaceInstanceProfileBehaviors(
    { ...initial(), profiles: profiles(), activeProfileId: 'work' },
    'work',
    history.present,
  )
  assert.equal(updatedInstance.profiles[0].behaviors.power.click[0].key, 'Space')
  assert.deepEqual(updatedInstance.profiles[1], profiles()[1])

  history = instanceBehaviorHistoryReducer(history, { type: 'redo' })
  assert.equal(history.present.voice.longPress[0].ms, 80)

  const switchedProfile = instanceBehaviorHistoryReducer(history, {
    type: 'sync',
    profileId: 'media',
    present: { home: { ...empty(), click: [stepA] } },
  })
  assert.equal(switchedProfile.profileId, 'media')
  assert.equal(switchedProfile.past.length, 0)
  assert.equal(switchedProfile.future.length, 0)
  assert.strictEqual(instanceBehaviorHistoryReducer(switchedProfile, { type: 'undo' }), switchedProfile)
})
