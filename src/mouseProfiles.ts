import type { MappingProfile } from './appTypes'

export function mouseApplicationProfile(profiles: readonly MappingProfile[], applicationId: string | undefined) {
  return applicationId
    ? profiles.find(profile => profile.deviceId === 'mouse' && profile.applicationIds?.includes(applicationId))
    : undefined
}

export function effectiveMouseProfileId(
  profiles: readonly MappingProfile[],
  globalProfileId: string,
  switching: boolean,
  applicationId: string | undefined,
): string {
  return (switching && mouseApplicationProfile(profiles, applicationId)?.id) || globalProfileId
}

export function bindMouseApplication(
  profiles: readonly MappingProfile[],
  applicationId: string,
  profileId: string | null,
): MappingProfile[] {
  return profiles.map(profile => {
    if (profile.deviceId !== 'mouse') return profile
    const applicationIds = (profile.applicationIds ?? []).filter(id => id !== applicationId)
    return {
      ...profile,
      applicationIds: profile.id === profileId ? [...applicationIds, applicationId] : applicationIds,
    }
  })
}

export function addMouseApplicationForEditing(
  profiles: readonly MappingProfile[],
  applicationId: string,
  globalProfileId: string,
  autoSwitching: boolean,
): { profiles: MappingProfile[]; profileId: string; autoSwitching: boolean } {
  const existing = mouseApplicationProfile(profiles, applicationId)
  if (existing) return { profiles: [...profiles], profileId: existing.id, autoSwitching }
  const hadBindings = profiles.some(
    profile => profile.deviceId === 'mouse' && (profile.applicationIds?.length ?? 0) > 0,
  )
  return {
    profiles: bindMouseApplication(profiles, applicationId, globalProfileId),
    profileId: globalProfileId,
    autoSwitching: hadBindings ? autoSwitching : true,
  }
}

export function deleteMouseProfile(
  profiles: readonly MappingProfile[],
  profileId: string,
  globalProfileId: string,
): { profiles: MappingProfile[]; globalProfileId: string } {
  const removed = profiles.find(profile => profile.deviceId === 'mouse' && profile.id === profileId)
  if (!removed) return { profiles: [...profiles], globalProfileId }

  const remaining = profiles.filter(profile => profile.id !== profileId)
  const remainingMouseRegular = remaining.filter(profile => profile.deviceId === 'mouse' && !profile.quick)
  if (!remainingMouseRegular.length) return { profiles: [...profiles], globalProfileId }

  const nextGlobalProfileId =
    profileId === globalProfileId && !remainingMouseRegular.some(profile => profile.id === globalProfileId)
      ? remainingMouseRegular[0].id
      : globalProfileId
  let nextProfiles = remaining
  for (const applicationId of removed.applicationIds ?? [])
    nextProfiles = bindMouseApplication(nextProfiles, applicationId, nextGlobalProfileId)
  return { profiles: nextProfiles, globalProfileId: nextGlobalProfileId }
}
