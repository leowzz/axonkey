import assert from 'node:assert/strict'
import test from 'node:test'
import { adjacentProfileId, changeProfileState, applySharedProfileSwitch, profileSwitchTargets, removedProfileSwitchTriggers, removeSharedProfileSwitch } from '../src/profileNavigation.ts'
import { createBehavior, createEmptyBehaviorMap, normalizeBehavior, serializeSequence, parseSequenceImport, createMappingExport, parseMappingImport } from '../src/behaviorModel.ts'
import { behaviorsToWorkflow, insertedWorkflowSteps, workflowBranches, workflowToBehaviors } from '../src/components/workflowBehaviorBridge.ts'
import { workflowBehaviorProperties } from '../src/components/workflowStepEditing.ts'

const profiles = ['a', 'b', 'c'].map(id => ({ id, name: id, behaviors: createEmptyBehaviorMap() }))
test('previous and next respect profile order, optional wrapping and empty/single/unknown profiles', () => {
  for (const wrap of [false, true]) {
    assert.equal(adjacentProfileId(profiles, 'b', { direction: 'previous', wrap }), 'a')
    assert.equal(adjacentProfileId(profiles, 'b', { direction: 'next', wrap }), 'c')
    assert.equal(adjacentProfileId(profiles, 'a', { direction: 'previous', wrap }), wrap ? 'c' : null)
    assert.equal(adjacentProfileId(profiles, 'c', { direction: 'next', wrap }), wrap ? 'a' : null)
    assert.equal(adjacentProfileId([], 'a', { direction: 'next', wrap }), null)
    assert.equal(adjacentProfileId(profiles.slice(0, 1), 'a', { direction: 'previous', wrap }), null)
    assert.equal(adjacentProfileId(profiles, 'missing', { direction: 'next', wrap }), null)
  }
})

test('rapid consecutive switches preserve unsaved edits and isolate each profile', () => {
  const behaviors = createEmptyBehaviorMap()
  behaviors.power.click.push(createBehavior({ type: 'key', key: 'A' }))
  let state = { profiles, activeProfileId: 'a', behaviors }
  for (let index = 0; index < 8; index++) {
    const id = adjacentProfileId(state.profiles, state.activeProfileId, { direction: 'next', wrap: true })
    state = changeProfileState(state, id)
  }
  assert.equal(state.activeProfileId, 'c')
  assert.equal(state.profiles[0].behaviors.power.click[0].key, 'A')
  assert.equal(profiles[0].behaviors.power.click.length, 0)
  state = changeProfileState(state, 'a')
  state.behaviors.power.click[0].key = 'B'
  assert.equal(state.profiles[0].behaviors.power.click[0].key, 'A')
  assert.equal(changeProfileState(state, 'a'), null)
  assert.equal(changeProfileState(state, 'missing'), null)
})

test('profile switch defaults, drafts, edits and both transfer formats retain direction and wrap', () => {
  assert.deepEqual(createBehavior({ id: 'switch', type: 'switchProfile' }), { id: 'switch', enabled: true, type: 'switchProfile', direction: 'next', wrap: true })
  assert.equal(normalizeBehavior({ type: 'switchProfile', direction: 'invalid' }), null)
  assert.equal(normalizeBehavior({ type: 'switchProfile', direction: 'next', wrap: 'false' }), null)
  for (const direction of ['previous', 'next']) for (const wrap of [false, true]) {
    const behavior = createBehavior({ type: 'switchProfile', direction, wrap, enabled: false })
    const parsed = parseSequenceImport(serializeSequence([behavior]))[0]
    assert.deepEqual({ ...parsed, id: behavior.id }, behavior)
    assert.notEqual(parsed.id, behavior.id)
    const map = createEmptyBehaviorMap()
    map.power.click.push(behavior)
    assert.deepEqual(parseMappingImport(JSON.stringify(createMappingExport(map, true))).behaviors, map)
    const workflow = behaviorsToWorkflow({ click: [], doubleClick: [], longPress: [] }, () => '切换配置文件')
    const node = insertedWorkflowSteps({ id: 'draft', type: 'switchProfile', componentType: 'task', name: '切换配置文件', properties: {} }, 'macos', () => '切换配置文件')[0]
    workflowBranches(workflow).click.push(node)
    assert.equal(workflowToBehaviors(workflow).click.length, 0)
    node.properties = workflowBehaviorProperties(node, behavior)
    delete node.properties.draftGroup
    assert.deepEqual(workflowToBehaviors(workflow).click[0], { ...behavior, id: 'draft', enabled: true })
  }
})


test('overwrite preview includes live edits and confirmation changes only the same input and trigger in every profile', () => {
  const first = createEmptyBehaviorMap()
  first.power.click.push(createBehavior({ type: 'key', key: 'A' }))
  const live = structuredClone(first)
  live.power.click[0].key = 'B'
  live.power.longPress.push(createBehavior({ type: 'delay', ms: 900 }))
  const second = createEmptyBehaviorMap()
  second.power.click.push(createBehavior({ type: 'disabled' }))
  second.voice.click.push(createBehavior({ type: 'paste', text: '保持不变' }))
  const current = { profiles: [{ id: 'a', name: '工作', behaviors: first }, { id: 'b', name: '娱乐', behaviors: second }], activeProfileId: 'a', behaviors: live }
  const before = structuredClone(current)
  const targets = profileSwitchTargets(current, 'power', 'click')
  assert.deepEqual(targets.map(item => item.name), ['工作', '娱乐'])
  assert.equal(targets[0].behaviors[0].key, 'B', 'the active preview uses the latest editor contents')
  assert.equal(targets[1].behaviors[0].type, 'disabled')
  assert.deepEqual(current, before, 'preview or cancel cannot modify any profile')
  const result = applySharedProfileSwitch(current, 'power', 'click', createBehavior({ type: 'switchProfile', direction: 'previous' }))
  for (const profile of result.profiles) {
    assert.equal(profile.behaviors.power.click.length, 1)
    assert.equal(profile.behaviors.power.click[0].type, 'switchProfile')
    assert.equal(profile.behaviors.power.click[0].direction, 'previous')
    assert.equal(profile.behaviors.power.click[0].wrap, true)
  }
  assert.notEqual(result.profiles[0].behaviors.power.click[0].id, result.profiles[1].behaviors.power.click[0].id)
  assert.deepEqual(result.profiles[0].behaviors.power.longPress, live.power.longPress)
  assert.deepEqual(result.profiles[1].behaviors.voice, second.voice)
  assert.deepEqual(current, before)
  const switched = changeProfileState(result, 'b')
  assert.equal(switched.behaviors.power.click[0].type, 'switchProfile')
})

test('shared deletion waits for confirmation, uses live edits and removes only corresponding switches in every profile', () => {
  const first = createEmptyBehaviorMap()
  first.power.click = [createBehavior({ type: 'switchProfile' })]
  const live = structuredClone(first)
  live.power.longPress = [createBehavior({ type: 'key', key: 'B' })]
  const second = createEmptyBehaviorMap()
  second.power.click = [createBehavior({ type: 'delay', ms: 400 }), createBehavior({ type: 'switchProfile', enabled: false })]
  second.power.doubleClick = [createBehavior({ type: 'switchProfile', direction: 'previous' })]
  second.voice.click = [createBehavior({ type: 'switchProfile' })]
  const third = createEmptyBehaviorMap()
  third.power.click = [createBehavior({ type: 'key', key: 'C' })]
  const current = { profiles: [{ id: 'a', name: '工作', behaviors: first }, { id: 'b', name: '游戏', behaviors: second }, { id: 'c', name: '阅读', behaviors: third }], activeProfileId: 'a', behaviors: live }
  const before = structuredClone(current)
  const proposal = { ...live.power, click: [] }
  const triggers = removedProfileSwitchTriggers(live.power, proposal)
  assert.deepEqual(triggers, ['click'])
  assert.deepEqual(removedProfileSwitchTriggers(live.power, structuredClone(live.power)), [])
  assert.deepEqual(current, before, 'requesting or cancelling deletion leaves every profile intact')
  const result = removeSharedProfileSwitch(current, { profileId: 'a', inputId: 'power', triggers, sequences: proposal })
  assert.deepEqual(result.behaviors.power.click, [])
  assert.deepEqual(result.profiles[1].behaviors.power.click, [second.power.click[0]])
  assert.deepEqual(result.profiles[2].behaviors.power.click, third.power.click)
  assert.deepEqual(result.behaviors.power.longPress, live.power.longPress)
  assert.deepEqual(result.profiles[1].behaviors.power.doubleClick, second.power.doubleClick)
  assert.deepEqual(result.profiles[1].behaviors.voice, second.voice)
  assert.deepEqual(changeProfileState(result, 'b').behaviors.power.click, [second.power.click[0]])
  assert.deepEqual(current, before)
})

test('batch deletion stays attached to its original profile if hardware switches profiles while confirmation is open', () => {
  const first = createEmptyBehaviorMap()
  first.power.click = [createBehavior({ type: 'switchProfile' })]
  first.power.doubleClick = [createBehavior({ type: 'switchProfile', direction: 'previous' })]
  first.power.longPress = [createBehavior({ type: 'key', key: 'A' })]
  const second = createEmptyBehaviorMap()
  second.power.click = [createBehavior({ type: 'switchProfile' })]
  second.power.doubleClick = [createBehavior({ type: 'switchProfile', direction: 'previous' })]
  second.power.longPress = [createBehavior({ type: 'key', key: 'B' })]
  let current = { profiles: [{ id: 'a', name: '工作', behaviors: first }, { id: 'b', name: '游戏', behaviors: second }], activeProfileId: 'a', behaviors: structuredClone(first) }
  const sequences = { click: [], doubleClick: [], longPress: [] }
  const deletion = { profileId: 'a', inputId: 'power', triggers: removedProfileSwitchTriggers(first.power, sequences), sequences }
  assert.deepEqual(deletion.triggers, ['click', 'doubleClick'])
  current = changeProfileState(current, 'b')
  const result = removeSharedProfileSwitch(current, deletion)
  assert.equal(result.activeProfileId, 'b')
  assert.deepEqual(result.profiles[0].behaviors.power, sequences)
  assert.deepEqual(result.behaviors.power.click, [])
  assert.deepEqual(result.behaviors.power.doubleClick, [])
  assert.deepEqual(result.behaviors.power.longPress, second.power.longPress, 'unrelated actions in the newly active profile are preserved')
})
