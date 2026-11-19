import assert from 'node:assert/strict'
import test from 'node:test'
import { createWorkflowActionIconUrls } from '../src/components/workflowActionIcons.ts'
import {
  behaviorToWorkflowStep,
  behaviorsToWorkflow,
  insertedWorkflowSteps,
  workflowBranches,
  workflowToBehaviors,
} from '../src/components/workflowBehaviorBridge.ts'
import {
  findWorkflowStepEditor,
  isEditableWorkflowStep,
  workflowBehaviorProperties,
  workflowStepBehavior,
} from '../src/components/workflowStepEditing.ts'
import { behaviorSummary } from '../src/behaviorSummary.ts'
import { createBehavior } from '../src/behaviorModel.ts'
import { createSavedSequence } from '../src/savedSequences.ts'
import {
  insertQuickOverlaySteps,
  moveQuickOverlayStep,
  quickOverlayAllowsToolboxStep,
  quickOverlayClickBehaviors,
  quickOverlayToolboxInsertion,
} from '../src/components/quickOverlayConfiguration.ts'

test('workflow action icons and step editing support quickOverlay draft-to-saved lifecycle', () => {
  const icons = createWorkflowActionIconUrls('macos')
  assert.match(icons.quickOverlay ?? '', /^data:image\/svg\+xml/)

  const draftNodes = insertedWorkflowSteps(
    {
      id: 'step-q1',
      componentType: 'task',
      type: 'quickOverlay',
      name: '快捷交互窗',
      properties: {},
    },
    'macos',
    behavior => behaviorSummary(behavior, 'macos'),
  )
  assert.equal(draftNodes.length, 1)
  assert.equal(isEditableWorkflowStep(draftNodes[0]), true)
  assert.equal(draftNodes[0].properties.draftGroup, 'step-q1')

  const definition = behaviorsToWorkflow(
    { click: [], doubleClick: [], longPress: [] },
    behavior => behaviorSummary(behavior, 'macos'),
  )
  workflowBranches(definition).click.push(draftNodes[0])

  // Unfinished draft is ignored by workflowToBehaviors until target profileId is chosen.
  assert.deepEqual(workflowToBehaviors(definition), {
    click: [],
    doubleClick: [],
    longPress: [],
  })

  const editor = findWorkflowStepEditor(definition, 'step-q1')
  assert.ok(editor)
  assert.equal(editor.behavior.type, 'quickOverlay')
  assert.equal(editor.behavior.profileId, '')

  // Rejects empty profileId save; accepts valid target profileId and resolves target profile name on label.
  assert.equal(
    workflowBehaviorProperties(draftNodes[0], {
      id: 'step-q1',
      enabled: true,
      type: 'quickOverlay',
      profileId: '   ',
    }),
    null,
  )

  const savedProps = workflowBehaviorProperties(draftNodes[0], {
    id: 'step-q1',
    enabled: true,
    type: 'quickOverlay',
    profileId: 'profile-ai-prompts',
  })
  assert.ok(savedProps)
  assert.equal(savedProps.profileId, 'profile-ai-prompts')

  const profileNames = new Map([['profile-ai-prompts', 'AI 提示词']])
  const committed = behaviorToWorkflowStep(
    createBehavior({ id: 'step-q1', type: 'quickOverlay', profileId: 'profile-ai-prompts' }),
    behavior => behaviorSummary(behavior, 'macos', profileNames),
  )
  assert.equal(committed.name, '快捷交互窗 · AI 提示词')
  workflowBranches(definition).click.splice(0, 1, committed)

  const resolved = workflowToBehaviors(definition)
  assert.ok(resolved)
  assert.equal(resolved.click.length, 1)
  assert.equal(resolved.click[0].type, 'quickOverlay')
  assert.equal(resolved.click[0].profileId, 'profile-ai-prompts')
  assert.deepEqual(workflowStepBehavior(committed), {
    id: 'step-q1',
    enabled: true,
    type: 'quickOverlay',
    profileId: 'profile-ai-prompts',
  })
})

test('quick configuration inserts the toolbox macro and reorders steps independently of other triggers', () => {
  const delay = createBehavior({ id: 'old-delay', type: 'delay', ms: 120 })
  const legacyDouble = createBehavior({ id: 'old-double', type: 'key', key: 'Space' })
  const { additions, needsEdit } = quickOverlayToolboxInsertion(
    { type: 'textAndEnter', name: '输入文本并回车', componentType: 'task', properties: {} },
    'macos',
    'new-text',
  )
  assert.equal(needsEdit, true)
  assert.deepEqual(additions.map(step => step.type), ['paste', 'delay', 'key'])
  const click = insertQuickOverlaySteps([delay], 0, [{ ...additions[0], text: 'hello' }, ...additions.slice(1)])
  const reordered = moveQuickOverlayStep(click, delay.id, 0)
  assert.deepEqual(reordered.map(step => step.type), ['delay', 'paste', 'delay', 'key'])
  assert.equal(moveQuickOverlayStep(reordered, delay.id, 1), reordered)
  const stored = { confirm: { click: reordered, doubleClick: [legacyDouble], longPress: [] } }
  assert.deepEqual(quickOverlayClickBehaviors(stored), {
    confirm: { click: reordered, doubleClick: [], longPress: [] },
  })
  assert.deepEqual(stored.confirm.doubleClick, [legacyDouble])
})

test('quick configuration accepts reusable actions without nested configuration switches', () => {
  const key = createBehavior({ id: 'key', type: 'key', key: 'Enter' })
  const overlay = createBehavior({ id: 'overlay', type: 'quickOverlay', profileId: 'quick-other' })
  const saved = behaviors => ({
    type: 'savedSequence', name: '已保存', componentType: 'task',
    properties: createSavedSequence('已保存', behaviors),
  })
  assert.equal(quickOverlayAllowsToolboxStep(saved([key])), true)
  assert.equal(quickOverlayAllowsToolboxStep(saved([overlay])), false)

  const disabled = createBehavior({ type: 'disabled' })
  assert.deepEqual(insertQuickOverlaySteps([key], 0, [disabled]), [disabled])
  assert.deepEqual(insertQuickOverlaySteps([disabled], 1, [key]), [key])
})

test('quick configuration commits valid action defaults without requiring an edit', () => {
  const defaults = [
    ['volumeControl', { type: 'key', key: 'VolumeUp' }],
    ['mediaTrack', { type: 'key', key: 'MediaPrevious' }],
    ['mouseButton', { type: 'mouse', button: 'left' }],
    ['wheel', { type: 'wheel', direction: 'up' }],
    ['cursorMove', { type: 'cursorMove', direction: 'up', distance: 50 }],
  ]
  for (const platform of ['windows', 'macos']) for (const [type, value] of defaults) {
    const { additions, needsEdit } = quickOverlayToolboxInsertion(
      { type, name: type, componentType: 'task', properties: {} }, platform, type,
    )
    assert.equal(needsEdit, false, `${platform}: ${type}`)
    assert.deepEqual(additions, [{ id: type, enabled: true, ...value }])
  }
})
