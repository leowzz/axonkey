import assert from 'node:assert/strict'
import test from 'node:test'
import { createBehavior, createEmptyBehaviorMap } from '../src/behaviorModel.ts'
import { devices } from '../src/deviceModel.ts'
import {
  composeActiveProfileBehaviors, createDefaultDeviceProfiles, extractDeviceBehaviors,
  mergeDeviceBehaviors, migrateLegacyProfiles, parseStoredDeviceProfiles, snapshotDeviceProfiles,
} from '../src/deviceProfiles.ts'

function mapping(remote = 'A', mouse = 'B', a15 = 'V') {
  const behaviors = createEmptyBehaviorMap()
  behaviors.power.click = [createBehavior({ type: 'shortcut', keys: [remote], id: `remote-${remote}` })]
  behaviors['mouse.top.up'].click = [createBehavior({ type: 'key', key: mouse, id: `mouse-${mouse}` })]
  behaviors['cmiotA15.power'].click = [createBehavior({ type: 'key', key: a15, id: `a15-${a15}` })]
  return behaviors
}

function assertOwned(profile) {
  for (const device of devices.filter(device => device.id !== profile.deviceId)) {
    for (const input of device.inputIds) assert.deepEqual(profile.behaviors[input], { click: [], doubleClick: [], longPress: [] })
  }
}

test('extracting and merging device maps cannot import unrelated inputs or share mutable actions', () => {
  const original = mapping()
  const before = structuredClone(original)
  const extracted = extractDeviceBehaviors(original, 'rc003')
  assert.deepEqual(extracted.power, original.power)
  assert.deepEqual(extracted['mouse.top.up'].click, [])
  const merged = mergeDeviceBehaviors(original, 'mouse', mapping('WRONG', 'NEW'))
  assert.deepEqual(merged.power, original.power)
  assert.equal(merged['mouse.top.up'].click[0].key, 'NEW')
  extracted.power.click[0].keys[0] = 'changed'
  merged.power.click[0].keys[0] = 'also changed'
  merged['mouse.top.up'].click[0].key = 'changed'
  assert.deepEqual(original, before)
})

test('legacy profiles split deterministically while preserving each device order, names and active choice', () => {
  const legacy = [{ id: 'work', name: '工作', behaviors: mapping() }, { id: 'play', name: '娱乐', behaviors: mapping('C', 'D') }]
  const before = structuredClone(legacy)
  const migrated = migrateLegacyProfiles(legacy, 'play')
  assert.deepEqual(migrated.activeProfileIds, { rc003: 'rc003:play', cmiotA15: 'cmiotA15:play', mouse: 'mouse:play' })
  assert.deepEqual(migrated.profiles.map(({ id, name, deviceId }) => ({ id, name, deviceId })), [
    { id: 'rc003:work', name: '工作', deviceId: 'rc003' }, { id: 'rc003:play', name: '娱乐', deviceId: 'rc003' },
    { id: 'cmiotA15:work', name: '工作', deviceId: 'cmiotA15' }, { id: 'cmiotA15:play', name: '娱乐', deviceId: 'cmiotA15' },
    { id: 'mouse:work', name: '工作', deviceId: 'mouse' }, { id: 'mouse:play', name: '娱乐', deviceId: 'mouse' },
  ])
  migrated.profiles.forEach(assertOwned)
  assert.deepEqual(composeActiveProfileBehaviors(migrated.profiles, migrated.activeProfileIds), legacy[1].behaviors)
  assert.deepEqual(migrateLegacyProfiles(legacy, 'play'), migrated)
  migrated.profiles[0].behaviors.power.click[0].keys.push('Shift')
  assert.deepEqual(legacy, before)
  assert.deepEqual(migrateLegacyProfiles(legacy, 'missing').activeProfileIds, { rc003: 'rc003:work', cmiotA15: 'cmiotA15:work', mouse: 'mouse:work' })
})

test('snapshots persist all active live maps and composition independently selects each device profile', () => {
  const state = migrateLegacyProfiles([
    { id: 'work', name: '工作', behaviors: mapping() }, { id: 'play', name: '娱乐', behaviors: mapping('C', 'D') },
  ], 'work')
  const activeProfileIds = { rc003: 'rc003:work', cmiotA15: 'cmiotA15:play', mouse: 'mouse:play' }
  const live = mapping('EDITED REMOTE', 'EDITED MOUSE', 'EDITED A15')
  const before = structuredClone(state)
  const snapshots = snapshotDeviceProfiles(state.profiles, activeProfileIds, live)
  assert.deepEqual(composeActiveProfileBehaviors(snapshots, activeProfileIds), live)
  assert.deepEqual(snapshots[1].behaviors, state.profiles[1].behaviors)
  assert.deepEqual(snapshots[2].behaviors, state.profiles[2].behaviors)
  snapshots.forEach(assertOwned)
  snapshots[0].behaviors.power.click[0].keys.push('Ctrl')
  snapshots.find(p => p.id === 'mouse:play').behaviors['mouse.top.up'].click[0].key = 'changed'
  snapshots.find(p => p.id === 'cmiotA15:play').behaviors['cmiotA15.power'].click[0].key = 'changed'
  assert.deepEqual(live, mapping('EDITED REMOTE', 'EDITED MOUSE', 'EDITED A15'))
  assert.deepEqual(state, before)
})

test('old local storage repairs missing and duplicate IDs without losing entries or changing on reread', () => {
  const value = { version: 1, activeProfileId: 'same', profiles: [
    { id: 'same', name: '  工作\u0000 ', behaviors: mapping() },
    { id: 'same', name: '娱乐', behaviors: mapping('C', 'D') },
    { name: '', behaviors: mapping('E', 'F') },
  ] }
  const parsed = parseStoredDeviceProfiles(JSON.stringify(value), createEmptyBehaviorMap())
  assert.equal(parsed.profiles.length, 9)
  assert.equal(new Set(parsed.profiles.map(profile => profile.id)).size, 9)
  assert.deepEqual(parsed.activeProfileIds, { rc003: 'rc003:same', cmiotA15: 'cmiotA15:same', mouse: 'mouse:same' })
  assert.equal(parsed.profiles[0].name, '工作')
  assert.equal(parsed.profiles[1].behaviors.power.click[0].keys[0], 'C')
  assert.deepEqual(parseStoredDeviceProfiles(value, createEmptyBehaviorMap()), parsed)
})

test('v2 reload enforces device ownership, repairs the active choice and fills only a missing device', () => {
  const fallback = mapping('FALLBACK REMOTE', 'FALLBACK MOUSE')
  const parsed = parseStoredDeviceProfiles({ version: 2, activeProfileIds: { rc003: 'mouse-profile', mouse: 'remote-profile' }, profiles: [
    { id: 'remote-profile', name: '工作', deviceId: 'rc003', behaviors: mapping('STORED', 'CONTAMINATION') },
    { id: 'future-profile', name: '未来设备', deviceId: 'future', behaviors: mapping() },
  ] }, fallback)
  assert.equal(parsed.profiles.length, 3)
  assert.deepEqual(parsed.activeProfileIds, { rc003: 'remote-profile', cmiotA15: 'cmiotA15:default', mouse: 'mouse:default' })
  parsed.profiles.forEach(assertOwned)
  const runtime = composeActiveProfileBehaviors(parsed.profiles, parsed.activeProfileIds)
  assert.equal(runtime.power.click[0].keys[0], 'STORED')
  assert.equal(runtime['mouse.top.up'].click[0].key, 'FALLBACK MOUSE')
  assert.deepEqual(parseStoredDeviceProfiles({ version: 2, ...parsed }, fallback), parsed)
})

test('default and unreadable storage preserve the existing runtime settings for all devices', () => {
  const behaviors = mapping()
  const expected = createDefaultDeviceProfiles(behaviors)
  for (const value of [null, 'invalid', {}, { profiles: [] }, { version: 999, profiles: [] }]) {
    const state = parseStoredDeviceProfiles(value, behaviors)
    assert.deepEqual(state, expected)
    assert.deepEqual(composeActiveProfileBehaviors(state.profiles, state.activeProfileIds), behaviors)
  }
})
