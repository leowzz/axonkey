import type { BranchedStep, Definition, Step } from 'sequential-workflow-designer'
import type { Behavior, BehaviorMap, InputId, TriggerBehaviors, TriggerType } from '../behaviorModel.ts'
import { createBehavior, defaultCursorDistance, normalizeBehavior, parseSequenceImport, triggerTypes } from '../behaviorModel.ts'
import type { Platform } from '../appTypes.ts'
import { createTriggerDefinition } from './WorkflowTriggerRoot.ts'
export { isWorkflowLaneDisabled } from './WorkflowTriggerRoot.ts'
import { workflowStepBehavior } from './workflowStepEditing.ts'
import { isWorkflowActionChoiceSelected, workflowActionChoiceGroup, workflowActionChoiceStep } from './workflowActionChoices.ts'

type Label = (behavior: Behavior) => string
const directions = { up: 'Up', down: 'Down', left: 'Left', right: 'Right' } as const
const presetKeys: Record<string, string> = {
  escape: 'Esc', enter: 'Enter', customKey: 'Enter', space: 'Space', tab: 'Tab', backspace: 'Backspace', delete: 'Delete',
  rightCtrl: 'RCtrl', rightAlt: 'RAlt', rightCommand: 'RWin', keyHome: 'Home', keyEnd: 'End',
  pageUp: 'PageUp', pageDown: 'PageDown', arrowUp: 'Up', arrowDown: 'Down', arrowLeft: 'Left', arrowRight: 'Right',
  volumeUp: 'VolumeUp', volumeDown: 'VolumeDown', volumeMute: 'VolumeMute', mediaPlayPause: 'MediaPlayPause',
  mediaPrevious: 'MediaPrevious', mediaNext: 'MediaNext', mediaStop: 'MediaStop',
}

export function behaviorToWorkflowStep(behavior: Behavior, label: Label): Step {
  let type: string = behavior.type
  if (behavior.type === 'key' || behavior.type === 'shortcut') type = 'customKey'
  if (behavior.type === 'wheel') type = `wheel${directions[behavior.direction]}`
  if (behavior.type === 'cursorMove') type = `cursor${directions[behavior.direction]}`
  if (behavior.type === 'mouse') type = `mouse${behavior.button[0].toUpperCase()}${behavior.button.slice(1)}`
  const choice = workflowActionChoiceGroup(behavior)?.options.find((option) => isWorkflowActionChoiceSelected(behavior, option))
  if (choice) type = choice.stepType
  const { id, type: behaviorType, ...properties } = behavior
  return {
    id, componentType: 'task', type, name: `${behavior.enabled ? '' : '已停用 · '}${label(behavior)}`,
    properties: { ...properties, ...(behavior.type === 'shortcut' ? { keys: [...behavior.keys] } : {}), behaviorType },
  }
}

export function workflowBranches(definition: Definition) {
  return (definition.sequence[0] as BranchedStep).branches
}

export function clearWorkflowLane(definition: Definition, trigger: TriggerType) {
  const branch = workflowBranches(definition)[trigger]
  if (branch.length === 0) return false
  branch.splice(0, branch.length)
  return true
}

export function behaviorsToWorkflow(sequences: TriggerBehaviors, label: Label): Definition {
  const definition = createTriggerDefinition()
  const branches = workflowBranches(definition)
  for (const trigger of triggerTypes) branches[trigger] = sequences[trigger].map((behavior) => behaviorToWorkflowStep(behavior, label))
  return definition
}

// A new incomplete action is local to the designer until its dialog is confirmed.
export function workflowToBehaviors(definition: Definition): TriggerBehaviors | null {
  const branches = workflowBranches(definition)
  const result: TriggerBehaviors = { click: [], doubleClick: [], longPress: [] }
  for (const trigger of triggerTypes) {
    for (const step of branches[trigger]) {
      if (step.properties.draftGroup) continue
      const behavior = normalizeBehavior(workflowStepBehavior(step))
      if (!behavior) return null
      result[trigger].push(behavior)
    }
  }
  return result
}

export function insertedWorkflowSteps(step: Step, platform: Platform, label: Label): Step[] {
  // Duplicates already contain canonical behavior fields and keep their parameters.
  if (step.properties.behaviorType) return [step]
  if (step.type === 'savedSequence') {
    const behaviors = parseSequenceImport(step.properties.sequence)
    return behaviors?.map((behavior, index) => behaviorToWorkflowStep({ ...behavior, id: index === 0 ? step.id : behavior.id }, label)) ?? []
  }
  const preset = step.type
  const choices = workflowActionChoiceStep(preset)
  if (choices?.preset === preset) return [{ ...step, properties: {
    ...step.properties, behaviorType: choices.options[0].behavior.type, enabled: true, choice: choices.options[0].stepType, draftGroup: step.id,
  } }]
  if (preset === 'wheel' || preset === 'cursorMove') return [{ ...step, properties: {
    ...step.properties, behaviorType: preset, enabled: true, direction: 'up', draftGroup: step.id,
    ...(preset === 'cursorMove' ? { distance: defaultCursorDistance } : {}),
  } }]
  let behaviors: Behavior[]
  if (presetKeys[preset]) behaviors = [createBehavior({ type: 'key', key: presetKeys[preset], id: step.id })]
  else if (preset === 'previousTab' || preset === 'nextTab') behaviors = [createBehavior({ type: 'shortcut', keys: preset === 'previousTab' ? ['Ctrl', 'Shift', 'Tab'] : ['Ctrl', 'Tab'], id: step.id })]
  else if (preset === 'deleteAllText') {
    const modifier = platform === 'macos' ? 'Win' : 'Ctrl'
    behaviors = [createBehavior({ type: 'shortcut', keys: [modifier, 'A'], id: step.id }), createBehavior({ type: 'delay', ms: 30 }), createBehavior({ type: 'shortcut', keys: [modifier, 'X'] })]
  } else if (preset === 'textAndEnter') {
    behaviors = [createBehavior({ type: 'paste', text: '', id: step.id }), createBehavior({ type: 'delay', ms: 30 }), createBehavior({ type: 'key', key: 'Enter' })]
  } else {
    const behavior = workflowStepBehavior(step)
    if (!behavior) throw new Error(`Unsupported workflow action: ${preset}`)
    behaviors = [behavior]
  }
  const steps = behaviors.map((behavior) => behaviorToWorkflowStep(behavior, label))
  if (['paste', 'openApp', 'openWebsite', 'textAndEnter'].includes(preset)) {
    for (const node of steps) node.properties.draftGroup = step.id
  }
  return steps
}

export function updateWorkflowInput(current: BehaviorMap, inputId: InputId, sequences: TriggerBehaviors): BehaviorMap {
  if (workflowSequenceSignature(current[inputId]) === workflowSequenceSignature(sequences)) return current
  const copy = Object.fromEntries(triggerTypes.map((trigger) => [trigger, sequences[trigger].map((behavior) =>
    behavior.type === 'shortcut' ? { ...behavior, keys: [...behavior.keys] } : { ...behavior })])) as TriggerBehaviors
  return { ...current, [inputId]: copy }
}

export function workflowSequenceSignature(sequences: TriggerBehaviors) {
  // Stored/imported objects may use different property orders for the same action.
  return JSON.stringify(triggerTypes.map((trigger) => sequences[trigger].map((behavior) => normalizeBehavior(behavior))))
}
