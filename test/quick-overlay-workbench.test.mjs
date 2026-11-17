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
