import type { DeviceInstance } from './model'
import type { SwitchProfileBehavior, TriggerBehaviors, TriggerType } from '../../behaviorModel'
import { setApplicationProfile } from './applicationProfiles.ts'
import type { Application } from '../../applications'

export type InstanceProfileBehaviors = Record<string, TriggerBehaviors>

export type InstanceBehaviorHistory = {
  profileId: string
  past: InstanceProfileBehaviors[]
  present: InstanceProfileBehaviors
  future: InstanceProfileBehaviors[]
}

export type InstanceBehaviorHistoryAction =
  | { type: 'change'; inputId: string; sequences: TriggerBehaviors }
  | { type: 'replace'; profileId: string; present: InstanceProfileBehaviors }
  | { type: 'sync'; profileId: string; present: InstanceProfileBehaviors }
  | { type: 'undo' }
  | { type: 'redo' }

const historyLimit = 100
const empty = (): TriggerBehaviors => ({ click: [], doubleClick: [], longPress: [] })

function hasAnyBehavior(sequences: TriggerBehaviors | undefined): boolean {
  if (!sequences) return false
  return sequences.click.length > 0 || sequences.doubleClick.length > 0 || sequences.longPress.length > 0
}

function canonicalValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalValue)
  if (value && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, item]) => item !== undefined)
      .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
    return Object.fromEntries(entries.map(([key, item]) => [key, canonicalValue(item)]))
  }
  return value
}

function triggerBehaviorsSignature(sequences: TriggerBehaviors | undefined): string {
  return JSON.stringify(canonicalValue(sequences ?? empty()))
}

export function profileBehaviorsSignature(behaviors: InstanceProfileBehaviors): string {
  const entries = Object.entries(behaviors)
    .filter(([, sequences]) => hasAnyBehavior(sequences))
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
  return JSON.stringify(entries.map(([inputId, sequences]) => [inputId, canonicalValue(sequences)]))
}

export function createInstanceBehaviorHistory(
  profileId: string,
  present: InstanceProfileBehaviors,
): InstanceBehaviorHistory {
  return { profileId, past: [], present: structuredClone(present), future: [] }
}

export function instanceBehaviorHistoryReducer(
  state: InstanceBehaviorHistory,
  action: InstanceBehaviorHistoryAction,
): InstanceBehaviorHistory {
  switch (action.type) {
    case 'replace':
      return createInstanceBehaviorHistory(action.profileId, action.present)
    case 'sync':
      if (action.profileId !== state.profileId) {
        return createInstanceBehaviorHistory(action.profileId, action.present)
      }
      if (profileBehaviorsSignature(action.present) === profileBehaviorsSignature(state.present)) {
        return state
      }
      return createInstanceBehaviorHistory(action.profileId, action.present)
    case 'change':
      if (triggerBehaviorsSignature(state.present[action.inputId]) === triggerBehaviorsSignature(action.sequences)) {
        return state
      }
      return {
        profileId: state.profileId,
        past: [...state.past, state.present].slice(-historyLimit),
        present: { ...state.present, [action.inputId]: structuredClone(action.sequences) },
        future: [],
      }
    case 'undo': {
      const present = state.past[state.past.length - 1]
      if (!present) return state
      return {
        profileId: state.profileId,
        past: state.past.slice(0, -1),
        present,
        future: [state.present, ...state.future].slice(0, historyLimit),
      }
    }
    case 'redo': {
      const present = state.future[0]
      if (!present) return state
      return {
        profileId: state.profileId,
        past: [...state.past, state.present].slice(-historyLimit),
        present,
        future: state.future.slice(1),
      }
    }
  }
}

export function replaceInstanceProfileBehaviors(
  instance: DeviceInstance,
  profileId: string,
  behaviors: InstanceProfileBehaviors,
): DeviceInstance {
  return {
    ...instance,
    profiles: instance.profiles.map(p => (p.id === profileId ? { ...p, behaviors: structuredClone(behaviors) } : p)),
  }
}

export function mergeEditedProfileBehaviors(
  rawBehaviors: unknown,
  sanitizedInitial: InstanceProfileBehaviors,
  nextPresent: InstanceProfileBehaviors,
  droppedInputIds: ReadonlySet<string>,
  cleanedInputIds?: ReadonlySet<string>,
): InstanceProfileBehaviors {
  const merged: Record<string, unknown> = structuredClone(nextPresent)
  if (droppedInputIds.size === 0 || !rawBehaviors || typeof rawBehaviors !== 'object' || Array.isArray(rawBehaviors)) {
    return merged as InstanceProfileBehaviors
  }
  const rawRecord = rawBehaviors as Record<string, unknown>
  for (const inputId of droppedInputIds) {
    if (cleanedInputIds?.has(inputId)) continue
    if (triggerBehaviorsSignature(nextPresent[inputId]) === triggerBehaviorsSignature(sanitizedInitial[inputId])) {
      if (Object.prototype.hasOwnProperty.call(rawRecord, inputId)) {
        merged[inputId] = structuredClone(rawRecord[inputId])
      }
    }
  }
  return merged as InstanceProfileBehaviors
}

export function updateInstanceSequence(
  instance: DeviceInstance,
  profileId: string,
  inputId: string,
  sequences: TriggerBehaviors,
): DeviceInstance {
  return {
    ...instance,
    profiles: instance.profiles.map(p =>
      p.id === profileId ? { ...p, behaviors: { ...p.behaviors, [inputId]: structuredClone(sequences) } } : p,
    ),
  }
}

export function applyInstanceProfileSwitch(
  instance: DeviceInstance,
  inputId: string,
  trigger: TriggerType,
  behavior: SwitchProfileBehavior,
): DeviceInstance {
  return {
    ...instance,
    profiles: instance.profiles.map(p =>
      p.quick
        ? p
        : {
            ...p,
            behaviors: {
              ...p.behaviors,
              [inputId]: {
                ...(p.behaviors[inputId] ?? empty()),
                [trigger]: [{ ...behavior, id: crypto.randomUUID() }],
              },
            },
          },
    ),
  }
}

export function removeInstanceProfileSwitch(
  instance: DeviceInstance,
  profileId: string,
  inputId: string,
  triggers: TriggerType[],
  sequences: TriggerBehaviors,
): DeviceInstance {
  const next = updateInstanceSequence(instance, profileId, inputId, sequences)
  return {
    ...next,
    profiles: next.profiles.map(p => {
      if (p.quick && p.id !== profileId) return p
      const updated = { ...empty(), ...(p.behaviors[inputId] ?? {}) }
      for (const trigger of triggers) {
        updated[trigger] = Array.isArray(updated[trigger])
          ? updated[trigger].filter(b => b && typeof b === 'object' && b.type !== 'switchProfile')
          : []
      }
      return { ...p, behaviors: { ...p.behaviors, [inputId]: updated } }
    }),
  }
}

export function nextQuickProfileName(existingNames: readonly string[], preferred?: string): string {
  const names = new Set(existingNames)
  const clean = preferred
    ?.trim()
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .slice(0, 40)
  if (clean && !names.has(clean)) return clean
  const base = clean || '快捷配置'
  let index = clean ? 2 : 1
  while (names.has(`${base} ${index}`)) index += 1
  return `${base} ${index}`.slice(0, 40)
}

export function addQuickInstanceProfile(
  instance: DeviceInstance,
  preferredName?: string,
  duplicateFromId?: string,
): { instance: DeviceInstance; profileId: string } {
  const id = crypto.randomUUID()
  const source = duplicateFromId ? instance.profiles.find(p => p.id === duplicateFromId) : undefined
  const behaviors: InstanceProfileBehaviors = source ? structuredClone(source.behaviors) : {}
  if (source) {
    for (const triggers of Object.values(behaviors)) {
      if (!triggers || typeof triggers !== 'object') continue
      for (const trigger of ['click', 'doubleClick', 'longPress'] as const) {
        triggers[trigger] = Array.isArray(triggers[trigger])
          ? triggers[trigger].filter(b => b && typeof b === 'object' && b.type !== 'switchProfile')
          : []
      }
    }
  }
  const name = nextQuickProfileName(
    instance.profiles.map(p => p.name),
    preferredName ?? (source ? `${source.name} 副本` : undefined),
  )
  return {
    profileId: id,
    instance: {
      ...instance,
      profiles: [
        ...instance.profiles,
        {
          id,
          name,
          behaviors,
          quick: true,
          ...(source?.display ? { display: structuredClone(source.display) } : {}),
        },
      ],
    },
  }
}

export function addInstanceProfile(instance: DeviceInstance, duplicate: boolean, appId?: string): DeviceInstance {
  const applicationProfile = instance.applicationProfiles?.find(binding => binding.application.id === appId)
  const active = instance.profiles.find(p => p.id === (applicationProfile?.profileId ?? instance.activeProfileId))!
  const id = crypto.randomUUID()
  const behaviors = structuredClone(active.behaviors)
  if (!duplicate)
    for (const triggers of Object.values(behaviors)) {
      if (!triggers || typeof triggers !== 'object') continue
      for (const trigger of ['click', 'doubleClick', 'longPress'] as const)
        triggers[trigger] = Array.isArray(triggers[trigger])
          ? triggers[trigger].filter(b => b && typeof b === 'object' && b.type === 'switchProfile')
          : []
    }
  const next = {
    ...instance,
    activeProfileId: id,
    profiles: [
      ...instance.profiles,
      {
        id,
        name: duplicate ? `${active.name} 副本` : `配置 ${instance.profiles.length + 1}`,
        behaviors,
        ...(duplicate && active.display ? { display: structuredClone(active.display) } : {}),
      },
    ],
  }
  return applicationProfile
    ? setApplicationProfile({ ...next, activeProfileId: instance.activeProfileId }, applicationProfile.application, id)
    : next
}

export function addApplicationForEditing(instance: DeviceInstance, application: Application): DeviceInstance {
  if (instance.applicationProfiles?.some(binding => binding.application.id === application.id)) return instance
  return setApplicationProfile(instance, application, instance.activeProfileId)
}

export function deleteInstanceProfile(instance: DeviceInstance, profileId: string): DeviceInstance {
  const removed = instance.profiles.find(profile => profile.id === profileId)
  if (!removed) return instance
  const regularCount = instance.profiles.filter(profile => !profile.quick).length
  if (!removed.quick && regularCount <= 1) return instance
  const profiles = instance.profiles.filter(profile => profile.id !== profileId)
  const defaultRegular = profiles.find(profile => !profile.quick) ?? profiles[0]
  const fallbackProfileId = instance.activeProfileId === profileId ? defaultRegular.id : instance.activeProfileId
  return {
    ...instance,
    profiles,
    activeProfileId: fallbackProfileId,
    applicationProfiles: instance.applicationProfiles?.map(binding =>
      binding.profileId === profileId ? { ...binding, profileId: fallbackProfileId } : binding,
    ),
  }
}
