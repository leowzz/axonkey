import {
  createBehavior,
  createEmptyBehaviorMap,
  createDefaultBehaviorMap,
  normalizeBehavior,
  triggerTypes,
} from './behaviorModel.ts'
import type { TriggerBehaviors } from './behaviorModel.ts'
import { devices } from './deviceModel.ts'
import { parseStoredDeviceProfiles } from './deviceProfiles.ts'
import { backupFilename } from './dataBackup.ts'
import type { MappingProfile } from './appTypes.ts'
import type { DeviceInstance } from './devices/integration/model.ts'

export const legacyProfilesKey = 'axonkey.mapping-profiles.v1'
const profilesKey = 'axonkey.mapping-profiles.v2'
const settingsKey = 'axonkey.settings.v1'
export const previewInstancesKey = 'axonkey.device-instances.preview.v1'
type StorageAccess = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>
export type MigrationPlan = {
  found: boolean
  error: string
  mouse: MappingProfile[]
  mouseActiveId: string
  remote: DeviceInstance | null
  remoteTargetId?: string
  fromDeviceProfiles?: boolean
  checkpoint?: string
}
export type MigrationSelection = { mouse: boolean; remote: boolean }

/** This is the only entry point that reads legacy mapping formats. */
export function inspectConfigMigration(storage: Pick<Storage, 'getItem'>): MigrationPlan {
  const plan: MigrationPlan = { found: false, error: '', mouse: [], mouseActiveId: '', remote: null }
  try {
    const shared = storage.getItem(legacyProfilesKey)
    const settings = storage.getItem(settingsKey)
    let source: Record<string, unknown>
    let rawProfiles: unknown[]
    const current = storage.getItem(profilesKey)
    if (shared !== null) {
      plan.found = true
      source = object(JSON.parse(shared))
      plan.fromDeviceProfiles = source.migrationSource === 'deviceProfiles'
    } else if (current !== null) {
      source = object(JSON.parse(current))
      if (source.version !== 2 || source.migrationReviewed === true) return plan
      plan.found = true
      plan.fromDeviceProfiles = true
    } else {
      if (settings === null) return plan
      source = object(JSON.parse(settings))
      if (!('behaviors' in source || 'actions' in source || 'mappings' in source)) return plan
      plan.found = true
      source = {
        version: 1,
        profiles: [
          { id: 'default', name: '默认配置', behaviors: source.behaviors ?? source.actions ?? source.mappings },
        ],
      }
    }
    if (source.version !== undefined && source.version !== 1 && source.version !== 2)
      throw new Error('不支持此旧配置版本。')
    if (typeof source.migrationRemoteTargetId === 'string') plan.remoteTargetId = source.migrationRemoteTargetId
    if (!Array.isArray(source.profiles)) throw new Error('旧配置列表无法读取。')
    rawProfiles = source.profiles
    const parsed = rawProfiles.map((value, index) => {
      const raw = object(value)
      const behaviors = object(raw.behaviors ?? raw.actions ?? raw.mappings)
      const name =
        typeof raw.name === 'string'
          ? raw.name
              .trim()
              .replace(/[\u0000-\u001f\u007f]/g, '')
              .slice(0, 40)
          : ''
      return {
        id: typeof raw.id === 'string' ? raw.id : `profile-${index}`,
        deviceId: raw.deviceId,
        name: name || `配置 ${index + 1}`,
        behaviors,
      }
    })
    for (const kind of ['mouse', 'rc003'] as const) {
      const inputs = devices.find(device => device.id === kind)!.inputIds
      const candidates = source.version === 2 ? parsed.filter(profile => profile.deviceId === kind) : parsed
      if (
        source.version === 2
          ? !candidates.length
          : !candidates.some(profile => inputs.some(id => id in profile.behaviors))
      )
        continue
      const profiles = candidates.map((profile, index) => {
        const map = createEmptyBehaviorMap()
        for (const input of inputs) {
          if (input in profile.behaviors)
            map[input] = readTriggers(profile.behaviors[input], `${kind}-${index}-${input}`)
        }
        return { id: `migrated-${kind}-${index}`, name: profile.name, deviceId: kind, behaviors: map }
      })
      const selected = source.version === 2 ? object(source.activeProfileIds)[kind] : source.activeProfileId
      const activeIndex = candidates.findIndex(profile => profile.id === selected)
      const activeId = profiles[Math.max(0, activeIndex)].id
      if (kind === 'mouse') {
        plan.mouse = profiles
        plan.mouseActiveId = activeId
      } else {
        plan.remote = {
          id: typeof source.migrationRemoteId === 'string' ? source.migrationRemoteId : crypto.randomUUID(),
          kind: 'rc003',
          name: '小米遥控器',
          binding: null,
          enabled: true,
          activeProfileId: activeId,
          profiles: profiles.map(profile => ({
            id: profile.id,
            name: profile.name,
            behaviors: Object.fromEntries(inputs.map(id => [id, profile.behaviors[id]])),
          })),
        }
      }
    }
    plan.checkpoint = JSON.stringify({
      ...source,
      migrationRemoteId: plan.remote?.id,
      migrationSource: plan.fromDeviceProfiles ? 'deviceProfiles' : 'shared',
    })
  } catch (error) {
    plan.error = `无法读取旧配置：${error instanceof Error ? error.message : String(error)}`
    plan.found = true
  }
  return plan
}

export async function migrateConfig(
  storage: StorageAccess,
  plan: MigrationPlan,
  saveRemote: (instance: DeviceInstance) => Promise<void>,
  onProgress: (message: string) => void,
  remoteTarget: DeviceInstance | null = null,
  cleanup = true,
  selection: MigrationSelection = { mouse: true, remote: true },
): Promise<string | null> {
  if (plan.error) throw new Error(plan.error)
  const remote = selection.remote &&
    plan.remote && {
      ...(remoteTarget ?? plan.remote),
      profiles: plan.remote.profiles,
      activeProfileId: plan.remote.activeProfileId,
    }
  // Keep settings-only sources discoverable after a partial write, and reuse the same remote on retry.
  if (cleanup && plan.checkpoint)
    storage.setItem(
      legacyProfilesKey,
      JSON.stringify({
        ...JSON.parse(plan.checkpoint),
        migrationRemoteId: plan.remote?.id,
        migrationRemoteTargetId: remoteTarget?.id,
      }),
    )
  if (selection.mouse && plan.mouse.length) {
    onProgress('正在迁移鼠标配置…')
    const current = parseStoredDeviceProfiles(storage.getItem(profilesKey), createDefaultBehaviorMap())
    const profiles = [...current.profiles.filter(profile => profile.deviceId !== 'mouse'), ...plan.mouse]
    storage.setItem(
      profilesKey,
      JSON.stringify({
        version: 2,
        migrationReviewed: true,
        profiles,
        activeProfileIds: { ...current.activeProfileIds, mouse: plan.mouseActiveId },
      }),
    )
  }
  if (remote) {
    onProgress(remoteTarget ? '正在覆盖小米遥控器配置…' : '正在创建小米遥控器并保存配置…')
    await saveRemote(remote)
  }
  if (cleanup) {
    onProgress('正在清理旧配置…')
    discardLegacyConfig(storage, plan, true)
  }
  return remote && !remote.binding ? remote.id : null
}

export function createLegacyConfigExport(storage: Pick<Storage, 'getItem'>, date = new Date()) {
  // Preserve raw strings so unreadable legacy data can also be exported without loss.
  const entries = [legacyProfilesKey, profilesKey, settingsKey]
    .map(key => [key, storage.getItem(key)] as const)
    .filter((entry): entry is readonly [string, string] => entry[1] !== null)
  return {
    filename: backupFilename(date).replace('axonkey-backup-', 'axonkey-legacy-config-'),
    content: JSON.stringify(
      {
        format: 'axonkey-legacy-config',
        version: 1,
        exportedAt: date.toISOString(),
        storage: Object.fromEntries(entries),
      },
      null,
      2,
    ),
  }
}

export function discardLegacyConfig(storage: StorageAccess, plan: MigrationPlan, migrated = false): void {
  const stored = storage.getItem(profilesKey)
  if (stored !== null) {
    const current = parseStoredDeviceProfiles(stored, createDefaultBehaviorMap())
    const profiles = plan.fromDeviceProfiles
      ? current.profiles.filter(profile => profile.deviceId !== 'rc003' && (migrated || profile.deviceId !== 'mouse'))
      : current.profiles
    const activeProfileIds: Partial<typeof current.activeProfileIds> = { ...current.activeProfileIds }
    if (plan.fromDeviceProfiles) {
      delete activeProfileIds.rc003
      if (!migrated) delete activeProfileIds.mouse
    }
    storage.setItem(profilesKey, JSON.stringify({ version: 2, migrationReviewed: true, profiles, activeProfileIds }))
  }
  // Settings share a key with the current app: remove mapping payloads, not preferences.
  const settings = storage.getItem(settingsKey)
  if (settings !== null) {
    let value: Record<string, unknown> | null = null
    try {
      value = object(JSON.parse(settings))
    } catch {
      /* Exported or successfully migrated settings can be removed even if unreadable. */
    }
    if (value) {
      delete value.behaviors
      delete value.actions
      delete value.mappings
      storage.setItem(settingsKey, JSON.stringify(value))
    } else storage.removeItem(settingsKey)
  }
  storage.removeItem(legacyProfilesKey)
}

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('配置结构不正确。')
  return value as Record<string, unknown>
}

function readTriggers(value: unknown, id: string): TriggerBehaviors {
  const result: TriggerBehaviors = { click: [], doubleClick: [], longPress: [] }
  if (typeof value === 'string') {
    const keys = value
      .split('+')
      .map(key => key.trim())
      .filter(Boolean)
    if (!keys.length || value.trim() === 'original') return result
    result.click = [
      keys.length === 1
        ? createBehavior({ type: 'key', key: keys[0], id })
        : createBehavior({ type: 'shortcut', keys, id }),
    ]
    return result
  }
  const triggers = object(value)
  for (const trigger of triggerTypes) {
    const list = triggers[trigger] ?? []
    if (!Array.isArray(list)) throw new Error('按键行为列表不正确。')
    result[trigger] = list.map((entry, index) => {
      const behavior = normalizeBehavior(entry, `${id}-${trigger}-${index}`)
      if (!behavior) throw new Error('包含不支持的按键行为，旧数据已保留。')
      return behavior
    })
  }
  return result
}
