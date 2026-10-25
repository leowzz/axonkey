import test from 'node:test'
import assert from 'node:assert/strict'
import { migrateLegacyProfiles, updateInstanceSequence, applyInstanceProfileSwitch, removeInstanceProfileSwitch, addInstanceProfile } from '../src/devices/integration/instanceProfiles.ts'

const empty = () => ({ click: [], doubleClick: [], longPress: [] })
const action = { id: 'a', type: 'delay', enabled: true, ms: 50 }
const initial = () => ({ id: 'one', kind: 'rc003', profiles: [{ id: 'default', name: '默认配置', behaviors: {} }], activeProfileId: 'default' })
const legacy = () => [{ id: 'work', name: '工作', behaviors: { power: { ...empty(), click: [action] } } }, { id: 'media', name: '媒体', behaviors: {} }]

test('untouched first-instance configuration restores prior profiles once, without sharing data', () => {
  const source = legacy()
  const restored = migrateLegacyProfiles(initial(), source, 'media')
  assert.equal(restored.activeProfileId, 'media')
  assert.deepEqual(restored.profiles, source)
  restored.profiles[0].behaviors.power.click[0].ms = 100
  assert.equal(source[0].behaviors.power.click[0].ms, 50)
  restored.profiles = initial().profiles
  assert.equal(migrateLegacyProfiles(restored, source), restored, 'clearing mappings must not import them again')
})

test('migration preserves an edited, renamed, or multiple-profile instance and later physical instances', () => {
  for (const instance of [
    { ...initial(), profiles: [{ ...initial().profiles[0], behaviors: { power: { ...empty(), click: [action] } } }] },
    { ...initial(), profiles: [{ ...initial().profiles[0], name: '自定义' }] },
    { ...initial(), profiles: [...initial().profiles, { id: 'extra', name: '空白', behaviors: {} }] },
  ]) assert.deepEqual(migrateLegacyProfiles(instance, legacy()).profiles, instance.profiles)
  assert.deepEqual(migrateLegacyProfiles(initial(), []).profiles, initial().profiles)
})

test('workflow edits and profile changes are isolated between profiles and same-model devices', () => {
  const first = migrateLegacyProfiles(initial(), legacy())
  const second = structuredClone({ ...first, id: 'two' })
  const changed = updateInstanceSequence(first, 'work', 'power', { ...empty(), longPress: [action] })
  assert.equal(changed.profiles[0].behaviors.power.click.length, 0)
  assert.equal(changed.profiles[0].behaviors.power.longPress.length, 1)
  assert.equal(first.profiles[0].behaviors.power.click.length, 1)
  assert.deepEqual(changed.profiles[1], first.profiles[1])
  assert.deepEqual(second.profiles, first.profiles)
})

test('switch gestures survive new and duplicated profiles, and removal covers only the affected gesture', () => {
  const base = migrateLegacyProfiles(initial(), legacy())
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
