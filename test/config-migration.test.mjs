import assert from 'node:assert/strict'
import test from 'node:test'
import { inspectConfigMigration, migrateConfig, discardLegacyConfig, createLegacyConfigExport, legacyProfilesKey } from '../src/configMigration.ts'
import { createEmptyBehaviorMap, createBehavior } from '../src/behaviorModel.ts'
import { createDefaultDeviceProfiles } from '../src/deviceProfiles.ts'

const currentKey = 'axonkey.mapping-profiles.v2'
const settingsKey = 'axonkey.settings.v1'
const empty = () => ({ click: [], doubleClick: [], longPress: [] })
function storage(entries = {}) {
  const values = new Map(Object.entries(entries).map(([key, value]) => [key, JSON.stringify(value)]))
  return { values, getItem: key => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, value), removeItem: key => values.delete(key) }
}
const shared = (behaviors = { power: 'Ctrl+C', 'mouse.top.up': 'PageUp' }) => ({
  version: 1, activeProfileId: 'media', profiles: [
    { id: 'work', name: '工作', behaviors },
    { id: 'media', name: '媒体', behaviors: structuredClone(behaviors) },
  ],
})

test('empty and current-only storage need no migration; inspection never writes', () => {
  for (const entries of [{}, { [currentKey]: { version: 2, migrationReviewed: true, ...createDefaultDeviceProfiles(createEmptyBehaviorMap()) },
    [settingsKey]: { behaviors: createEmptyBehaviorMap() } }]) {
    const data = storage(entries)
    const before = new Map(data.values)
    assert.equal(inspectConfigMigration(data).found, false)
    assert.deepEqual(data.values, before)
  }
})

test('legacy export preserves original shared, transitional and settings payloads, including malformed JSON', () => {
  for (const source of [legacyProfilesKey, currentKey, settingsKey]) {
    const data = storage({ [source]: shared(), unrelated: { excluded: true } })
    const before = new Map(data.values)
    const date = new Date(2026, 9, 29, 12, 34, 56)
    const exported = createLegacyConfigExport(data, date)
    const document = JSON.parse(exported.content)
    assert.equal(exported.filename, 'axonkey-legacy-config-20261029-123456.json')
    assert.equal(document.format, 'axonkey-legacy-config')
    assert.equal(document.exportedAt, date.toISOString())
    assert.deepEqual(document.storage, { [source]: data.getItem(source) })
    assert.deepEqual(data.values, before)
  }
  const damaged = storage()
  damaged.values.set(legacyProfilesKey, ' { broken data 中文\n')
  damaged.values.set(currentKey, ' { broken v2 ')
  damaged.values.set(settingsKey, ' { broken settings ')
  assert.deepEqual(JSON.parse(createLegacyConfigExport(damaged).content).storage, Object.fromEntries(damaged.values))
})

test('shared mappings split by actual device keys and preserve profile order and active selection', () => {
  const data = storage({ [legacyProfilesKey]: shared() })
  const plan = inspectConfigMigration(data)
  assert.equal(plan.error, '')
  assert.equal(plan.mouse.length, 2)
  assert.equal(plan.mouseActiveId, plan.mouse[1].id)
  assert.equal(plan.mouse[0].behaviors['mouse.top.up'].click[0].key, 'PageUp')
  assert.equal(plan.mouse[0].behaviors.power.click.length, 0)
  assert.equal(plan.remote.profiles[0].name, '工作')
  assert.equal(plan.remote.activeProfileId, plan.remote.profiles[1].id)
  assert.equal(plan.remote.binding, null)
  assert.deepEqual(plan.remote.profiles[0].behaviors.power.click[0].keys, ['Ctrl', 'C'])
  assert.ok(!('mouse.top.up' in plan.remote.profiles[0].behaviors))
})

test('mouse-only, remote-only and empty old stores are detected independently', () => {
  for (const [behaviors, mouse, remote] of [[{ power: 'original' }, 2, true], [{ 'mouse.top.up': 'A' }, 2, false], [{}, 0, false]]) {
    const plan = inspectConfigMigration(storage({ [legacyProfilesKey]: shared(behaviors) }))
    assert.equal(plan.found, true)
    assert.equal(plan.mouse.length, 'power' in behaviors ? 0 : mouse)
    assert.equal(!!plan.remote, remote)
  }
})

test('single-map settings support old containers without injecting default device mappings', () => {
  for (const key of ['mappings', 'actions', 'behaviors']) {
    const plan = inspectConfigMigration(storage({ [settingsKey]: { [key]: { power: 'A' }, mouseEdgeWidth: 12 } }))
    assert.equal(plan.mouse.length, 0)
    assert.equal(plan.remote.profiles.length, 1)
    assert.equal(plan.remote.profiles[0].behaviors.power.click[0].key, 'A')
    assert.equal(plan.remote.profiles[0].behaviors.voice.click.length, 0)
  }
})

test('behavior sequences retain disabled steps, ordering and every trigger', () => {
  const triggers = { click: [createBehavior({ type: 'delay', ms: 23, enabled: false })],
    doubleClick: [createBehavior({ type: 'key', key: 'B' })],
    longPress: [createBehavior({ type: 'switchProfile', direction: 'next', wrap: true })] }
  const plan = inspectConfigMigration(storage({ [legacyProfilesKey]: shared({ power: triggers }) }))
  assert.deepEqual(plan.remote.profiles[0].behaviors.power, triggers)
})

test('malformed stores and unsupported actions block migration without deleting the source', async () => {
  for (const value of ['{broken', JSON.stringify(shared({ power: { ...empty(), click: [{ type: 'unknown' }] } }))]) {
    const data = storage()
    data.values.set(legacyProfilesKey, value)
    const plan = inspectConfigMigration(data)
    assert.equal(plan.found, true)
    assert.ok(plan.error)
    await assert.rejects(migrateConfig(data, plan, async () => assert.fail('must not save'), () => {}))
    assert.equal(data.getItem(legacyProfilesKey), value)
  }
})

test('migration overwrites only mouse profiles then saves an unbound remote and cleans old payloads', async () => {
  const current = createDefaultDeviceProfiles(createEmptyBehaviorMap())
  current.profiles[0].name = '保留当前配置'
  const data = storage({ [legacyProfilesKey]: shared(), [currentKey]: { version: 2, ...current },
    [settingsKey]: { mappings: { power: 'B' }, mouseEdgeWidth: 22 }, unrelated: { keep: true } })
  const plan = inspectConfigMigration(data)
  const messages = []
  const id = await migrateConfig(data, plan, async instance => {
    assert.equal(instance.id, plan.remote.id)
    assert.ok(data.getItem(legacyProfilesKey), 'delete only after remote save succeeds')
    const saved = JSON.parse(data.getItem(currentKey))
    assert.deepEqual(saved.profiles.filter(p => p.deviceId === 'mouse'), plan.mouse)
    assert.equal(saved.profiles[0].name, '保留当前配置')
  }, message => messages.push(message))
  assert.equal(id, plan.remote.id)
  assert.equal(data.getItem(legacyProfilesKey), null)
  assert.deepEqual(JSON.parse(data.getItem(settingsKey)), { mouseEdgeWidth: 22 })
  assert.equal(data.getItem('unrelated'), '{"keep":true}')
  assert.equal(messages.length, 3)
  assert.equal(inspectConfigMigration(data).found, false)
})

test('a failed remote save can resume after reopening without losing settings-only source or creating a different remote', async () => {
  const data = storage({ [settingsKey]: { mappings: { power: 'A', 'mouse.top.up': 'B' } } })
  const plan = inspectConfigMigration(data)
  await assert.rejects(migrateConfig(data, plan, async () => { throw new Error('磁盘写入失败') }, () => {}))
  const resumed = inspectConfigMigration(data)
  assert.equal(resumed.found, true)
  assert.equal(resumed.remote.id, plan.remote.id)
  await migrateConfig(data, resumed, async () => {}, () => {})
  assert.equal(inspectConfigMigration(data).found, false)
})

test('failed mouse persistence neither creates a remote nor deletes old data', async () => {
  const data = storage({ [legacyProfilesKey]: shared() })
  const setItem = data.setItem
  data.setItem = (key, value) => { if (key === currentKey) throw new Error('Quota'); setItem(key, value) }
  await assert.rejects(migrateConfig(data, inspectConfigMigration(data), async () => assert.fail('remote saved'), () => {}), /Quota/)
  assert.ok(data.getItem(legacyProfilesKey))
})

test('discard removes legacy mappings while preserving current mouse profiles and preferences', () => {
  const current = { version: 2, ...createDefaultDeviceProfiles(createEmptyBehaviorMap()) }
  const data = storage({ [legacyProfilesKey]: shared(), [currentKey]: current,
    [settingsKey]: { behaviors: {}, mappings: {}, actions: {}, mouseEnabled: false } })
  discardLegacyConfig(data, inspectConfigMigration(data))
  assert.equal(data.getItem(legacyProfilesKey), null)
  assert.deepEqual(JSON.parse(data.getItem(currentKey)), { ...current, migrationReviewed: true })
  assert.deepEqual(JSON.parse(data.getItem(settingsKey)), { mouseEnabled: false })
})


test('transitional v2 profiles migrate per-device active choices and keep unrelated A15 data', async () => {
  const old = createDefaultDeviceProfiles(createEmptyBehaviorMap())
  old.profiles.find(p => p.deviceId === 'mouse').behaviors['mouse.top.up'].click = [createBehavior({ type: 'key', key: 'M' })]
  old.profiles.find(p => p.deviceId === 'rc003').behaviors.power.click = [createBehavior({ type: 'key', key: 'R' })]
  const a15 = old.profiles.find(p => p.deviceId === 'cmiotA15')
  a15.name = '保留 A15'
  const data = storage({ [currentKey]: { version: 2, ...old } })
  const plan = inspectConfigMigration(data)
  assert.equal(plan.fromDeviceProfiles, true)
  assert.equal(plan.mouse.length, 1)
  assert.equal(plan.remote.profiles.length, 1)
  assert.equal(plan.remote.profiles[0].behaviors.power.click[0].key, 'R')
  await migrateConfig(data, plan, async () => {}, () => {})
  const saved = JSON.parse(data.getItem(currentKey))
  assert.equal(saved.migrationReviewed, true)
  assert.deepEqual(saved.profiles.find(p => p.deviceId === 'cmiotA15'), a15)
  assert.equal(saved.profiles.some(p => p.deviceId === 'rc003'), false)
  assert.equal(saved.profiles.find(p => p.deviceId === 'mouse').behaviors['mouse.top.up'].click[0].key, 'M')
  assert.equal(inspectConfigMigration(data).found, false)
})

test('skipping transitional v2 deletes its mouse and RC003 data but preserves other device profiles', () => {
  const old = createDefaultDeviceProfiles(createEmptyBehaviorMap())
  const data = storage({ [currentKey]: { version: 2, ...old } })
  discardLegacyConfig(data, inspectConfigMigration(data))
  const saved = JSON.parse(data.getItem(currentKey))
  assert.deepEqual(saved.profiles.map(p => p.deviceId), ['cmiotA15'])
  assert.equal(inspectConfigMigration(data).found, false)
})

test('overwriting a remote replaces all profiles and active selection while preserving device settings', async () => {
  const data = storage({ [legacyProfilesKey]: shared() })
  const plan = inspectConfigMigration(data)
  const target = { ...plan.remote, id: 'existing', name: '客厅遥控器', binding: 'physical-remote', enabled: false,
    bindingQuality: 'serial', bindingPairingId: 'pairing', voiceOutputDevice: 'speakers', audioGainDb: 4,
    hideDriverMissingReminder: true, profiles: [{ id: 'old-profile', name: '被覆盖', behaviors: {} }], activeProfileId: 'old-profile' }
  const original = structuredClone(target)
  let saved
  const bindingId = await migrateConfig(data, plan, async instance => { saved = instance }, () => {}, target)
  assert.deepEqual(saved, { ...original, profiles: plan.remote.profiles, activeProfileId: plan.remote.activeProfileId })
  assert.deepEqual(target, original)
  assert.equal(bindingId, null, 'an already bound target does not need binding again')
  assert.equal(data.getItem(legacyProfilesKey), null)
})

test('failed overwrite remembers its target across reopening and requests binding if the target is unbound', async () => {
  const data = storage({ [legacyProfilesKey]: shared() })
  const plan = inspectConfigMigration(data)
  const target = { ...plan.remote, id: 'existing-unbound', name: '书房遥控器', profiles: [], activeProfileId: '' }
  await assert.rejects(migrateConfig(data, plan, async () => { throw new Error('保存失败') }, () => {}, target))
  const resumed = inspectConfigMigration(data)
  assert.equal(resumed.remoteTargetId, target.id)
  assert.equal(resumed.remote.id, plan.remote.id)
  assert.equal(resumed.remote.profiles.length, 2)
  const bindingId = await migrateConfig(data, resumed, async instance => assert.equal(instance.id, target.id), () => {}, target)
  assert.equal(bindingId, target.id)
  assert.equal(data.getItem(legacyProfilesKey), null)
})
