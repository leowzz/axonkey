import { cloneBehaviorMap, createEmptyBehaviorMap, parseStoredBehaviors } from './behaviorModel.ts'
import type { BehaviorMap } from './behaviorModel.ts'
import { devices } from './deviceModel.ts'
import type { DeviceId } from './deviceModel.ts'
import type { MappingProfile, StoredProfiles } from './appTypes.ts'

export const deviceProfilesStorageVersion = 2

export function isDeviceId(value: unknown): value is DeviceId {
  return devices.some(device => device.id === value)
}

/** Keep the complete runtime shape while clearing inputs owned by other devices. */
export function extractDeviceBehaviors(behaviors: BehaviorMap, deviceId: DeviceId): BehaviorMap {
  const source = cloneBehaviorMap(behaviors)
  const result = createEmptyBehaviorMap()
  for (const inputId of devices.find(device => device.id === deviceId)!.inputIds) result[inputId] = source[inputId]
  return result
}

/** Replace one device's inputs without changing the other device's running map. */
export function mergeDeviceBehaviors(current: BehaviorMap, deviceId: DeviceId, source: BehaviorMap): BehaviorMap {
  const result = cloneBehaviorMap(current)
  const replacement = extractDeviceBehaviors(source, deviceId)
  for (const inputId of devices.find(device => device.id === deviceId)!.inputIds) result[inputId] = replacement[inputId]
  return result
}

/** Include live edits from both active profiles before persisting or switching. */
export function snapshotDeviceProfiles(
  profiles: readonly MappingProfile[],
  activeProfileIds: Record<DeviceId, string>,
  behaviors: BehaviorMap,
): MappingProfile[] {
  return profiles.map(profile => ({
    ...profile,
    behaviors: extractDeviceBehaviors(
      profile.id === activeProfileIds[profile.deviceId] ? behaviors : profile.behaviors,
      profile.deviceId,
    ),
  }))
}

export function composeActiveProfileBehaviors(
  profiles: readonly MappingProfile[],
  activeProfileIds: Record<DeviceId, string>,
): BehaviorMap {
  let behaviors = createEmptyBehaviorMap()
  for (const device of devices) {
    const active = profiles.find(
      profile => profile.deviceId === device.id && profile.id === activeProfileIds[device.id],
    )
    if (active) behaviors = mergeDeviceBehaviors(behaviors, device.id, active.behaviors)
  }
  return behaviors
}

export function createDefaultDeviceProfiles(behaviors: BehaviorMap): StoredProfiles {
  const profiles = devices.map(device => ({
    id: `${device.id}:default`,
    name: '默认配置',
    deviceId: device.id,
    behaviors: extractDeviceBehaviors(behaviors, device.id),
  }))
  return {
    profiles,
    activeProfileIds: Object.fromEntries(profiles.map(profile => [profile.deviceId, profile.id])) as Record<
      DeviceId,
      string
    >,
  }
}

function record(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}

function profileName(value: unknown, index: number): string {
  const name =
    typeof value === 'string'
      ? value
          .trim()
          .replace(/[\u0000-\u001f\u007f]/g, '')
          .slice(0, 40)
      : ''
  return name || (index === 0 ? '默认配置' : `配置 ${index + 1}`)
}

function uniqueId(value: unknown, fallback: string, ids: Set<string>): string {
  const base = typeof value === 'string' && value.trim() ? value.trim() : fallback
  let id = base
  let suffix = 2
  while (ids.has(id)) id = `${base}:${suffix++}`
  ids.add(id)
  return id
}

/** Tolerant local-storage parsing; strict external-file validation belongs to imports. */
export function parseStoredDeviceProfiles(value: unknown, fallbackBehaviors: BehaviorMap): StoredProfiles {
  const fallback = createDefaultDeviceProfiles(fallbackBehaviors)
  let parsed = value
  if (typeof parsed === 'string') {
    try {
      parsed = JSON.parse(parsed) as unknown
    } catch {
      return fallback
    }
  }
  if (!record(parsed) || !Array.isArray(parsed.profiles)) return fallback
  if (parsed.version !== deviceProfilesStorageVersion) return fallback
  const ids = new Set<string>()
  const profiles = parsed.profiles.flatMap((raw, index): MappingProfile[] => {
    if (!record(raw) || !isDeviceId(raw.deviceId)) return []
    return [
      {
        id: uniqueId(raw.id, `${raw.deviceId}:profile-${index + 1}`, ids),
        name: profileName(raw.name, index),
        deviceId: raw.deviceId,
        behaviors: extractDeviceBehaviors(parseStoredBehaviors(raw.behaviors), raw.deviceId),
      },
    ]
  })
  const requested = record(parsed.activeProfileIds) ? parsed.activeProfileIds : {}
  const activeProfileIds = { ...fallback.activeProfileIds }
  for (const device of devices) {
    if (!profiles.some(profile => profile.deviceId === device.id)) {
      const defaults = fallback.profiles.find(profile => profile.deviceId === device.id)!
      profiles.push({ ...defaults, id: uniqueId(defaults.id, defaults.id, ids) })
    }
    const deviceProfiles = profiles.filter(profile => profile.deviceId === device.id)
    activeProfileIds[device.id] =
      deviceProfiles.find(profile => profile.id === requested[device.id])?.id ?? deviceProfiles[0].id
  }
  return { profiles, activeProfileIds }
}
