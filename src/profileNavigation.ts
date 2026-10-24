import { cloneBehaviorMap, createBehavior, triggerTypes } from './behaviorModel.ts'
import type { BehaviorMap, InputId, TriggerBehaviors, TriggerType, SwitchProfileBehavior, ProfileDirection } from './behaviorModel.ts'
import type { MappingProfile } from './appTypes.ts'
import { deviceForInput } from './deviceModel.ts'
import type { DeviceId } from './deviceModel.ts'
import { composeActiveProfileBehaviors, mergeDeviceBehaviors, snapshotDeviceProfiles } from './deviceProfiles.ts'

export type ProfileSwitchRequest = { deviceId: DeviceId; direction: ProfileDirection; wrap: boolean }

export function adjacentProfileId(profiles: readonly { id: string }[], activeId: string, request: Pick<ProfileSwitchRequest, 'direction' | 'wrap'>): string | null {
  if (request.direction !== 'previous' && request.direction !== 'next') return null
  const index = profiles.findIndex(profile => profile.id === activeId)
  if (index < 0 || profiles.length < 2) return null
  let next = index + (request.direction === 'previous' ? -1 : 1)
  if (next < 0 || next >= profiles.length) {
    if (!request.wrap) return null
    next = (next + profiles.length) % profiles.length
  }
  return profiles[next].id
}

export type ProfileState = { profiles: MappingProfile[]; activeProfileIds: Record<DeviceId, string>; behaviors: BehaviorMap }

export function changeProfileState(current: ProfileState, id: string): ProfileState | null {
  const target = current.profiles.find(profile => profile.id === id)
  if (!target || id === current.activeProfileIds[target.deviceId]) return null
  return {
    profiles: snapshotDeviceProfiles(current.profiles, current.activeProfileIds, current.behaviors),
    activeProfileIds: { ...current.activeProfileIds, [target.deviceId]: id },
    behaviors: mergeDeviceBehaviors(current.behaviors, target.deviceId, target.behaviors),
  }
}

export function profileSwitchTargets(current: ProfileState, inputId: InputId, trigger: TriggerType) {
  const deviceId = deviceForInput(inputId).id
  return current.profiles.filter(profile => profile.deviceId === deviceId).map(profile => ({
    id: profile.id, name: profile.name,
    behaviors: (profile.id === current.activeProfileIds[deviceId] ? current.behaviors : profile.behaviors)[inputId][trigger],
  }))
}

export function applySharedProfileSwitch(current: ProfileState, inputId: InputId, trigger: TriggerType, behavior: SwitchProfileBehavior): ProfileState {
  const deviceId = deviceForInput(inputId).id
  const profiles = snapshotDeviceProfiles(current.profiles, current.activeProfileIds, current.behaviors).map(profile => {
    if (profile.deviceId !== deviceId) return profile
    const behaviors = profile.behaviors
    behaviors[inputId][trigger] = [createBehavior({ ...behavior, id: undefined })]
    return { ...profile, behaviors }
  })
  return { profiles, activeProfileIds: { ...current.activeProfileIds }, behaviors: composeActiveProfileBehaviors(profiles, current.activeProfileIds) }
}

export function removedProfileSwitchTriggers(before: TriggerBehaviors, after: TriggerBehaviors): TriggerType[] {
  return triggerTypes.filter(trigger => before[trigger].some(behavior => behavior.type === 'switchProfile'
    && !after[trigger].some(next => next.type === 'switchProfile' && next.id === behavior.id)))
}

export type ProfileSwitchDeletion = {
  profileId: string
  inputId: InputId
  triggers: TriggerType[]
  sequences: TriggerBehaviors
}

export function removeSharedProfileSwitch(current: ProfileState, deletion: ProfileSwitchDeletion): ProfileState {
  const deviceId = deviceForInput(deletion.inputId).id
  if (!current.profiles.some(profile => profile.id === deletion.profileId && profile.deviceId === deviceId)) return current
  const profiles = snapshotDeviceProfiles(current.profiles, current.activeProfileIds, current.behaviors).map(profile => {
    if (profile.deviceId !== deviceId) return profile
    const source = profile.behaviors
    const behaviors = cloneBehaviorMap(profile.id === deletion.profileId ? { ...source, [deletion.inputId]: deletion.sequences } : source)
    for (const trigger of deletion.triggers) {
      behaviors[deletion.inputId][trigger] = behaviors[deletion.inputId][trigger].filter(behavior => behavior.type !== 'switchProfile')
    }
    return { ...profile, behaviors }
  })
  return { profiles, activeProfileIds: { ...current.activeProfileIds }, behaviors: composeActiveProfileBehaviors(profiles, current.activeProfileIds) }
}
