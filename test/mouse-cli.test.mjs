import assert from 'node:assert/strict'
import test from 'node:test'
import { registerHooks } from 'node:module'

const assets = registerHooks({
  load(url, context, next) {
    return url.endsWith('.svg') ? { format: 'module', source: 'export default "asset.svg"', shortCircuit: true } : next(url, context)
  },
})
const { processMouseCliRequest } = await import('../src/mouseCli.ts')
assets.deregister()
const { createEmptyBehaviorMap, createBehavior } = await import('../src/behaviorModel.ts')
const { createDefaultDeviceProfiles, composeActiveProfileBehaviors, parseStoredDeviceProfiles } = await import('../src/deviceProfiles.ts')
const { bindMouseApplication, deleteMouseProfile, effectiveMouseProfileId } = await import('../src/mouseProfiles.ts')

function workspace(initialState) {
  const defaults = createDefaultDeviceProfiles(createEmptyBehaviorMap())
  let state = initialState ?? { ...defaults, behaviors: createEmptyBehaviorMap(), globalProfileId: defaults.activeProfileIds.mouse, autoSwitching: false }
  return {
    get state() { return state },
    command(method, params = {}, save) {
      return processMouseCliRequest(method, params, state, 'windows', save ?? (async next => {
        state = { ...next, behaviors: composeActiveProfileBehaviors(next.profiles, next.activeProfileIds) }
      }))
    },
  }
}

test('mouse CLI previews every shared-switch overwrite, including live app edits, without changing the selected context', async () => {
  const defaults = createDefaultDeviceProfiles(createEmptyBehaviorMap())
  const globalId = defaults.activeProfileIds.mouse
  const button = 'mouse.top.up'
  const appBehaviors = createEmptyBehaviorMap()
  appBehaviors[button].click = [createBehavior({ type: 'key', key: 'B' })]
  const profiles = [...defaults.profiles, { id: 'app-profile', name: '应用配置', deviceId: 'mouse', applicationIds: ['browser'], behaviors: appBehaviors }]
  const activeProfileIds = { ...defaults.activeProfileIds, mouse: 'app-profile' }
  const behaviors = composeActiveProfileBehaviors(profiles, activeProfileIds)
  behaviors[button].click = [createBehavior({ type: 'key', key: 'C' })]
  const work = workspace({ profiles, activeProfileIds, behaviors, globalProfileId: globalId, autoSwitching: true })
  const initial = structuredClone(work.state)
  const sequence = [{ type: 'switchProfile', direction: 'next', wrap: true }]
  const preview = await work.command('mapping.set', { button, sequence, dryRun: true })
  assert.deepEqual(work.state, initial)
  assert.equal(preview.profile.id, globalId)
  assert.deepEqual(preview.affectedProfiles.map(item => item.id), [globalId, 'app-profile'])
  assert.deepEqual(preview.affectedProfiles[1].before, [{ type: 'key', key: 'C', enabled: true }])
  assert.ok(preview.affectedProfiles.every(item => item.after[0].type === 'switchProfile'))
  const applied = await work.command('mapping.set', { button, sequence })
  assert.deepEqual(applied.affectedProfiles, preview.affectedProfiles)
  assert.equal(work.state.activeProfileIds.mouse, 'app-profile')
  assert.equal(work.state.globalProfileId, globalId)
  assert.deepEqual(work.state.profiles.find(profile => profile.id === 'app-profile').applicationIds, ['browser'])
  assert.deepEqual((await work.command('mapping.set', { button, sequence, dryRun: true })).affectedProfiles, [])
  const cleared = await work.command('mapping.clear', { button, yes: true, dryRun: true })
  assert.equal(cleared.affectedProfiles.length, 2)
  assert.ok(cleared.affectedProfiles.every(item => item.after.length === 0))
  const replacement = await work.command('shortcut.set', { button, keys: 'Ctrl+A' })
  assert.equal(replacement.affectedProfiles.length, 2)
  assert.equal(replacement.affectedProfiles[0].after[0].type, 'shortcut')
  assert.deepEqual(replacement.affectedProfiles[1].after, [])
  assert.deepEqual(work.state.profiles.filter(profile => profile.deviceId !== 'mouse'), initial.profiles.filter(profile => profile.deviceId !== 'mouse'))
})

for (const deletedId of ['app-profile', 'mouse:default']) {
  test(`mouse CLI reads and rebinds the application after the UI deletes ${deletedId}`, async () => {
    const defaults = createDefaultDeviceProfiles(createEmptyBehaviorMap())
    const profiles = [...defaults.profiles, { id: 'app-profile', name: '应用配置', deviceId: 'mouse', applicationIds: ['browser'], behaviors: createEmptyBehaviorMap() }]
    const deleted = deleteMouseProfile(bindMouseApplication(profiles, 'browser', deletedId), deletedId, defaults.activeProfileIds.mouse)
    const activeProfileIds = { ...defaults.activeProfileIds, mouse: deleted.globalProfileId }
    const work = workspace({ ...deleted, activeProfileIds, behaviors: composeActiveProfileBehaviors(deleted.profiles, activeProfileIds), autoSwitching: false })
    const applications = await work.command('profile.application-list')
    assert.equal(applications.applicationProfileSwitching, false)
    assert.equal(applications.applications[0].id, 'browser')
    assert.equal(applications.applications[0].profile.id, deleted.globalProfileId)
    const created = await work.command('profile.create', { name: '新应用配置' })
    await work.command('profile.activate', { profile: deleted.globalProfileId })
    await work.command('profile.application-set', { application: 'browser', profile: created.profile.id })
    assert.equal(work.state.globalProfileId, deleted.globalProfileId)
    assert.equal(work.state.autoSwitching, false)
    assert.equal((await work.command('profile.application-list')).applications[0].profile.id, created.profile.id)
    await assert.rejects(work.command('mapping.get', { profile: deletedId, button: 'mouse.top.up' }), error => error.code === 'invalid_target')
    await assert.rejects(work.command('profile.delete', { profile: created.profile.id }), error => error.code === 'invalid_arguments')
  })
}

test('mouse app associations restore the global runtime mapping without changing the editor or saved global selection', async () => {
  const work = workspace()
  const globalId = work.state.globalProfileId
  const app = await work.command('profile.create', { name: '浏览器' })
  await work.command('profile.activate', { profile: globalId })
  await work.command('profile.application-set', { application: 'browser', profile: app.profile.id })
  const state = work.state
  assert.equal(effectiveMouseProfileId(state.profiles, globalId, true, 'browser'), app.profile.id)
  assert.equal(effectiveMouseProfileId(state.profiles, globalId, true, 'other'), globalId)
  assert.equal(effectiveMouseProfileId(state.profiles, globalId, true, undefined), globalId)
  assert.equal(effectiveMouseProfileId(state.profiles, globalId, false, 'browser'), globalId)
  assert.equal(state.activeProfileIds.mouse, globalId)
  const loaded = parseStoredDeviceProfiles({ version: 2, profiles: state.profiles, activeProfileIds: { ...state.activeProfileIds, mouse: globalId }, applicationProfileSwitching: { mouse: true } }, state.behaviors)
  assert.equal(loaded.activeProfileIds.mouse, globalId)
  assert.equal(effectiveMouseProfileId(loaded.profiles, globalId, loaded.applicationProfileSwitching.mouse, 'browser'), app.profile.id)
  const rebound = bindMouseApplication(state.profiles, 'browser', globalId)
  assert.equal(rebound.filter(profile => profile.applicationIds?.includes('browser')).length, 1)
  await work.command('profile.application-remove', { application: 'browser' })
  assert.deepEqual((await work.command('profile.application-list')).applications, [])
})

test('mouse CLI shares profile switches, inherits them, and removes them from every profile', async () => {
  const work = workspace()
  const button = 'mouse.top.up'
  await work.command('profile.create', { name: '第二套' })
  await work.command('mapping.set', { button, sequence: [{ type: 'switchProfile', direction: 'next' }] })
  await work.command('profile.create', { name: '第三套' })
  for (const profile of work.state.profiles.filter(profile => profile.deviceId === 'mouse')) {
    assert.equal((await work.command('mapping.get', { button, profile: profile.id })).actions[0].type, 'switchProfile')
  }
  await assert.rejects(work.command('mapping.set', { button, sequence: [{ type: 'switchProfile', direction: 'next' }, { type: 'delay', ms: 1 }] }), error => error.code === 'invalid_behavior')
  await work.command('mapping.clear', { button, yes: true })
  assert.ok(work.state.profiles.filter(profile => profile.deviceId === 'mouse').every(profile => profile.behaviors[button].click.length === 0))
})

test('mouse CLI rejects ambiguous targets, validates dry run and waits for a successful save/apply', async () => {
  const work = workspace()
  const original = structuredClone(work.state)
  const preview = await work.command('mapping.set', { button: 'mouse.top.up', keys: 'Ctrl+A', sequence: [{ type: 'key', key: 'A' }], dryRun: true })
  assert.equal(preview.dryRun, true)
  assert.deepEqual(work.state, original)
  await assert.rejects(work.command('mapping.set', { button: 'mouse.top.up', sequence: [], dryRun: 'true' }), error => error.code === 'invalid_arguments')
  let finish
  let completed = false
  const pending = work.command('mapping.clear', { button: 'mouse.top.up', yes: true }, async () => {
    await new Promise(resolve => { finish = resolve })
    throw new Error('native apply failed')
  }).finally(() => { completed = true })
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(completed, false)
  finish()
  await assert.rejects(pending, /native apply failed/)
  assert.deepEqual(work.state, original)
})
