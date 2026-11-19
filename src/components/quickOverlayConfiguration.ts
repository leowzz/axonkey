import type { StepDefinition } from 'sequential-workflow-designer'
import type { Platform } from '../appTypes.ts'
import { createBehavior } from '../behaviorModel.ts'
import type { Behavior, TriggerBehaviors } from '../behaviorModel.ts'
import { behaviorSummary } from '../behaviorSummary.ts'
import { savedSequenceBehaviors } from '../savedSequences.ts'
import type { SavedSequence } from '../savedSequences.ts'
import { insertedWorkflowSteps } from './workflowBehaviorBridge.ts'
import { workflowStepBehavior } from './workflowStepEditing.ts'

export function quickOverlayClickBehaviors(behaviors: Record<string, TriggerBehaviors>) {
  return Object.fromEntries(
    Object.entries(behaviors)
      .filter(([, sequence]) => sequence.click.length > 0)
      .map(([id, sequence]) => [id, { click: sequence.click, doubleClick: [], longPress: [] }]),
  )
}

export function quickOverlayAllowsToolboxStep(step: StepDefinition) {
  if (step.type === 'switchProfile' || step.type === 'quickOverlay') return false
  if (step.type !== 'savedSequence') return true
  const behaviors = savedSequenceBehaviors(step.properties as Pick<SavedSequence, 'sequence' | 'libraryItemIds'>)
  return (
    !!behaviors?.length &&
    behaviors.every(behavior => behavior.type !== 'switchProfile' && behavior.type !== 'quickOverlay')
  )
}

export function quickOverlayToolboxInsertion(step: StepDefinition, platform: Platform, id: string) {
  const nodes = insertedWorkflowSteps({ ...step, id }, platform, behavior => behaviorSummary(behavior, platform))
  const additions: Behavior[] = []
  const libraryItems: string[] = []
  for (const node of nodes) {
    const behavior = workflowStepBehavior(node)
    if (!behavior) continue
    additions.push(behavior)
    const libraryItem = node.properties.pendingLibraryAddition
    if (typeof libraryItem === 'string') libraryItems.push(libraryItem)
  }
  return { additions, libraryItems, needsEdit: Boolean(nodes[0]?.properties.draftGroup) }
}

export function insertQuickOverlaySteps(sequence: Behavior[], index: number, additions: Behavior[]) {
  if (isDisabledSequence(additions) || isDisabledSequence(sequence)) return additions
  const next = [...sequence]
  next.splice(
    index,
    0,
    ...additions.map(behavior =>
      sequence.some(existing => existing.id === behavior.id)
        ? createBehavior({ ...behavior, id: undefined })
        : behavior,
    ),
  )
  return next
}

function isDisabledSequence(sequence: Behavior[]) {
  return sequence.length === 1 && sequence[0].type === 'disabled' && sequence[0].enabled
}

export function moveQuickOverlayStep(sequence: Behavior[], stepId: string, targetIndex: number) {
  const index = sequence.findIndex(behavior => behavior.id === stepId)
  if (index === -1 || index === targetIndex || index + 1 === targetIndex) return sequence
  const next = [...sequence]
  const [step] = next.splice(index, 1)
  next.splice(targetIndex > index ? targetIndex - 1 : targetIndex, 0, step)
  return next
}
