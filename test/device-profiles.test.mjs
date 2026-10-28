import assert from 'node:assert/strict'
import test from 'node:test'
import { createBehavior, createEmptyBehaviorMap } from '../src/behaviorModel.ts'
import { devices } from '../src/deviceModel.ts'
import {
  composeActiveProfileBehaviors, createDefaultDeviceProfiles, extractDeviceBehaviors,
  mergeDeviceBehaviors, parseStoredDeviceProfiles, snapshotDeviceProfiles,
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

test('shared and unversioned profile stores are not converted', () => {
  const fallback = createEmptyBehaviorMap()
  for (const version of [undefined, 1]) {
    assert.deepEqual(parseStoredDeviceProfiles({ version, activeProfileId: 'work', profiles: [
      { id: 'work', name: '工作', behaviors: mapping() },
    ] }, fallback), createDefaultDeviceProfiles(fallback))
  }
})

test('snapshots persist all active live maps and composition independently selects each device profile', () => {
  const state = { profiles: devices.flatMap(device => [
    { id: `${device.id}:work`, name: '工作', deviceId: device.id, behaviors: extractDeviceBehaviors(mapping(), device.id) },
    { id: `${device.id}:play`, name: '娱乐', deviceId: device.id, behaviors: extractDeviceBehaviors(mapping('C', 'D'), device.id) },
  ]) }
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
