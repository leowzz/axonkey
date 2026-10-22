import { cloneBehaviorMap, createBehavior, triggerTypes } from './behaviorModel.ts'
import type { BehaviorMap, InputId, TriggerBehaviors, TriggerType, SwitchProfileBehavior, ProfileDirection } from './behaviorModel.ts'
import type { MappingProfile } from './appTypes.ts'

export type ProfileSwitchRequest = { direction: ProfileDirection; wrap: boolean }

export function adjacentProfileId(profiles: readonly { id: string }[], activeId: string, request: ProfileSwitchRequest): string | null {
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

export type ProfileState = { profiles: MappingProfile[]; activeProfileId: string; behaviors: BehaviorMap }

export function changeProfileState(current: ProfileState, id: string): ProfileState | null {
  const target = current.profiles.find(profile => profile.id === id)
  if (!target || id === current.activeProfileId) return null
  return {
    profiles: current.profiles.map(profile => profile.id === current.activeProfileId ? { ...profile, behaviors: cloneBehaviorMap(current.behaviors) } : profile),
    activeProfileId: id,
    behaviors: cloneBehaviorMap(target.behaviors),
  }
}

export function profileSwitchTargets(current: ProfileState, inputId: InputId, trigger: TriggerType) {
  return current.profiles.map(profile => ({
    id: profile.id, name: profile.name,
    behaviors: (profile.id === current.activeProfileId ? current.behaviors : profile.behaviors)[inputId][trigger],
  }))
}

export function applySharedProfileSwitch(current: ProfileState, inputId: InputId, trigger: TriggerType, behavior: SwitchProfileBehavior): ProfileState {
  const profiles = current.profiles.map(profile => {
    const behaviors = cloneBehaviorMap(profile.id === current.activeProfileId ? current.behaviors : profile.behaviors)
    behaviors[inputId][trigger] = [createBehavior({ ...behavior, id: undefined })]
    return { ...profile, behaviors }
  })
  return { profiles, activeProfileId: current.activeProfileId, behaviors: cloneBehaviorMap(profiles.find(profile => profile.id === current.activeProfileId)!.behaviors) }
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
  const profiles = current.profiles.map(profile => {
    const source = profile.id === current.activeProfileId ? current.behaviors : profile.behaviors
    const behaviors = cloneBehaviorMap(profile.id === deletion.profileId ? { ...source, [deletion.inputId]: deletion.sequences } : source)
    for (const trigger of deletion.triggers) {
      behaviors[deletion.inputId][trigger] = behaviors[deletion.inputId][trigger].filter(behavior => behavior.type !== 'switchProfile')
    }
    return { ...profile, behaviors }
  })
  return { profiles, activeProfileId: current.activeProfileId, behaviors: cloneBehaviorMap(profiles.find(profile => profile.id === current.activeProfileId)!.behaviors) }
}
