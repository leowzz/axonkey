import type { StepDefinition } from 'sequential-workflow-designer'
import type { Platform } from '../appTypes.ts'
import { createBehavior, normalizeBehaviorTitle } from '../behaviorModel.ts'
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
  if (step.type === 'switchProfile' || step.type === 'quickOverlay' || step.type === 'clipboardOverlay') return false
  if (step.type !== 'savedSequence') return true
  const behaviors = savedSequenceBehaviors(step.properties as Pick<SavedSequence, 'sequence' | 'libraryItemIds'>)
  return (
    !!behaviors?.length &&
    behaviors.every(
      behavior =>
        behavior.type !== 'switchProfile' && behavior.type !== 'quickOverlay' && behavior.type !== 'clipboardOverlay',
    )
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

export type QuickPromptDraft = {
  title: string
  content: string
  method: 'paste' | 'typeText'
  autoEnter: boolean
}

export type QuickPromptInspection =
  { kind: 'empty' } | { kind: 'prompt'; prompt: QuickPromptDraft } | { kind: 'other'; summary: string }

const isPromptEnterKey = (step: Behavior) => step.type === 'key' && (step.key === 'Enter' || step.key === 'Return')

export function extractQuickPrompt(sequence: Behavior[], platform: Platform): QuickPromptInspection {
  if (sequence.length === 0) return { kind: 'empty' }
  if (sequence.every(step => step.enabled !== false)) {
    const first = sequence[0]
    if (first.type === 'paste' || first.type === 'typeText') {
      if (sequence.length === 1) {
        return {
          kind: 'prompt',
          prompt: { title: first.title ?? '', content: first.text, method: first.type, autoEnter: false },
        }
      }
      if (
        (sequence.length === 2 && isPromptEnterKey(sequence[1])) ||
        (sequence.length === 3 && sequence[1].type === 'delay' && isPromptEnterKey(sequence[2]))
      ) {
        return {
          kind: 'prompt',
          prompt: { title: first.title ?? '', content: first.text, method: first.type, autoEnter: true },
        }
      }
    }
  }
  return {
    kind: 'other',
    summary: sequence.map(step => behaviorSummary(step, platform)).join(' → '),
  }
}

export function buildQuickPromptSequence(draft: QuickPromptDraft, existing?: Behavior[]): Behavior[] {
  const title = normalizeBehaviorTitle(draft.title)
  if (!title && !draft.content) return []
  const firstId =
    existing?.[0] && (existing[0].type === 'paste' || existing[0].type === 'typeText') ? existing[0].id : undefined
  const delayId = existing?.[1]?.type === 'delay' ? existing[1].id : undefined
  const enterCandidate =
    existing?.[1]?.type === 'key' ? existing[1] : existing?.[2]?.type === 'key' ? existing[2] : undefined
  const primary = createBehavior({
    id: firstId,
    type: draft.method,
    text: draft.content,
    title,
  })
  if (!draft.autoEnter) return [primary]
  return [
    primary,
    createBehavior({ id: delayId, type: 'delay', ms: 30 }),
    createBehavior({ id: enterCandidate?.id, type: 'key', key: 'Enter' }),
  ]
}
