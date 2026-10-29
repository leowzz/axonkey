import assert from 'node:assert/strict'
import test from 'node:test'
import { backupFilename, createDataBackup, parseDataBackup, writeBackupStorage, restoreBackupStorage } from '../src/dataBackup.ts'
import { sampleData, legacyBackup } from './fixtures/data-backup.mjs'
import { parseBackupImport, migrateBackupImport } from '../src/backupImport.ts'
import { createLegacyConfigExport, legacyProfilesKey } from '../src/configMigration.ts'
import { composeActiveProfileBehaviors } from '../src/deviceProfiles.ts'


test('backup round-trip preserves ordered profiles, active live edits, saved behaviors and all portable settings with a device-first structure', () => {
  const original = sampleData()
  const before = structuredClone(original)
  const document = createDataBackup(original, '1.0.14', new Date('2026-10-22T10:02:03Z'))
  assert.equal(document.version, 2)
  assert.deepEqual(document.profiles.map(profile => profile.deviceId), ['rc003', 'rc003', 'cmiotA15', 'cmiotA15', 'mouse', 'mouse'])
  assert.equal(document.profiles[0].keys.power.click[0].key, 'Esc')
  assert.equal(document.profiles[4].keys['top.up'].click[0].type, 'shortcut')
  assert.equal(document.profiles[0].keys['mouse.top.up'], undefined)
  assert.equal(document.profiles[4].keys.power, undefined)
  assert.equal(document.profiles[0].behaviors, undefined)
  assert.equal(document.savedBehaviors[0].behaviors[0].text, '多行\n文本')
  const restored = parseDataBackup(JSON.stringify(document))
  assert.deepEqual(restored.profiles.map(profile => profile.name), ['工作', '娱乐', '工作', '娱乐', '工作', '娱乐'])
  assert.deepEqual(restored.activeProfileIds, { rc003: 'rc003:play', cmiotA15: 'cmiotA15:work', mouse: 'mouse:work' })
  assert.deepEqual(restored.profiles[0].behaviors, original.profiles[0].behaviors)
  assert.deepEqual(restored.profiles[1].behaviors.tv, original.behaviors.tv)
  assert.deepEqual(restored.profiles[1].behaviors['mouse.top.up'].click, [])
  assert.equal(restored.profiles[4].behaviors['mouse.top.down'].click[0].id, 'live-mouse')
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
  assert.deepEqual(read('profiles'), { version: 2, migrationReviewed: true, profiles: data.profiles, activeProfileIds: data.activeProfileIds })
  assert.deepEqual(read('settings'), { ...data.settings, behaviors: composeActiveProfileBehaviors(data.profiles, data.activeProfileIds) })
  assert.deepEqual(read('saved'), data.savedSequences)
  assert.deepEqual(read('audio'), data.audio)
  assert.deepEqual(read('ui'), { activePage: 'settings', settingsSection: 'backup', selectedDeviceId: 'mouse', sidebarCollapsed: true })
  assert.equal(values.get('setup'), 'local permissions')
})

test('backups only accept the current version', () => {
  for (const version of [undefined, 1, 3]) {
    const document = createDataBackup(sampleData(), '1.0.20')
    document.version = version
    assert.throws(() => parseDataBackup(JSON.stringify(document)), /版本/)
  }
})

test('backups missing the middle-button group or individual inputs are rejected', () => {
  const backup = createDataBackup(sampleData(), '1.0.20')
  const middleKeys = ['global', 'top', 'left', 'right'].map(scope => `${scope}.buttonMiddle`)
  for (const profile of backup.profiles.filter(profile => profile.deviceId === 'mouse')) {
    for (const key of middleKeys) delete profile.keys[key]
  }
  assert.throws(() => parseDataBackup(JSON.stringify(backup)), /设备按键列表不完整/)
  const incomplete = createDataBackup(sampleData(), '1.0.20')
  delete incomplete.profiles.find(profile => profile.deviceId === 'mouse').keys['global.buttonMiddle']
  assert.throws(() => parseDataBackup(JSON.stringify(incomplete)), /设备按键列表不完整/)
})

test('backup import routes current backups normally and historical v1 backups through migration', () => {
  const current = createDataBackup(sampleData(), '1.0.20')
  assert.equal(parseBackupImport(JSON.stringify(current)).kind, 'current')
  const transitional = createDataBackup(sampleData(), '1.0.19')
  assert.equal(parseBackupImport(JSON.stringify(transitional)).kind, 'legacy', 'complete transitional v2 backups still need device-instance migration')
  const file = legacyBackup()
  const before = structuredClone(file)
  const imported = parseBackupImport(JSON.stringify(file))
  assert.equal(imported.kind, 'legacy')
  assert.equal(imported.plan.mouse.length, 2)
  assert.equal(imported.plan.mouseActiveId, imported.plan.mouse[1].id)
  assert.equal(imported.plan.remote.activeProfileId, imported.plan.remote.profiles[1].id)
  assert.equal(imported.plan.remote.profiles[1].behaviors.power.click[0].key, 'B')
  assert.equal(imported.plan.mouse[1].behaviors['mouse.top.up'].click[0].key, 'PageDown')
  assert.deepEqual(imported.plan.mouse[1].behaviors['mouse.global.buttonMiddle'].click, [])
  assert.equal(imported.backup.profiles.some(profile => profile.deviceId === 'cmiotA15'), false)
  assert.equal(imported.backup.savedSequences[0].name, '粘贴并确认')
  assert.deepEqual(file, before)
})

test('legacy snapshots, raw shared profiles, transitional profiles and settings are recognized without changing storage', () => {
  const old = { version: 1, activeProfileId: 'one', profiles: [{ id: 'one', name: '旧配置', behaviors: { power: 'Ctrl+A', 'mouse.top.up': 'B' } }] }
  const values = new Map([[legacyProfilesKey, JSON.stringify(old)], ['axonkey.settings.v1', '{"enabled":false}']])
  const storage = { getItem: key => values.get(key) ?? null }
  const before = new Map(values)
  const snapshot = createLegacyConfigExport(storage)
  for (const text of [snapshot.content, JSON.stringify(old), JSON.stringify({ behaviors: { power: 'A' } }), JSON.stringify({
    version: 2, activeProfileIds: { mouse: 'mouse' }, profiles: [{ id: 'mouse', name: '鼠标', deviceId: 'mouse', behaviors: { 'mouse.top.up': 'B' } }],
  })]) {
    const imported = parseBackupImport(text)
    assert.equal(imported.kind, 'legacy')
    assert.ok(imported.plan.mouse.length || imported.plan.remote)
  }
  assert.deepEqual(values, before)
})

test('old v2 backups can omit the complete middle-button group; malformed mappings and unsupported versions are rejected', () => {
  const file = createDataBackup(sampleData(), '1.0.15')
  file.profiles = file.profiles.filter(profile => profile.deviceId !== 'cmiotA15')
  delete file.activeProfileIds.cmiotA15
  for (const profile of file.profiles.filter(profile => profile.deviceId === 'mouse')) {
    for (const key of Object.keys(profile.keys).filter(key => key.endsWith('.buttonMiddle'))) delete profile.keys[key]
  }
  assert.equal(parseBackupImport(JSON.stringify(file)).kind, 'legacy')
  for (const mutate of [
    data => { data.version = 3 },
    data => { data.profiles[0].keys.power.click[0].type = 'unknown' },
    data => { data.profiles.find(profile => profile.deviceId === 'mouse').keys['global.buttonMiddle'] = { click: [], doubleClick: [], longPress: [] } },
    data => { data.activeProfileIds.rc003 = 'missing' },
  ]) {
    const invalid = structuredClone(file)
    mutate(invalid)
    assert.throws(() => parseBackupImport(JSON.stringify(invalid)))
  }
  const invalid = legacyBackup()
  invalid.profiles[0].devices.rc003.keys.future = { click: [], doubleClick: [], longPress: [] }
  assert.throws(() => parseBackupImport(JSON.stringify(invalid)))
  assert.throws(() => parseBackupImport('{'))
})

function importStorage() {
  const data = sampleData()
  const values = new Map([
    ['axonkey.mapping-profiles.v2', JSON.stringify({ version: 2, migrationReviewed: true, profiles: data.profiles, activeProfileIds: data.activeProfileIds })],
    [legacyProfilesKey, 'local legacy source must be preserved'],
    ['axonkey.settings.v1', '{"enabled":true,"behaviors":{"power":"X"}}'],
    ['axonkey.ui-state.v1', '{"activePage":"settings","settingsSection":"backup"}'],
  ])
  return { values, data, storage: { getItem: key => values.get(key) ?? null, setItem: (key, value) => values.set(key, value), removeItem: key => values.delete(key) } }
}

test('confirming an old full backup imports mouse, chosen remote, saved behaviors and settings without deleting local legacy data', async () => {
  const { values, data, storage } = importStorage()
  const imported = parseBackupImport(JSON.stringify(legacyBackup()))
  const target = { id: 'living', kind: 'rc003', name: '客厅遥控器', binding: 'physical', enabled: false, audioGainDb: 3, profiles: [], activeProfileId: '' }
  const writes = []
  const bindingId = await migrateBackupImport(storage, imported, async instance => writes.push(instance), () => {}, target)
  assert.equal(bindingId, null)
  assert.equal(writes.length, 1)
  assert.equal(writes[0].id, target.id)
  assert.equal(writes[0].name, target.name)
  assert.equal(writes[0].binding, target.binding)
  assert.equal(writes[0].enabled, false)
  const restored = JSON.parse(values.get('axonkey.mapping-profiles.v2'))
  assert.deepEqual(restored.profiles.filter(profile => profile.deviceId !== 'mouse'), data.profiles.filter(profile => profile.deviceId !== 'mouse'))
  assert.equal(restored.profiles.filter(profile => profile.deviceId === 'mouse').length, 2)
  assert.equal(values.get(legacyProfilesKey), 'local legacy source must be preserved')
  assert.equal(JSON.parse(values.get('axonkey.settings.v1')).mouseScrollSensitivity, imported.backup.settings.mouseScrollSensitivity)
  assert.equal(JSON.parse(values.get('axonkey.saved-sequences.v1'))[0].name, '粘贴并确认')
  assert.deepEqual(JSON.parse(values.get('axonkey.audio-settings.v2')), imported.backup.audio)
})

test('remote save failure restores all local import writes; retry can create an unbound device without legacy checkpoints', async () => {
  const { values, storage } = importStorage()
  const before = new Map(values)
  const imported = parseBackupImport(JSON.stringify(legacyBackup()))
  await assert.rejects(migrateBackupImport(storage, imported, async () => { throw new Error('保存设备失败') }, () => {}, null), /保存设备失败/)
  assert.deepEqual(values, before)
  let saved
  const id = await migrateBackupImport(storage, imported, async instance => { saved = instance }, () => {}, null)
  assert.equal(id, saved.id)
  assert.equal(saved.binding, null)
  assert.equal(values.get(legacyProfilesKey), before.get(legacyProfilesKey))
})

test('a failed local import write does not modify the remote or lose current data', async () => {
  const { values, storage } = importStorage()
  const before = new Map(values)
  let fail = true, writes = 0
  const failing = { ...storage, setItem(key, value) {
    if (key === 'axonkey.settings.v1' && fail) { fail = false; throw new Error('quota') }
    storage.setItem(key, value)
  } }
  await assert.rejects(migrateBackupImport(failing, parseBackupImport(JSON.stringify(legacyBackup())), async () => writes++, () => {}, null), /quota/)
  assert.deepEqual(values, before)
  assert.equal(writes, 0)
})

test('full backup import honors per-device skip choices while still restoring saved behaviors and settings', async () => {
  for (const selection of [{ mouse: false, remote: true }, { mouse: true, remote: false }]) {
    const { values, data, storage } = importStorage()
    let writes = 0
    await migrateBackupImport(storage, parseBackupImport(JSON.stringify(legacyBackup())), async () => writes++, () => {}, null, selection)
    assert.equal(writes, selection.remote ? 1 : 0)
    const current = JSON.parse(values.get('axonkey.mapping-profiles.v2'))
    if (!selection.mouse) {
      assert.deepEqual(current.profiles.filter(profile => profile.deviceId === 'mouse'), data.profiles.filter(profile => profile.deviceId === 'mouse'))
      assert.equal(current.activeProfileIds.mouse, data.activeProfileIds.mouse)
    }
    assert.equal(JSON.parse(values.get('axonkey.saved-sequences.v1'))[0].name, '粘贴并确认')
    assert.equal(values.get(legacyProfilesKey), 'local legacy source must be preserved')
  }
})
