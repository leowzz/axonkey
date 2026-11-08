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
const { createEmptyBehaviorMap } = await import('../src/behaviorModel.ts')
const { createDefaultDeviceProfiles, composeActiveProfileBehaviors, parseStoredDeviceProfiles } = await import('../src/deviceProfiles.ts')
const { bindMouseApplication, effectiveMouseProfileId } = await import('../src/mouseProfiles.ts')

function workspace() {
  const defaults = createDefaultDeviceProfiles(createEmptyBehaviorMap())
  let state = { ...defaults, behaviors: createEmptyBehaviorMap(), globalProfileId: defaults.activeProfileIds.mouse, autoSwitching: false }
  return {
    get state() { return state },
    command(method, params = {}, save) {
      return processMouseCliRequest(method, params, state, 'windows', save ?? (async next => {
        state = { ...next, behaviors: composeActiveProfileBehaviors(next.profiles, next.activeProfileIds) }
      }))
    },
  }
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
