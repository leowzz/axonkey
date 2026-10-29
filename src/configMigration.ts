import {
  createBehavior,
  createEmptyBehaviorMap,
  createDefaultBehaviorMap,
  normalizeBehavior,
  parseSequenceImport,
  triggerTypes,
} from './behaviorModel.ts'
import type { TriggerBehaviors } from './behaviorModel.ts'
import { devices } from './deviceModel.ts'
import { parseStoredDeviceProfiles } from './deviceProfiles.ts'
import { backupFilename } from './dataBackup.ts'
import { parseSavedSequences, savedSequencesStorageKey } from './savedSequences.ts'
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
  const entries = [
    legacyProfilesKey,
    profilesKey,
    settingsKey,
    savedSequencesStorageKey,
    'axonkey.audio-settings.v2',
    'axonkey.ui-state.v1',
  ]
    .map(key => [key, storage.getItem(key)] as const)
    .filter((entry): entry is readonly [string, string] => entry[1] !== null)
  const snapshot = {
    format: 'axonkey-legacy-config',
    version: 1,
    exportedAt: date.toISOString(),
    storage: Object.fromEntries(entries),
  }
  const plan = inspectConfigMigration(storage)
  let document: object = snapshot
  // Damaged data still needs a lossless recovery file before export-and-delete.
  if (!plan.error && plan.checkpoint) {
    document = {
      ...createLegacyBackupDocument(storage, JSON.parse(plan.checkpoint)),
      exportedAt: snapshot.exportedAt,
      storage: snapshot.storage,
    }
  }
  return {
    filename: backupFilename(date).replace('axonkey-backup-', 'axonkey-legacy-config-'),
    content: JSON.stringify(document, null, 2),
  }
}

function createLegacyBackupDocument(storage: Pick<Storage, 'getItem'>, source: Record<string, unknown>) {
  const settings = object(JSON.parse(storage.getItem(settingsKey) ?? '{}'))
  const audio = object(JSON.parse(storage.getItem('axonkey.audio-settings.v2') ?? '{}'))
  const ui = object(JSON.parse(storage.getItem('axonkey.ui-state.v1') ?? '{}'))
  const perDevice = source.version === 2
  const profiles = (source.profiles as Record<string, unknown>[]).map((profile, index) => {
    const behaviors = object(profile.behaviors ?? profile.actions ?? profile.mappings)
    const groups = Object.fromEntries(
      devices
        .filter(device => (perDevice ? device.id === profile.deviceId : device.id === 'rc003' || device.id === 'mouse'))
        .map(device => {
          // v1 predates middle-button support; emitting even empty new keys breaks its importer.
          const inputs = device.inputIds.filter(id => perDevice || !id.endsWith('.buttonMiddle'))
          const keys = Object.fromEntries(
            inputs.map(id => [
              device.id === 'mouse' ? id.replace(/^mouse\./, '') : id,
              readTriggers(behaviors[id] ?? {}, `backup-${index}-${id}`),
            ]),
          )
          return [device.id, { keys }]
        }),
    )
    const identity = { id: profile.id ?? `profile-${index}`, name: profile.name ?? `配置 ${index + 1}` }
    return perDevice
      ? { ...identity, deviceId: profile.deviceId, keys: groups[String(profile.deviceId)].keys }
      : { ...identity, devices: groups }
  })
  return {
    format: 'axonkey-backup',
    version: perDevice ? 2 : 1,
    // Old local storage has no application version; do not label it as the current release.
    appVersion: 'legacy',
    ...(perDevice
      ? { activeProfileIds: source.activeProfileIds }
      : {
          activeProfileId: profiles.some(profile => profile.id === source.activeProfileId)
            ? source.activeProfileId
            : profiles[0]?.id,
        }),
    profiles,
    savedBehaviors: parseSavedSequences(storage.getItem(savedSequencesStorageKey)).map(saved => ({
      id: saved.id,
      name: saved.name,
      behaviors: parseSequenceImport(saved.sequence),
    })),
    settings: {
      enabled: settings.enabled ?? true,
      mouseEnabled: settings.mouseEnabled ?? true,
      showRemoteKeyGrid: settings.showRemoteKeyGrid ?? true,
      showMouseKeyGrid: settings.showMouseKeyGrid ?? false,
      mouseIgnoreScrollAcceleration: settings.mouseIgnoreScrollAcceleration ?? true,
      mouseScrollSensitivity: settings.mouseScrollSensitivity ?? 100,
      mouseVerticalScrollIntervalMs: settings.mouseVerticalScrollIntervalMs ?? 50,
      mouseHorizontalScrollIntervalMs: settings.mouseHorizontalScrollIntervalMs ?? 50,
      mouseKeyHoldMs: settings.mouseKeyHoldMs ?? 10,
      mouseEdgeWidth: settings.mouseEdgeWidth ?? 8,
      cmiotA15RecordingMode: settings.cmiotA15RecordingMode ?? 'hold',
    },
    audio: { gain: audio.gain ?? 0, stretchCompensation: audio.stretchCompensation ?? false },
    preferences: { sidebarCollapsed: ui.sidebarCollapsed ?? false },
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
