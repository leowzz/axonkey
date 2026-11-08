import type { DeviceInstance } from './model'
import type { SwitchProfileBehavior, TriggerBehaviors, TriggerType } from '../../behaviorModel'
import { setApplicationProfile } from './applicationProfiles.ts'
import type { Application } from '../../applications'

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
  const fallbackProfileId =
    instance.activeProfileId === profileId ? profiles[0].id : instance.activeProfileId
  return {
    ...instance,
    profiles,
    activeProfileId: fallbackProfileId,
    applicationProfiles: instance.applicationProfiles?.map(binding =>
      binding.profileId === profileId ? { ...binding, profileId: fallbackProfileId } : binding,
    ),
  }
}
