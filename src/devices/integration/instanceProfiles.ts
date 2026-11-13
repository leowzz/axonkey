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
    profiles: instance.profiles.map(p => ({
      ...p,
      behaviors: {
        ...p.behaviors,
        [inputId]: { ...(p.behaviors[inputId] ?? empty()), [trigger]: [{ ...behavior, id: crypto.randomUUID() }] },
      },
    })),
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
      const updated = { ...(p.behaviors[inputId] ?? empty()) }
      for (const trigger of triggers) updated[trigger] = updated[trigger].filter(b => b.type !== 'switchProfile')
      return { ...p, behaviors: { ...p.behaviors, [inputId]: updated } }
    }),
  }
}

export function addInstanceProfile(instance: DeviceInstance, duplicate: boolean, appId?: string): DeviceInstance {
  const applicationProfile = instance.applicationProfiles?.find(binding => binding.application.id === appId)
  const active = instance.profiles.find(p => p.id === (applicationProfile?.profileId ?? instance.activeProfileId))!
  const id = crypto.randomUUID()
  const behaviors = structuredClone(active.behaviors)
  if (!duplicate)
    for (const triggers of Object.values(behaviors)) {
      for (const trigger of ['click', 'doubleClick', 'longPress'] as const)
        triggers[trigger] = triggers[trigger].filter(b => b.type === 'switchProfile')
    }
  const next = {
    ...instance,
    activeProfileId: id,
    profiles: [
      ...instance.profiles,
      { id, name: duplicate ? `${active.name} 副本` : `配置 ${instance.profiles.length + 1}`, behaviors },
    ],
  }
  return applicationProfile
    ? setApplicationProfile({ ...next, activeProfileId: instance.activeProfileId }, applicationProfile.application, id)
    : next
}

export function addApplicationForEditing(instance: DeviceInstance, application: Application): DeviceInstance {
  if (instance.applicationProfiles?.some(binding => binding.application.id === application.id)) return instance
  const next = addInstanceProfile(instance, true)
  next.profiles[next.profiles.length - 1].name = `${application.name} 配置`.slice(0, 40)
  return setApplicationProfile(
    { ...next, activeProfileId: instance.activeProfileId },
    application,
    next.activeProfileId,
  )
}

export function deleteInstanceProfile(instance: DeviceInstance, profileId: string): DeviceInstance {
  if (instance.profiles.length <= 1) return instance
  const profiles = instance.profiles.filter(profile => profile.id !== profileId)
  const fallbackProfileId = instance.activeProfileId === profileId ? profiles[0].id : instance.activeProfileId
  return {
    ...instance,
    profiles,
    activeProfileId: fallbackProfileId,
    applicationProfiles: instance.applicationProfiles?.map(binding =>
      binding.profileId === profileId ? { ...binding, profileId: fallbackProfileId } : binding,
    ),
  }
}
