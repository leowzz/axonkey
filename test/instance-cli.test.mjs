import assert from 'node:assert/strict'
import test from 'node:test'
import { registerHooks } from 'node:module'

const assets = registerHooks({
  load(url, context, next) {
    return url.endsWith('.svg')
      ? { format: 'module', source: 'export default "asset.svg"', shortCircuit: true }
      : next(url, context)
  },
})
const { processInstanceCliRequest, resolveCliInstance, normalizeCliDeviceSelector } =
  await import('../src/devices/integration/instanceCli.ts')
assets.deregister()

test('TCL and projector remote CLI selectors resolve each model and use its descriptor keys', async () => {
  for (const [model, alias, kind, key] of [
    ['rc802a', 'TCL-RC802A', 'tclRc802a', 'tcl-rc802a.voice'],
    ['rc902n', 'TCL-RC902N', 'tclRc902n', 'tcl-rc902n.menu'],
    ['rc902v', 'TCL-RC902V', 'tclRc902v', 'tcl-rc902v.mute'],
    ['rcf3b65', 'Hisense-RCF3B65', 'hisenseRcf3b65', 'hisense-rcf3b65.power'],
    ['db1-r', 'PHICOMM-DB1-R', 'phicommDb1R', 'phicomm-db1-r.ottPower'],
  ]) {
    const app = workspace([initial(model, kind)])
    assert.equal(normalizeCliDeviceSelector(model), kind.toLowerCase())
    assert.equal(normalizeCliDeviceSelector(alias), kind.toLowerCase())
    assert.equal(resolveCliInstance({ device: model }, app.snapshot).kind, kind)
    const result = await app.command('mapping.list', { device: model })
    assert.ok(result.mappings.some(mapping => mapping.button === key))
  }
})

function initial(id = 'remote-one', kind = 'rc003') {
  return {
    id,
    kind,
    name: id,
    binding: 'physical-' + id,
    enabled: true,
    profiles: [{ id: 'default', name: '默认配置', behaviors: {} }],
    activeProfileId: 'default',
  }
}

function workspace(instances = [initial()]) {
  let snapshot = {
    store: { version: 1, revision: 7, instances: structuredClone(instances) },
    discovered: [{ id: instances[0]?.binding, connected: true }],
    runtime: { [instances[0]?.id]: { state: 'exclusive', error: null, reports: 0 } },
    error: null,
    scanError: null,
    scanning: false,
  }
  return {
    get snapshot() {
      return snapshot
    },
    command(method, params = {}, update) {
      return processInstanceCliRequest(method, params, {
        snapshot,
        platform: 'macos',
        update:
          update ??
          (async (id, change) => {
            snapshot = {
              ...snapshot,
              store: {
                ...snapshot.store,
                revision: snapshot.store.revision + 1,
                instances: snapshot.store.instances.map(instance => (instance.id === id ? change(instance) : instance)),
              },
            }
            return snapshot
          }),
      })
    },
  }
}

const isError = code => error => error.code === code

test('application CLI bindings validate required IDs, preserve metadata and support pause/remove', async () => {
  const work = workspace()
  for (const method of ['profile.application-set', 'profile.application-remove']) {
    await assert.rejects(work.command(method, { profile: 'default', dryRun: true }), isError('invalid_arguments'))
  }
  const application = 'windows:c:\\apps\\example.exe'
  await work.command('profile.application-set', {
    application, applicationName: 'Example', applicationPath: 'C:\\Apps\\Example.exe', profile: 'default',
  })
  await work.command('profile.application-toggle', { enabled: false })
  const created = await work.command('profile.create', { name: '第二套' })
  await work.command('profile.application-set', { application, profile: created.profile.id })
  const result = await work.command('profile.application-list')
  assert.equal(result.applicationProfileSwitching, false)
  assert.equal(result.applications[0].name, 'Example')
  assert.equal(result.applications[0].path, 'C:\\Apps\\Example.exe')
  assert.equal(result.applications[0].profile.id, created.profile.id)
  await assert.rejects(work.command('profile.application-remove', { application: 'missing' }), isError('invalid_target'))
  await work.command('profile.application-remove', { application })
  assert.deepEqual((await work.command('profile.application-list')).applications, [])
})

test('lists actual instances, physical connection, runtime and active profile', async () => {
  const work = workspace([initial(), initial('remote-two')])
  const result = await work.command('device.list')
  assert.equal(result.revision, 7)
  assert.equal(result.devices.length, 2)
  assert.equal(result.devices[0].id, 'remote-one')
  assert.equal(result.devices[0].connected, true)
  assert.equal(result.devices[0].state, 'exclusive')
  assert.deepEqual(result.devices[0].activeProfile, { id: 'default', name: '默认配置', active: true })
  assert.equal(result.devices[1].connected, false)
  assert.equal(result.devices[1].state, 'disconnected')
})

test('device status exposes the effective application profile separately from the global selection', async () => {
  const work = workspace()
  const created = await work.command('profile.create', { name: '应用配置' })
  await work.command('profile.activate', { profile: 'default' })
  work.snapshot.runtime['remote-one'].effectiveProfileId = created.profile.id
  const result = await work.command('device.list')
  assert.equal(result.devices[0].activeProfile.id, 'default')
  assert.equal(result.devices[0].effectiveProfile.id, created.profile.id)
})

test('requires an unambiguous instance and validates instance/kind selectors', () => {
  const work = workspace([initial(), initial('remote-two'), initial('other-kind', 'xmBt29')])
  assert.throws(() => resolveCliInstance({}, work.snapshot), isError('invalid_target'))
  assert.throws(() => resolveCliInstance({ device: 'rc003' }, work.snapshot), isError('invalid_target'))
  assert.equal(resolveCliInstance({ instance: 'remote-two', device: 'xiaomi' }, work.snapshot).id, 'remote-two')
  assert.equal(resolveCliInstance({ device: 'remote-two' }, work.snapshot).id, 'remote-two')
  assert.equal(resolveCliInstance({ device: 'XM-BT-29' }, work.snapshot).id, 'other-kind')
  assert.throws(
    () => resolveCliInstance({ instance: 'remote-two', device: 'xmBt29' }, work.snapshot),
    isError('invalid_target'),
  )
  assert.throws(() => resolveCliInstance({ instance: 1 }, work.snapshot), isError('invalid_arguments'))
})

test('creates, returns persisted identifiers and activates profiles by ID or name', async () => {
  const work = workspace()
  const preview = await work.command('profile.create', { name: '鼠标操作', dryRun: true })
  assert.equal(preview.dryRun, true)
  assert.equal(work.snapshot.store.instances[0].profiles.length, 1)
  assert.equal(work.snapshot.store.revision, 7)
  const created = await work.command('profile.create', { name: '鼠标操作' })
  assert.equal(created.saved, true)
  assert.equal(created.revision, 8)
  assert.equal(created.previousActiveProfileId, 'default')
  assert.equal(created.profile.name, '鼠标操作')
  assert.equal(created.profile.active, true)
  assert.equal(work.snapshot.store.instances[0].activeProfileId, created.profile.id)
  assert.deepEqual(work.snapshot.store.instances[0].profiles[1].behaviors, {})
  const list = await work.command('profile.list')
  assert.deepEqual(
    list.profiles.map(profile => profile.active),
    [false, true],
  )
  const activatePreview = await work.command('profile.activate', { profile: 'default', dryRun: true })
  assert.equal(activatePreview.after, 'default')
  assert.equal(activatePreview.profile.active, true)
  assert.equal(work.snapshot.store.instances[0].activeProfileId, created.profile.id)
  const activated = await work.command('profile.activate', { profile: '默认配置' })
  assert.equal(activated.profile.id, 'default')
  assert.equal(activated.profile.active, true)
  assert.equal(activated.revision, 9)
  await work.command('profile.activate', { profile: created.profile.id })
  assert.equal(work.snapshot.store.instances[0].activeProfileId, created.profile.id)
  await assert.rejects(work.command('profile.create', { name: '鼠标操作' }), isError('invalid_target'))
  await assert.rejects(work.command('profile.create'), isError('invalid_arguments'))
  await assert.rejects(work.command('profile.activate'), isError('invalid_arguments'))
})

test('sets and reads mouse sequences in the selected actual instance/profile only', async () => {
  const work = workspace([initial(), initial('remote-two')])
  const target = { instance: 'remote-two', button: 'up' }
  const created = await work.command('profile.create', { instance: 'remote-two', name: '鼠标操作' })
  const actions = [
    { type: 'cursorMove', direction: 'up', distance: 50 },
    { type: 'cursorMove', direction: 'down', distance: 50 },
    { type: 'cursorMove', direction: 'left', distance: 50 },
    { type: 'cursorMove', direction: 'right', distance: 50 },
    { type: 'mouse', button: 'left' },
    { type: 'delay', ms: 30 },
    { type: 'mouse', button: 'left' },
    { type: 'mouse', button: 'right' },
    { type: 'mouse', button: 'back' },
    { type: 'mouse', button: 'forward' },
    { type: 'wheel', direction: 'up' },
    { type: 'wheel', direction: 'down' },
    { type: 'wheel', direction: 'left' },
    { type: 'wheel', direction: 'right' },
  ]
  const unchanged = structuredClone(work.snapshot)
  const preview = await work.command('mapping.set', { ...target, profile: created.profile.id, actions, dryRun: true })
  assert.equal(preview.after.length, actions.length)
  assert.deepEqual(work.snapshot, unchanged)
  const result = await work.command('mapping.set', { ...target, profile: created.profile.id, sequence: actions })
  assert.equal(result.saved, true)
  assert.equal(result.instance.id, 'remote-two')
  assert.equal(result.profile.id, created.profile.id)
  assert.equal(result.revision, 9)
  const read = await work.command('mapping.get', { ...target, profile: '鼠标操作' })
  assert.deepEqual(
    read.actions,
    actions.map(action => ({ ...action, enabled: true })),
  )
  assert.deepEqual(work.snapshot.store.instances[0].profiles[0].behaviors, {})
  assert.deepEqual(work.snapshot.store.instances[1].profiles[0].behaviors, {})
  const all = await work.command('mapping.list', { instance: 'remote-two' })
  assert.deepEqual(
    all.mappings.find(mapping => mapping.button === 'up' && mapping.trigger === 'click').actions,
    read.actions,
  )
  assert.equal(all.mappings.length, 13 * 3)
})

test('TV cycle is shared by every profile and inherited by a new blank profile', async () => {
  const work = workspace([initial(), initial('remote-two')])
  const instance = 'remote-one'
  const second = await work.command('profile.create', { instance, name: '鼠标操作' })
  await work.command('mapping.set', {
    instance,
    button: 'up',
    action: { type: 'cursorMove', direction: 'up', distance: 50 },
  })
  const cycle = [{ type: 'switchProfile', direction: 'next', wrap: true }]
  const preview = await work.command('mapping.set', { instance, button: 'tv', sequence: cycle, dryRun: true })
  assert.equal(preview.affectedProfiles.length, 2)
  assert.ok(work.snapshot.store.instances[0].profiles.every(profile => !profile.behaviors.tv))
  const result = await work.command('mapping.set', { instance, button: 'tv', sequence: cycle })
  assert.equal(result.affectedProfiles.length, 2)
  const third = await work.command('profile.create', { instance, name: '第三套' })
  for (const profile of work.snapshot.store.instances[0].profiles) {
    const read = await work.command('mapping.get', { instance, profile: profile.id, button: 'tv' })
    assert.deepEqual(read.actions, [{ ...cycle[0], enabled: true }])
  }
  const newlyCreated = work.snapshot.store.instances[0].profiles.find(profile => profile.id === third.profile.id)
  assert.deepEqual(newlyCreated.behaviors.up.click, [])
  assert.equal(
    work.snapshot.store.instances[0].profiles.find(profile => profile.id === second.profile.id).behaviors.up.click[0]
      .distance,
    50,
  )
  assert.deepEqual(work.snapshot.store.instances[1].profiles[0].behaviors, {})
  await assert.rejects(work.command('mapping.clear', { instance, button: 'tv' }), isError('invalid_arguments'))
  const clear = await work.command('mapping.clear', { instance, button: 'tv', yes: true })
  assert.equal(clear.affectedProfiles.length, 3)
  assert.ok(work.snapshot.store.instances[0].profiles.every(profile => profile.behaviors.tv.click.length === 0))
})

test('replacing a shared switch removes it from other profiles and keeps unrelated triggers', async () => {
  const work = workspace()
  await work.command('profile.create', { name: '鼠标操作' })
  await work.command('mapping.set', {
    button: 'tv',
    sequence: [{ type: 'switchProfile', direction: 'next', wrap: true }],
  })
  await work.command('mapping.set', {
    button: 'tv',
    trigger: 'long-press',
    actions: [{ type: 'wheel', direction: 'down' }],
  })
  await work.command('mapping.set', { button: 'tv', actions: [{ type: 'mouse', button: 'left' }] })
  const profiles = work.snapshot.store.instances[0].profiles
  assert.deepEqual(profiles[0].behaviors.tv.click, [])
  assert.equal(profiles[1].behaviors.tv.click[0].type, 'mouse')
  assert.equal(profiles[1].behaviors.tv.longPress[0].type, 'wheel')
})

test('shortcut aliases and trigger aliases cross the real behavior conversion', async () => {
  const work = workspace()
  const set = await work.command('shortcut.set', { button: 'voice', keys: 'cmd+shift+p', trigger: 'double-click' })
  assert.deepEqual(set.after, [{ type: 'shortcut', keys: ['Mod', 'Shift', 'P'], enabled: true }])
  assert.deepEqual(work.snapshot.store.instances[0].profiles[0].behaviors.voice.doubleClick[0].keys, [
    'Win',
    'Shift',
    'P',
  ])
  const read = await work.command('shortcut.get', { input: 'voice', trigger: 'doubleClick' })
  assert.deepEqual(read.actions, set.after)
  await work.command('shortcut.clear', { button: 'voice', trigger: 'doubleClick', yes: true })
  assert.deepEqual((await work.command('mapping.get', { button: 'voice', trigger: 'doubleClick' })).actions, [])
})

test('rejects unsupported targets, malformed behaviors and mixed shared-switch sequences before saving', async () => {
  const work = workspace()
  const before = structuredClone(work.snapshot)
  for (const [method, params, code] of [
    ['mapping.set', { button: 'missing', sequence: [] }, 'invalid_target'],
    ['mapping.set', { button: 'tv', trigger: 'unknown', sequence: [] }, 'invalid_target'],
    ['mapping.set', { button: 'tv', sequence: {} }, 'invalid_behavior'],
    ['mapping.set', { button: 'tv', sequence: [{ type: 'mouse', button: 'middle' }] }, 'invalid_behavior'],
    [
      'mapping.set',
      {
        button: 'tv',
        sequence: [
          { type: 'switchProfile', direction: 'next' },
          { type: 'delay', ms: 30 },
        ],
      },
      'invalid_behavior',
    ],
    ['mapping.set', { button: 'tv', sequence: [], dryRun: 'true' }, 'invalid_arguments'],
    ['profile.activate', { profile: 'missing' }, 'invalid_target'],
    ['profile.delete', {}, 'invalid_arguments'],
  ])
    await assert.rejects(work.command(method, params), isError(code))
  assert.deepEqual(work.snapshot, before)
})

test('waits for persistence and propagates save failure without claiming success', async () => {
  const work = workspace()
  let finish
  let completed = false
  const pending = work
    .command('mapping.set', { button: 'up', sequence: [] }, async (id, change) => {
      await new Promise(resolve => {
        finish = resolve
      })
      throw new Error('disk save failed')
    })
    .finally(() => {
      completed = true
    })
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(completed, false)
  finish()
  await assert.rejects(pending, /disk save failed/)
  assert.equal(work.snapshot.store.revision, 7)
  assert.deepEqual(work.snapshot.store.instances[0].profiles[0].behaviors, {})
})

test('normalizes device selectors for shared instance and keymap lookup', () => {
  assert.equal(normalizeCliDeviceSelector(undefined), '')
  assert.equal(normalizeCliDeviceSelector(' Xiaomi '), 'rc003')
  assert.equal(normalizeCliDeviceSelector('CMIOT'), 'cmiota15')
  assert.equal(normalizeCliDeviceSelector('XM-BT-29'), 'xmbt29')
  assert.equal(normalizeCliDeviceSelector('RC-313'), 'rc313')
  assert.equal(normalizeCliDeviceSelector('RCU-R5'), 'obercur5')
  assert.equal(normalizeCliDeviceSelector('Xbox'), 'xboxbluetooth')
  assert.throws(() => normalizeCliDeviceSelector({}), isError('invalid_arguments'))
})

test('propagates store read errors instead of returning empty or stale configuration', async () => {
  const work = workspace()
  work.snapshot.error = '配置读取失败'
  for (const [method, params] of [
    ['device.list', {}],
    ['profile.list', {}],
    ['profile.create', { name: '鼠标操作' }],
    ['mapping.get', { button: 'tv' }],
    ['mapping.set', { button: 'tv', sequence: [] }],
  ])
    await assert.rejects(
      work.command(method, params),
      error => error.code === 'app_error' && error.message === '配置读取失败',
    )
  assert.equal(work.snapshot.store.revision, 7)
  assert.equal(work.snapshot.store.instances[0].profiles.length, 1)
})
