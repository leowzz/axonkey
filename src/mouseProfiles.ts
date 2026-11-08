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
