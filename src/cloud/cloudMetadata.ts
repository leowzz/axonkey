import { appStorage } from '../appStorage.ts'
import { fingerprint } from './cloudSync.ts'
import type { CloudSnapshot, CloudSource, SourcePlatform } from './cloudSync.ts'

export type RestoreSource = {
  device_config_id: string
  profile_id: string
  revision: number
  source_platform: SourcePlatform
  source_computer_name: string | null
  app_version: string | null
}
export type ProfileMetadata = {
  content: string
  app_version: string | null
  restored_from: RestoreSource | null
  source_content?: string
  restored_content?: string
}
const metadataKey = 'axonkey.cloud-profile-metadata.v1'
const installationKey = 'axonkey.cloud-installation.v1'
type ProfileContent = {
  id: string
  name: string
  behaviors: unknown
  display?: { mode: 'auto' | 'custom'; line1: string; line2: string }
}
export function profileContent(profile: ProfileContent): string {
  return fingerprint({
    name: profile.name,
    behaviors: profile.behaviors,
    ...(profile.display === undefined ? {} : { display: profile.display }),
  })
}
export function readProfileMetadata(): Record<string, ProfileMetadata> {
  return JSON.parse(appStorage.getItem(metadataKey) ?? '{}')
}
export function saveProfileMetadata(value: Record<string, ProfileMetadata>) {
  const serialized = JSON.stringify(value)
  if (appStorage.getItem(metadataKey) !== serialized) appStorage.setItem(metadataKey, serialized)
}
export function profileMetadataKey(device: string, profile: string) {
  return `${device}/${profile}`
}
export function cloudSource(platform: SourcePlatform): CloudSource {
  let id = appStorage.getItem(installationKey)
  if (!id) {
    id = crypto.randomUUID()
    appStorage.setItem(installationKey, id)
  }
  return {
    source_platform: platform,
    source_installation_id: id,
    source_computer_name: appStorage.getItem('axonkey.cloud-computer-name.v1') || null,
  }
}
export function annotateSnapshot(
  snapshot: CloudSnapshot,
  source: CloudSource,
  appVersion: string,
  baseline = false,
): CloudSnapshot {
  const metadata = readProfileMetadata()
  const documents = snapshot.documents.map(document => ({
    ...document,
    key: `${source.source_installation_id}:${document.key}`,
    config: {
      ...document.config,
      profiles: (document.config.profiles as ProfileContent[]).map(profile => {
        const key = profileMetadataKey(document.key, profile.id)
        const previous = metadata[key]
        const content = profileContent(profile)
        const version = previous
          ? previous.content === content
            ? previous.app_version
            : appVersion
          : baseline
            ? null
            : appVersion
        const value = { ...previous, content, app_version: version, restored_from: previous?.restored_from ?? null }
        metadata[key] = value
        return { ...profile, app_version: value.app_version, restored_from: value.restored_from }
      }),
    },
  }))
  saveProfileMetadata(metadata)
  return { ...snapshot, source, documents }
}
