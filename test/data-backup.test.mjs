import assert from 'node:assert/strict'
import test from 'node:test'
import { backupFilename, createDataBackup, parseDataBackup, writeBackupStorage, restoreBackupStorage } from '../src/dataBackup.ts'
import { sampleData, legacyBackup, legacySampleData } from './fixtures/data-backup.mjs'
import { composeActiveProfileBehaviors } from '../src/deviceProfiles.ts'


test('backup round-trip preserves ordered profiles, active live edits, saved behaviors and all portable settings with a device-first structure', () => {
  const original = sampleData()
  const before = structuredClone(original)
  const document = createDataBackup(original, '1.0.14', new Date('2026-10-22T10:02:03Z'))
  assert.equal(document.version, 2)
  assert.deepEqual(document.profiles.map(profile => profile.deviceId), ['rc003', 'rc003', 'mouse', 'mouse'])
  assert.equal(document.profiles[0].keys.power.click[0].key, 'Esc')
  assert.equal(document.profiles[2].keys['top.up'].click[0].type, 'shortcut')
  assert.equal(document.profiles[0].keys['mouse.top.up'], undefined)
  assert.equal(document.profiles[2].keys.power, undefined)
  assert.equal(document.profiles[0].behaviors, undefined)
  assert.equal(document.savedBehaviors[0].behaviors[0].text, '多行\n文本')
  const restored = parseDataBackup(JSON.stringify(document))
  assert.deepEqual(restored.profiles.map(profile => profile.name), ['工作', '娱乐', '工作', '娱乐'])
  assert.deepEqual(restored.activeProfileIds, { rc003: 'rc003:play', mouse: 'mouse:work' })
  assert.deepEqual(restored.profiles[0].behaviors, original.profiles[0].behaviors)
  assert.deepEqual(restored.profiles[1].behaviors.tv, original.behaviors.tv)
  assert.deepEqual(restored.profiles[1].behaviors['mouse.top.up'].click, [])
  assert.equal(restored.profiles[2].behaviors['mouse.top.down'].click[0].id, 'live-mouse')
  assert.deepEqual(composeActiveProfileBehaviors(restored.profiles, restored.activeProfileIds), original.behaviors)
  assert.deepEqual(restored.savedSequences, original.savedSequences)
  assert.deepEqual(restored.settings, original.settings)
  assert.deepEqual(restored.audio, original.audio)
  assert.deepEqual(restored.preferences, original.preferences)
  assert.deepEqual(original, before)
  const secondExport = createDataBackup({ ...restored, behaviors: original.behaviors }, '1.0.14')
  assert.deepEqual(parseDataBackup(JSON.stringify(secondExport)).profiles, restored.profiles)
})

test('default backup filenames include the local timestamp and a JSON extension', () => {
  assert.equal(backupFilename(new Date(2026, 9, 22, 18, 2, 3)), 'axonkey-backup-20261022-180203.json')
})

test('malformed or newer backup data is rejected as a whole rather than silently dropping mappings', () => {
  const valid = createDataBackup(sampleData(), '1.0.14')
  for (const mutate of [
    data => { data.version = 3 },
    data => { data.profiles = [] },
    data => { data.profiles[1].id = data.profiles[0].id },
    data => { data.activeProfileIds.rc003 = 'missing' },
    data => { data.activeProfileIds.mouse = data.activeProfileIds.rc003 },
    data => { delete data.activeProfileIds.mouse },
    data => { data.activeProfileIds.joystick = data.activeProfileIds.rc003 },
    data => { data.profiles[0].deviceId = 'joystick' },
    data => { delete data.profiles[0].keys },
    data => { delete data.profiles[0].keys.voice },
    data => { data.profiles[0].keys.unknown = { click: [], doubleClick: [], longPress: [] } },
    data => { data.profiles[0].keys.power.click[0].type = 'future-action' },
    data => { delete data.profiles[0].keys.power.click[0].id },
    data => { data.profiles[0].keys.power.click[1].ms = -1 },
    data => { delete data.profiles[0].keys.power.longPress },
    data => { data.savedBehaviors[0].behaviors = [] },
    data => { data.savedBehaviors.push(structuredClone(data.savedBehaviors[0])) },
    data => { data.settings.mouseEdgeWidth = 0 },
    data => { data.audio.gain = 100 },
  ]) {
    const invalid = structuredClone(valid)
    mutate(invalid)
    assert.throws(() => parseDataBackup(JSON.stringify(invalid)))
  }
  assert.throws(() => parseDataBackup('{"format":'))
  assert.throws(() => parseDataBackup(JSON.stringify({ format: 'axonkey-mapping', version: 1 })))
})

test('restoring all backup keys preserves unrelated local system state and rolls back partial writes on failure', () => {
  const values = new Map([['profiles', 'old profiles'], ['settings', 'old settings'], ['setup', 'local permissions']])
  let failed = false
  const storage = {
    getItem: key => values.get(key) ?? null,
    setItem(key, value) {
      if (key === 'settings' && value === 'new settings' && !failed) { failed = true; throw new Error('Quota exceeded') }
      values.set(key, value)
    },
    removeItem: key => values.delete(key),
  }
  const original = new Map(values)
  assert.throws(() => writeBackupStorage(storage, { saved: 'new saved', profiles: 'new profiles', settings: 'new settings' }), /Quota/)
  assert.deepEqual(values, original)
  writeBackupStorage(storage, { saved: 'new saved', profiles: 'new profiles', settings: 'new settings' })
  assert.equal(values.get('profiles'), 'new profiles')
  assert.equal(values.get('settings'), 'new settings')
  assert.equal(values.get('saved'), 'new saved')
  assert.equal(values.get('setup'), 'local permissions')
})

test('restore writes compatible application storage and returns to backup settings after reload', () => {
  const data = parseDataBackup(JSON.stringify(createDataBackup(sampleData(), '1.0.14')))
  const values = new Map([['setup', 'local permissions']])
  const storage = { getItem: key => values.get(key) ?? null, setItem: (key, value) => values.set(key, value), removeItem: key => values.delete(key) }
  const keys = { profiles: 'profiles', settings: 'settings', savedSequences: 'saved', audio: 'audio', uiState: 'ui' }
  restoreBackupStorage(storage, data, keys, { activePage: 'mapping', settingsSection: 'mouse', selectedDeviceId: 'mouse', sidebarCollapsed: false })
  const read = key => JSON.parse(values.get(key))
  assert.deepEqual(read('profiles'), { version: 2, profiles: data.profiles, activeProfileIds: data.activeProfileIds })
  assert.deepEqual(read('settings'), { ...data.settings, behaviors: composeActiveProfileBehaviors(data.profiles, data.activeProfileIds) })
  assert.deepEqual(read('saved'), data.savedSequences)
  assert.deepEqual(read('audio'), data.audio)
  assert.deepEqual(read('ui'), { activePage: 'settings', settingsSection: 'backup', selectedDeviceId: 'mouse', sidebarCollapsed: true })
  assert.equal(values.get('setup'), 'local permissions')
})

test('version 1 backups split every legacy profile by device with deterministic IDs and preserve active mappings', () => {
  const document = legacyBackup()
  const data = parseDataBackup(JSON.stringify(document))
  assert.deepEqual(data.activeProfileIds, { rc003: 'rc003:play', mouse: 'mouse:play' })
  assert.deepEqual(data.profiles.map(profile => [profile.id, profile.deviceId, profile.name]), [
    ['rc003:work', 'rc003', '工作'], ['rc003:play', 'rc003', '娱乐'],
    ['mouse:work', 'mouse', '工作'], ['mouse:play', 'mouse', '娱乐'],
  ])
  assert.deepEqual(composeActiveProfileBehaviors(data.profiles, data.activeProfileIds), legacySampleData().behaviors)
  assert.deepEqual(parseDataBackup(JSON.stringify(document)).profiles, data.profiles)
  const exported = createDataBackup({ ...data, behaviors: composeActiveProfileBehaviors(data.profiles, data.activeProfileIds) }, '1.0.20')
  assert.deepEqual(parseDataBackup(JSON.stringify(exported)).profiles, data.profiles)
  delete document.profiles[0].devices.mouse
  assert.throws(() => parseDataBackup(JSON.stringify(document)))
})
