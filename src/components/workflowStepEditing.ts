import type { BranchedStep, Definition, Step } from 'sequential-workflow-designer'
import type { Behavior, CursorDirection, MouseBehavior } from '../behaviorModel.ts'
import { defaultCursorDistance, maxCursorDistance, normalizeApplicationPath, normalizeWebsiteUrl, triggerTypes } from '../behaviorModel.ts'
import { isWorkflowActionChoiceSelected, workflowActionChoiceStep } from './workflowActionChoices.ts'

export const defaultWorkflowDelayMs = 300
const directionSuffixes: Record<string, CursorDirection> = { Up: 'up', Down: 'down', Left: 'left', Right: 'right' }
const mouseButtons: Record<string, MouseBehavior['button']> = { mouseLeft: 'left', mouseRight: 'right', mouseBack: 'back', mouseForward: 'forward' }

export function isEditableWorkflowStep(step: Step) {
  return ['delay', 'paste', 'customKey', 'openApp', 'openWebsite'].includes(step.type) || step.type.startsWith('cursor') || step.type.startsWith('wheel') || Boolean(workflowActionChoiceStep(step.type))
}

export function workflowStepBehavior(step: Step): Behavior | null {
  const base = { id: step.id, enabled: step.properties.enabled !== false }
  const choices = workflowActionChoiceStep(step.type)
  if (choices) {
    const option = choices.preset === step.type
      ? choices.options.find((option) => option.stepType === step.properties.choice) ?? choices.options[0]
      : choices.options.find((option) => option.stepType === step.type)!
    return { ...base, ...option.behavior }
  }
  const { text, path, url, key, keys, ms } = step.properties
  const direction = directionSuffixes[step.type.replace(/^(wheel|cursor)/, '')]
  if (direction && step.type.startsWith('wheel')) return { ...base, type: 'wheel', direction }
  if (direction && step.type.startsWith('cursor')) return { ...base, type: 'cursorMove', direction, distance: typeof step.properties.distance === 'number' ? step.properties.distance : defaultCursorDistance }
  const mouseButton = mouseButtons[step.type]
  if (mouseButton) return { ...base, type: 'mouse', button: mouseButton }
  switch (step.type) {
    case 'cursorMove': return { ...base, type: 'cursorMove', direction: ['up', 'down', 'left', 'right'].includes(String(step.properties.direction)) ? step.properties.direction as CursorDirection : 'up', distance: typeof step.properties.distance === 'number' ? step.properties.distance : defaultCursorDistance }
    case 'wheel': return { ...base, type: 'wheel', direction: ['up', 'down', 'left', 'right'].includes(String(step.properties.direction)) ? step.properties.direction as CursorDirection : 'up' }
    case 'disabled': return { ...base, type: 'disabled' }
    case 'delay': return { ...base, type: 'delay', ms: typeof ms === 'number' && Number.isInteger(ms) && ms >= 0 && ms <= 300000 ? ms : defaultWorkflowDelayMs }
    case 'paste': return { ...base, type: 'paste', text: typeof text === 'string' ? text : '' }
    case 'openApp': return { ...base, type: 'openApp', path: typeof path === 'string' ? path : '' }
    case 'openWebsite': return { ...base, type: 'openWebsite', url: typeof url === 'string' ? url : '' }
    case 'customKey': return typeof key === 'string' && key
      ? { ...base, type: 'key', key }
      : { ...base, type: 'shortcut', keys: Array.isArray(keys) ? keys.filter((key): key is string => typeof key === 'string') : [] }
    default: return null
  }
}

export function findWorkflowStepEditor(definition: Definition, stepId: string) {
  const root = definition.sequence.find((step) => step.type === 'axonkeyTriggers') as BranchedStep | undefined
  if (!root) return null
  for (const trigger of triggerTypes) {
    const step = root.branches[trigger]?.find((step) => step.id === stepId)
    if (!step) continue
    const behavior = workflowStepBehavior(step)
    return behavior ? { step, trigger, behavior } : null
  }
  return null
}

// Keep the toolbox preset stable when a custom-key node changes between a key and a shortcut.
export function workflowBehaviorProperties(step: Step, behavior: Behavior) {
  const properties = { ...step.properties }
  const choices = workflowActionChoiceStep(step.type)
  if (choices) {
    const option = choices.options.find((option) => isWorkflowActionChoiceSelected(behavior, option))
    return option ? { ...properties, choice: option.stepType } : null
  }
  if (step.type.startsWith('wheel') && behavior.type === 'wheel' && ['up', 'down', 'left', 'right'].includes(behavior.direction)) {
    return { ...properties, direction: behavior.direction }
  }
  if (step.type === 'delay' && behavior.type === 'delay' && Number.isInteger(behavior.ms) && behavior.ms >= 0 && behavior.ms <= 300000) {
    return { ...properties, ms: behavior.ms }
  }
  if (step.type === 'paste' && behavior.type === 'paste' && behavior.text.trim()) {
    return { ...properties, text: behavior.text }
  }
  if (step.type === 'openApp' && behavior.type === 'openApp') {
    const path = normalizeApplicationPath(behavior.path)
    return path ? { ...properties, path } : null
  }
  if (step.type === 'openWebsite' && behavior.type === 'openWebsite') {
    const url = normalizeWebsiteUrl(behavior.url)
    return url ? { ...properties, url } : null
  }
  if (step.type === 'customKey') {
    if (behavior.type === 'key' && behavior.key) return { ...properties, key: behavior.key, keys: [] }
    if (behavior.type === 'shortcut' && behavior.keys.length > 0) return { ...properties, key: '', keys: [...behavior.keys] }
  }
  if (step.type.startsWith('cursor') && behavior.type === 'cursorMove' && ['up', 'down', 'left', 'right'].includes(behavior.direction) && Number.isInteger(behavior.distance) && behavior.distance >= 1 && behavior.distance <= maxCursorDistance) {
    return { ...properties, direction: behavior.direction, distance: behavior.distance }
  }
  return null
}
