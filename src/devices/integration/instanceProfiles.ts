import type { DeviceInstance } from './model'
import type { SwitchProfileBehavior, TriggerBehaviors, TriggerType } from '../../behaviorModel'

const empty = (): TriggerBehaviors => ({ click: [], doubleClick: [], longPress: [] })

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

export function addInstanceProfile(instance: DeviceInstance, duplicate: boolean): DeviceInstance {
  const active = instance.profiles.find(p => p.id === instance.activeProfileId)!
  const id = crypto.randomUUID()
  const behaviors = structuredClone(active.behaviors)
  if (!duplicate)
    for (const triggers of Object.values(behaviors)) {
      for (const trigger of ['click', 'doubleClick', 'longPress'] as const)
        triggers[trigger] = triggers[trigger].filter(b => b.type === 'switchProfile')
    }
  return {
    ...instance,
    activeProfileId: id,
    profiles: [
      ...instance.profiles,
      { id, name: duplicate ? `${active.name} 副本` : `配置 ${instance.profiles.length + 1}`, behaviors },
    ],
  }
}
