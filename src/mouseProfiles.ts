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

export function deleteMouseProfile(
  profiles: readonly MappingProfile[],
  profileId: string,
  globalProfileId: string,
): { profiles: MappingProfile[]; globalProfileId: string } {
  const removed = profiles.find(profile => profile.deviceId === 'mouse' && profile.id === profileId)
  if (!removed) return { profiles: [...profiles], globalProfileId }

  const remaining = profiles.filter(profile => profile.id !== profileId)
  const remainingMouseProfiles = remaining.filter(profile => profile.deviceId === 'mouse')
  if (!remainingMouseProfiles.length) return { profiles: [...profiles], globalProfileId }

  const nextGlobalProfileId =
    profileId === globalProfileId && !remainingMouseProfiles.some(profile => profile.id === globalProfileId)
      ? remainingMouseProfiles[0].id
      : globalProfileId
  let nextProfiles = remaining
  for (const applicationId of removed.applicationIds ?? [])
    nextProfiles = bindMouseApplication(nextProfiles, applicationId, nextGlobalProfileId)
  return { profiles: nextProfiles, globalProfileId: nextGlobalProfileId }
}
