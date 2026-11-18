import assert from 'node:assert/strict'
import test from 'node:test'
import { registerHooks } from 'node:module'
import {
  createBehavior,
  createEmptyBehaviorMap,
  createMappingExport,
  normalizeBehavior,
  parseMappingImport,
  parseSequenceImport,
  parseStoredBehaviors,
  quickOverlayMinAppVersion,
  serializeSequence,
} from '../src/behaviorModel.ts'
import { behaviorSummary } from '../src/behaviorSummary.ts'
import { adjacentProfileId, applySharedProfileSwitch, profileSwitchTargets } from '../src/profileNavigation.ts'
import { parseStoredDeviceProfiles } from '../src/deviceProfiles.ts'
import { deleteMouseProfile } from '../src/mouseProfiles.ts'
import { createDataBackup, parseDataBackup } from '../src/dataBackup.ts'
import { behaviorToCliBehavior, normalizeCliBehavior } from '../src/cliContract.ts'
import {
  addQuickInstanceProfile,
  applyInstanceProfileSwitch,
  deleteInstanceProfile,
} from '../src/devices/integration/instanceProfiles.ts'
import { sampleData } from './fixtures/data-backup.mjs'

const assets = registerHooks({
  load(url, context, next) {
    return url.endsWith('.svg')
      ? { format: 'module', source: 'export default "asset.svg"', shortCircuit: true }
      : next(url, context)
  },
})
const { createCloudSnapshot, prepareCloudRestore } = await import('../src/cloud/cloudData.ts')
const { processInstanceCliRequest } = await import('../src/devices/integration/instanceCli.ts')
const { processMouseCliRequest } = await import('../src/mouseCli.ts')
assets.deregister()

test('quickOverlay behavior validates profileId and round-trips through storage, sequence and mapping exports', () => {
  const valid = normalizeBehavior({ type: 'quickOverlay', profileId: '  prof-prompts  ', id: 'q1' })
  assert.deepEqual(valid, { id: 'q1', enabled: true, type: 'quickOverlay', profileId: 'prof-prompts' })
  assert.equal(behaviorSummary(valid, 'macos', { 'prof-prompts': 'AI 提示词' }), '快捷交互窗 · AI 提示词')
  assert.equal(behaviorSummary(valid, 'macos'), '快捷交互窗')

  for (const bad of ['', '   ', 'bad\0id', 'bad\nid', 'x'.repeat(129), 42, null, undefined]) {
    assert.equal(normalizeBehavior({ type: 'quickOverlay', profileId: bad }), null)
  }

  const map = createEmptyBehaviorMap()
  map.menu.click = [valid]
  assert.deepEqual(parseStoredBehaviors(JSON.stringify(map)), map)

  const text = serializeSequence([valid])
  assert.equal(text, 'axonkey/2\nquick prof-prompts\nend')
  const importedSeq = parseSequenceImport(text)
  assert.equal(importedSeq.length, 1)
  assert.equal(importedSeq[0].type, 'quickOverlay')
  assert.equal(importedSeq[0].profileId, 'prof-prompts')

  const exported = createMappingExport(map, true)
  assert.equal(exported.version, 3)
  assert.equal(exported.minAppVersion, quickOverlayMinAppVersion)
  assert.deepEqual(parseMappingImport(exported).behaviors, map)
})

test('quick profiles keep activeProfileId unchanged and stay isolated from permanent profile switching', () => {
  const baseInstance = {
    id: 'inst-1',
    kind: 'rc003',
    name: '客厅遥控器',
    binding: null,
    enabled: true,
    activeProfileId: 'main-1',
    profiles: [
      { id: 'main-1', name: '默认配置', behaviors: {} },
      { id: 'main-2', name: '办公配置', behaviors: {} },
    ],
  }
  const { instance: withQuick, profileId } = addQuickInstanceProfile(baseInstance, 'Prompt 面板')
  assert.equal(withQuick.activeProfileId, 'main-1')
  const quickProfile = withQuick.profiles.find(p => p.id === profileId)
  assert.equal(quickProfile.quick, true)
  assert.equal(quickProfile.name, 'Prompt 面板')

  withQuick.profiles.find(p => p.id === profileId).behaviors = {
    menu: { click: [createBehavior({ type: 'paste', text: '翻译成英文', id: 'p1' })], doubleClick: [], longPress: [] },
  }
  const switched = applyInstanceProfileSwitch(
    withQuick,
    'menu',
    'click',
    createBehavior({ type: 'switchProfile', direction: 'next', wrap: true }),
  )
  assert.equal(switched.profiles.find(p => p.id === 'main-1').behaviors.menu.click[0].type, 'switchProfile')
  assert.equal(switched.profiles.find(p => p.id === 'main-2').behaviors.menu.click[0].type, 'switchProfile')
  assert.equal(switched.profiles.find(p => p.id === profileId).behaviors.menu.click[0].type, 'paste')

  const afterQuickDelete = deleteInstanceProfile(switched, profileId)
  assert.equal(afterQuickDelete.profiles.length, 2)
  const afterMainDelete = deleteInstanceProfile(afterQuickDelete, 'main-2')
  assert.equal(afterMainDelete.profiles.length, 1)
  // Deleting the sole remaining regular profile is blocked even if a quick profile exists.
  const withOnlyOneRegularAndOneQuick = addQuickInstanceProfile(afterMainDelete, '面板 2').instance
  assert.equal(deleteInstanceProfile(withOnlyOneRegularAndOneQuick, 'main-1').profiles.length, 2)
})

test('shared and mouse profile navigation skip quick profiles and preserve regular defaults', () => {
  const behaviors = createEmptyBehaviorMap()
  const state = {
    activeProfileIds: { rc003: 'r1', cmiotA15: 'a1', mouse: 'm1' },
    behaviors,
    profiles: [
      { id: 'r1', name: '默认', deviceId: 'rc003', behaviors: createEmptyBehaviorMap() },
      { id: 'rq', name: '快捷面板', deviceId: 'rc003', quick: true, behaviors: createEmptyBehaviorMap() },
      { id: 'r2', name: '影音', deviceId: 'rc003', behaviors: createEmptyBehaviorMap() },
      { id: 'a1', name: '默认', deviceId: 'cmiotA15', behaviors: createEmptyBehaviorMap() },
      { id: 'm1', name: '鼠标默认', deviceId: 'mouse', behaviors: createEmptyBehaviorMap() },
      { id: 'mq', name: '鼠标快捷', deviceId: 'mouse', quick: true, behaviors: createEmptyBehaviorMap() },
    ],
  }
  state.profiles.find(p => p.id === 'rq').behaviors.up.click = [createBehavior({ type: 'key', key: 'A', id: 'ka' })]

  assert.equal(adjacentProfileId(state.profiles, 'r1', { deviceId: 'rc003', direction: 'next', wrap: true }), 'r2')
  assert.equal(adjacentProfileId(state.profiles, 'r2', { deviceId: 'rc003', direction: 'previous', wrap: true }), 'r1')
  assert.deepEqual(
    profileSwitchTargets(state, 'up', 'click').map(t => t.id),
    ['r1', 'r2'],
  )

  const applied = applySharedProfileSwitch(
    state,
    'up',
    'click',
    createBehavior({ type: 'switchProfile', direction: 'next', wrap: true }),
  )
  assert.equal(applied.profiles.find(p => p.id === 'r1').behaviors.up.click[0].type, 'switchProfile')
  assert.equal(applied.profiles.find(p => p.id === 'rq').behaviors.up.click[0].type, 'key')

  // Mouse cannot delete its sole regular profile even when a quick profile exists.
  assert.equal(deleteMouseProfile(state.profiles, 'm1', 'm1').profiles.length, 6)
  assert.equal(deleteMouseProfile(state.profiles, 'mq', 'm1').profiles.length, 5)

  // Stored device profiles never select a quick profile as activeProfileId on boot.
  const parsed = parseStoredDeviceProfiles(
    { version: 2, activeProfileIds: { rc003: 'rq', cmiotA15: 'a1', mouse: 'mq' }, profiles: state.profiles },
    behaviors,
  )
  assert.equal(parsed.activeProfileIds.rc003, 'r1')
  assert.equal(parsed.activeProfileIds.mouse, 'm1')
  assert.equal(parsed.profiles.find(p => p.id === 'rq').quick, true)
})

test('backup and cloud restore preserve quick profiles and remap quickOverlay profileId references', () => {
  const data = sampleData()
  const quickBehaviors = createEmptyBehaviorMap()
  quickBehaviors.up.click = [createBehavior({ type: 'paste', text: '总结要点', id: 'sum-1' })]
  data.profiles.push({
    id: 'rc003:quick-prompts',
    name: 'AI 面板',
    deviceId: 'rc003',
    quick: true,
    behaviors: quickBehaviors,
  })
  data.behaviors.menu.click = [
    createBehavior({ type: 'quickOverlay', profileId: 'rc003:quick-prompts', id: 'summon-1' }),
  ]

  const backup = createDataBackup(data, '1.9.10')
  assert.equal(backup.version, 3)
  assert.equal(backup.minAppVersion, quickOverlayMinAppVersion)
  const parsed = parseDataBackup(JSON.stringify(backup))
  assert.equal(parsed.profiles.find(p => p.id === 'rc003:quick-prompts').quick, true)
  assert.equal(
    parsed.profiles.find(p => p.id === data.activeProfileIds.rc003).behaviors.menu.click[0].profileId,
    'rc003:quick-prompts',
  )

  const instance = {
    id: 'dev-1',
    kind: 'rc003',
    name: '书房遥控器',
    enabled: true,
    binding: null,
    activeProfileId: 'p-main',
    profiles: [
      {
        id: 'p-main',
        name: '常驻配置',
        behaviors: {
          menu: {
            click: [createBehavior({ type: 'quickOverlay', profileId: 'p-quick', id: 'trig-1' })],
            doubleClick: [],
            longPress: [],
          },
        },
      },
      {
        id: 'p-quick',
        name: 'Prompt 面板',
        quick: true,
        behaviors: {
          up: {
            click: [createBehavior({ type: 'paste', text: '解释代码', id: 'prompt-1' })],
            doubleClick: [],
            longPress: [],
          },
        },
      },
    ],
  }
  const snapshot = createCloudSnapshot(createDataBackup(sampleData(), '1.9.10'), [instance])
  const cloudState = {
    models: [{ id: 'm-rc003', code: 'rc003' }],
    documents: [
      {
        id: 'doc-1',
        model_id: 'm-rc003',
        instance_key: 'dev-1',
        revision: 1,
        config: snapshot.documents.find(d => d.key === 'dev-1').config,
      },
    ],
    settings: null,
  }
  const prevStorage = globalThis.localStorage
  globalThis.localStorage = { getItem: () => null }
  try {
    const restored = prepareCloudRestore(cloudState, createDataBackup(sampleData(), '1.9.10'), [], {
      devices: [{ documentId: 'doc-1', profileIds: ['p-main', 'p-quick'], targetId: 'new:restored-dev' }],
      settings: false,
      savedBehaviors: false,
    })
    const dev = restored.instances[0]
    const restoredMain = dev.profiles.find(p => p.name === '常驻配置')
    const restoredQuick = dev.profiles.find(p => p.name === 'Prompt 面板')
    assert.equal(restoredQuick.quick, true)
    assert.equal(dev.activeProfileId, restoredMain.id)
    assert.equal(restoredMain.behaviors.menu.click[0].profileId, restoredQuick.id)
  } finally {
    globalThis.localStorage = prevStorage
  }
})

test('cloud snapshot includes a named quick profile before assigning any behaviors', () => {
  const base = {
    id: 'device-empty-quick',
    kind: 'kivoK18Lite',
    name: '小键盘',
    binding: null,
    enabled: true,
    activeProfileId: 'default',
    profiles: [{ id: 'default', name: '默认配置', behaviors: {} }],
  }
  const { instance, profileId } = addQuickInstanceProfile(base, '待配置的交互窗')
  const snapshot = createCloudSnapshot(createDataBackup(sampleData(), '1.9.11'), [instance])
  const document = snapshot.documents.find(item => item.key === instance.id)
  assert.equal(document.config.activeProfileId, 'default')
  assert.deepEqual(document.config.profiles.find(profile => profile.id === profileId), {
    id: profileId,
    name: '待配置的交互窗',
    quick: true,
    behaviors: {},
  })
})

test('CLI supports quick profile creation, blocks activating quick profiles, and validates quickOverlay mappings', async () => {
  assert.deepEqual(normalizeCliBehavior({ type: 'quickOverlay', profileId: 'prof-1' }, 'macos'), {
    type: 'quickOverlay',
    profileId: 'prof-1',
    enabled: true,
  })
  assert.deepEqual(
    behaviorToCliBehavior({ id: '1', enabled: true, type: 'quickOverlay', profileId: 'prof-1' }, 'macos'),
    { type: 'quickOverlay', profileId: 'prof-1', enabled: true },
  )

  let snapshot = {
    store: {
      version: 1,
      revision: 1,
      instances: [
        {
          id: 'rc-1',
          kind: 'rc003',
          name: '遥控器',
          binding: null,
          enabled: true,
          activeProfileId: 'p1',
          profiles: [{ id: 'p1', name: '默认配置', behaviors: {} }],
        },
      ],
    },
    discovered: [],
    runtime: {},
    error: null,
    scanError: null,
    scanning: false,
  }
  const update = async (id, change) => {
    snapshot = {
      ...snapshot,
      store: {
        ...snapshot.store,
        revision: snapshot.store.revision + 1,
        instances: snapshot.store.instances.map(item => (item.id === id ? change(item) : item)),
      },
    }
    return snapshot
  }

  const created = await processInstanceCliRequest(
    'profile.create',
    { device: 'rc003', name: '快捷指令', quick: true },
    { platform: 'macos', snapshot, update },
  )
  assert.equal(created.profile.quick, true)
  assert.equal(created.profile.active, false)
  assert.equal(snapshot.store.instances[0].activeProfileId, 'p1')

  await assert.rejects(
    () =>
      processInstanceCliRequest(
        'profile.activate',
        { device: 'rc003', profile: '快捷指令' },
        { platform: 'macos', snapshot, update },
      ),
    /快捷交互配置/,
  )

  // Can bind quickOverlay by profile name and it resolves to canonical profile ID
  const mapped = await processInstanceCliRequest(
    'mapping.set',
    {
      device: 'rc003',
      button: 'menu',
      trigger: 'click',
      sequence: [{ type: 'quickOverlay', profileId: '快捷指令' }],
    },
    { platform: 'macos', snapshot, update },
  )
  assert.equal(mapped.after[0].type, 'quickOverlay')
  assert.equal(mapped.after[0].profileId, created.profile.id)

  // Rejects non-exclusive quickOverlay sequence
  await assert.rejects(
    () =>
      processInstanceCliRequest(
        'mapping.set',
        {
          device: 'rc003',
          button: 'menu',
          trigger: 'click',
          sequence: [
            { type: 'quickOverlay', profileId: created.profile.id },
            { type: 'key', key: 'Enter' },
          ],
        },
        { platform: 'macos', snapshot, update },
      ),
    /唯一行为/,
  )

  // Mouse CLI also supports quick profiles and quickOverlay
  let mouseState = {
    profiles: [{ id: 'm1', name: '默认配置', deviceId: 'mouse', behaviors: createEmptyBehaviorMap() }],
    activeProfileIds: { rc003: 'r1', cmiotA15: 'a1', mouse: 'm1' },
    behaviors: createEmptyBehaviorMap(),
    globalProfileId: 'm1',
    autoSwitching: false,
  }
  const createdMouse = await processMouseCliRequest(
    'profile.create',
    { name: '鼠标面板', quick: true },
    mouseState,
    'macos',
    async next => {
      mouseState = next
    },
  )
  assert.equal(createdMouse.profile.quick, true)
  assert.equal(mouseState.globalProfileId, 'm1')
})
