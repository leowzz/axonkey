import type { BranchedStep, Definition, Step } from 'sequential-workflow-designer'
import type { Behavior, CursorDirection, MouseBehavior } from '../behaviorModel.ts'
import {
  defaultCursorDistance,
  maxCursorDistance,
  normalizeApplicationPath,
  normalizeBehaviorTitle,
  normalizeFilePath,
  normalizeHttpBody,
  normalizeHttpHeaders,
  normalizeHttpMethod,
  normalizeShellCommand,
  normalizeWebsiteUrl,
  triggerTypes,
} from '../behaviorModel.ts'
import { isWorkflowActionChoiceSelected, workflowActionChoiceStep } from './workflowActionChoices.ts'

export const defaultWorkflowDelayMs = 300
const directionSuffixes: Record<string, CursorDirection> = { Up: 'up', Down: 'down', Left: 'left', Right: 'right' }
const mouseButtons: Record<string, MouseBehavior['button']> = {
  mouseLeft: 'left',
  mouseRight: 'right',
  mouseBack: 'back',
  mouseForward: 'forward',
}

export function isEditableWorkflowStep(step: Step) {
  return (
    [
      'delay',
      'paste',
      'typeText',
      'copyText',
      'openPath',
      'customKey',
      'openApp',
      'openWebsite',
      'runCommand',
      'httpRequest',
      'switchProfile',
      'quickOverlay',
    ].includes(step.type) ||
    step.type.startsWith('cursor') ||
    step.type.startsWith('wheel') ||
    Boolean(workflowActionChoiceStep(step.type))
  )
}

export function workflowStepBehavior(step: Step): Behavior | null {
  const base = {
    id: step.id,
    enabled: step.properties.enabled !== false,
    ...(typeof step.properties.libraryItemId === 'string' ? { libraryItemId: step.properties.libraryItemId } : {}),
  }
  const choices = workflowActionChoiceStep(step.type)
  if (choices) {
    const option =
      choices.preset === step.type
        ? (choices.options.find(option => option.stepType === step.properties.choice) ?? choices.options[0])
        : choices.options.find(option => option.stepType === step.type)!
    return { ...base, ...option.behavior }
  }
  const { text, path, url, key, keys, ms } = step.properties
  const direction = directionSuffixes[step.type.replace(/^(wheel|cursor)/, '')]
  if (direction && step.type.startsWith('wheel')) return { ...base, type: 'wheel', direction }
  if (direction && step.type.startsWith('cursor'))
    return {
      ...base,
      type: 'cursorMove',
      direction,
      distance: typeof step.properties.distance === 'number' ? step.properties.distance : defaultCursorDistance,
    }
  const mouseButton = mouseButtons[step.type]
  if (mouseButton) return { ...base, type: 'mouse', button: mouseButton }
  switch (step.type) {
    case 'cursorMove':
      return {
        ...base,
        type: 'cursorMove',
        direction: ['up', 'down', 'left', 'right'].includes(String(step.properties.direction))
          ? (step.properties.direction as CursorDirection)
          : 'up',
        distance: typeof step.properties.distance === 'number' ? step.properties.distance : defaultCursorDistance,
      }
    case 'wheel':
      return {
        ...base,
        type: 'wheel',
        direction: ['up', 'down', 'left', 'right'].includes(String(step.properties.direction))
          ? (step.properties.direction as CursorDirection)
          : 'up',
      }
    case 'switchProfile':
      return {
        ...base,
        type: 'switchProfile',
        direction: step.properties.direction === 'previous' ? 'previous' : 'next',
        wrap: step.properties.wrap !== false,
      }
    case 'quickOverlay':
      return {
        ...base,
        type: 'quickOverlay',
        profileId: typeof step.properties.profileId === 'string' ? step.properties.profileId.trim() : '',
      }
    case 'disabled':
      return { ...base, type: 'disabled' }
    case 'delay':
      return {
        ...base,
        type: 'delay',
        ms: typeof ms === 'number' && Number.isInteger(ms) && ms >= 0 && ms <= 300000 ? ms : defaultWorkflowDelayMs,
      }
    case 'typeText':
    case 'paste':
    case 'copyText': {
      const title = normalizeBehaviorTitle(step.properties.title)
      return { ...base, type: step.type, text: typeof text === 'string' ? text : '', ...(title ? { title } : {}) }
    }
    case 'openPath':
      return { ...base, type: 'openPath', path: typeof path === 'string' ? path : '' }
    case 'openApp':
      return { ...base, type: 'openApp', path: typeof path === 'string' ? path : '' }
    case 'openWebsite':
      return { ...base, type: 'openWebsite', url: typeof url === 'string' ? url : '' }
    case 'runCommand': {
      const workingDirectory =
        typeof step.properties.workingDirectory === 'string' ? step.properties.workingDirectory : undefined
      const title = normalizeBehaviorTitle(step.properties.title)
      return {
        ...base,
        type: 'runCommand',
        command: typeof step.properties.command === 'string' ? step.properties.command : '',
        ...(workingDirectory ? { workingDirectory } : {}),
        ...(title ? { title } : {}),
      }
    }
    case 'httpRequest': {
      const method = normalizeHttpMethod(step.properties.method) ?? 'POST'
      const headers = normalizeHttpHeaders(step.properties.headers)
      const body = normalizeHttpBody(step.properties.body)
      const title = normalizeBehaviorTitle(step.properties.title)
      return {
        ...base,
        type: 'httpRequest',
        method,
        url: typeof url === 'string' ? url : '',
        ...(headers ? { headers } : {}),
        ...(body ? { body } : {}),
        ...(title ? { title } : {}),
      }
    }
    case 'customKey':
      return typeof key === 'string' && key
        ? { ...base, type: 'key', key }
        : {
            ...base,
            type: 'shortcut',
            keys: Array.isArray(keys) ? keys.filter((key): key is string => typeof key === 'string') : [],
          }
    default:
      return null
  }
}

export function findWorkflowStepEditor(definition: Definition, stepId: string) {
  const root = definition.sequence.find(step => step.type === 'axonkeyTriggers') as BranchedStep | undefined
  if (!root) return null
  for (const trigger of triggerTypes) {
    const step = root.branches[trigger]?.find(step => step.id === stepId)
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
    const option = choices.options.find(option => isWorkflowActionChoiceSelected(behavior, option))
    return option ? { ...properties, choice: option.stepType } : null
  }
  if (
    step.type.startsWith('wheel') &&
    behavior.type === 'wheel' &&
    ['up', 'down', 'left', 'right'].includes(behavior.direction)
  ) {
    return { ...properties, direction: behavior.direction }
  }
  if (
    step.type === 'delay' &&
    behavior.type === 'delay' &&
    Number.isInteger(behavior.ms) &&
    behavior.ms >= 0 &&
    behavior.ms <= 300000
  ) {
    return { ...properties, ms: behavior.ms }
  }
  if (
    (step.type === 'paste' || step.type === 'typeText' || step.type === 'copyText') &&
    (behavior.type === 'paste' || behavior.type === 'typeText' || behavior.type === 'copyText') &&
    step.type === behavior.type &&
    behavior.text.trim()
  ) {
    const title = normalizeBehaviorTitle(behavior.title)
    const rest: Record<string, unknown> = { ...properties }
    delete rest.title
    return { ...rest, text: behavior.text, ...(title ? { title } : {}) }
  }
  if (step.type === 'switchProfile' && behavior.type === 'switchProfile') {
    return { ...properties, direction: behavior.direction, wrap: behavior.wrap }
  }
  if (step.type === 'quickOverlay' && behavior.type === 'quickOverlay') {
    const profileId = behavior.profileId.trim()
    return profileId ? { ...properties, profileId } : null
  }
  if (step.type === 'openPath' && behavior.type === 'openPath') {
    const path = normalizeFilePath(behavior.path)
    return path ? { ...properties, path } : null
  }
  if (step.type === 'openApp' && behavior.type === 'openApp') {
    const path = normalizeApplicationPath(behavior.path)
    return path ? { ...properties, path } : null
  }
  if (step.type === 'openWebsite' && behavior.type === 'openWebsite') {
    const url = normalizeWebsiteUrl(behavior.url)
    return url ? { ...properties, url } : null
  }
  if (step.type === 'runCommand' && behavior.type === 'runCommand') {
    const command = normalizeShellCommand(behavior.command)
    if (!command) return null
    const rawDir = behavior.workingDirectory?.trim()
    const workingDirectory = rawDir ? normalizeFilePath(rawDir) : undefined
    if (rawDir && !workingDirectory) return null
    const title = normalizeBehaviorTitle(behavior.title)
    const rest: Record<string, unknown> = { ...properties }
    delete rest.workingDirectory
    delete rest.title
    return { ...rest, command, ...(workingDirectory ? { workingDirectory } : {}), ...(title ? { title } : {}) }
  }
  if (step.type === 'httpRequest' && behavior.type === 'httpRequest') {
    const method = normalizeHttpMethod(behavior.method)
    const url = normalizeWebsiteUrl(behavior.url)
    const headers = normalizeHttpHeaders(behavior.headers)
    const body = normalizeHttpBody(behavior.body)
    if (!method || !url || headers === null || body === null) return null
    const title = normalizeBehaviorTitle(behavior.title)
    const rest: Record<string, unknown> = { ...properties }
    delete rest.headers
    delete rest.body
    delete rest.title
    return {
      ...rest,
      method,
      url,
      ...(headers ? { headers } : {}),
      ...(body ? { body } : {}),
      ...(title ? { title } : {}),
    }
  }
  if (step.type === 'customKey') {
    if (behavior.type === 'key' && behavior.key) return { ...properties, key: behavior.key, keys: [] }
    if (behavior.type === 'shortcut' && behavior.keys.length > 0)
      return { ...properties, key: '', keys: [...behavior.keys] }
  }
  if (
    step.type.startsWith('cursor') &&
    behavior.type === 'cursorMove' &&
    ['up', 'down', 'left', 'right'].includes(behavior.direction) &&
    Number.isInteger(behavior.distance) &&
    behavior.distance >= 1 &&
    behavior.distance <= maxCursorDistance
  ) {
    return { ...properties, direction: behavior.direction, distance: behavior.distance }
  }
  return null
}
