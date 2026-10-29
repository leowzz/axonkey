import {
  createEmptyBehaviorMap,
  normalizeBehavior,
  parseSequenceImport,
  serializeSequence,
  triggerTypes,
} from './behaviorModel.ts'
import type { Behavior, BehaviorMap, TriggerBehaviors } from './behaviorModel.ts'
import { devices } from './deviceModel.ts'
import type { DeviceId } from './deviceModel.ts'
import type { MappingProfile, StoredSettings } from './appTypes.ts'
import { parseSavedSequences } from './savedSequences.ts'
import type { SavedSequence } from './savedSequences.ts'
import { composeActiveProfileBehaviors, snapshotDeviceProfiles } from './deviceProfiles.ts'

export type BackupSettings = Omit<StoredSettings, 'behaviors'>
export type BackupData = {
  profiles: MappingProfile[]
  activeProfileIds: Record<DeviceId, string>
  savedSequences: SavedSequence[]
  settings: BackupSettings
  audio: { gain: number; stretchCompensation: boolean }
  preferences: { sidebarCollapsed: boolean }
}
export type BackupDocument = {
  format: 'axonkey-backup'
  version: 2
  exportedAt: string
  appVersion: string
  activeProfileIds: Record<DeviceId, string>
  profiles: { id: string; name: string; deviceId: DeviceId; keys: Record<string, TriggerBehaviors> }[]
  savedBehaviors: { id: string; name: string; behaviors: Behavior[] }[]
  settings: BackupSettings
  audio: BackupData['audio']
  preferences: BackupData['preferences']
}
export type ParsedBackup = BackupData & { exportedAt: string; appVersion: string }

const invalid = (detail: string): never => {
  throw new Error(`备份文件无效：${detail}`)
}
function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return invalid('数据结构不正确')
  return value as Record<string, unknown>
}
function string(value: unknown, label: string): string {
  if (typeof value !== 'string' || !value.trim()) return invalid(`${label}不能为空`)
  return value
}
function boolean(value: unknown, label: string): boolean {
  if (typeof value !== 'boolean') return invalid(`${label}不正确`)
  return value
}
function integer(value: unknown, min: number, max: number, label: string): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < min || value > max)
    return invalid(`${label}超出支持范围`)
  return value
}
function behavior(value: unknown): Behavior {
  const raw = record(value)
  const normalized = normalizeBehavior(raw)
  if (
    !normalized ||
    Object.entries(normalized).some(([key, entry]) => JSON.stringify(raw[key]) !== JSON.stringify(entry))
  )
    return invalid('包含不支持或不完整的行为')
  return normalized
}

export function backupFilename(date = new Date()): string {
  const pad = (value: number) => String(value).padStart(2, '0')
  return `axonkey-backup-${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}.json`
}

export function createDataBackup(
  data: BackupData & { behaviors: BehaviorMap },
  appVersion: string,
  date = new Date(),
): BackupDocument {
  return {
    format: 'axonkey-backup',
    version: 2,
    exportedAt: date.toISOString(),
    appVersion,
    activeProfileIds: { ...data.activeProfileIds },
    profiles: snapshotDeviceProfiles(data.profiles, data.activeProfileIds, data.behaviors).map(profile => {
      const device = devices.find(device => device.id === profile.deviceId)!
      return {
        id: profile.id,
        name: profile.name,
        deviceId: device.id,
        keys: Object.fromEntries(
          device.inputIds.map(id => [device.id === 'mouse' ? id.replace(/^mouse\./, '') : id, profile.behaviors[id]]),
        ),
      }
    }),
    savedBehaviors: data.savedSequences.map(saved => {
      const behaviors = parseSequenceImport(saved.sequence)
      if (!behaviors?.length) return invalid(`已保存的行为“${saved.name}”无法读取`)
      return { id: saved.id, name: saved.name, behaviors }
    }),
    settings: { ...data.settings },
    audio: { ...data.audio },
    preferences: { ...data.preferences },
  }
}

/** Reject the whole backup on unsupported data; never import a partial profile. */
export function parseDataBackup(text: string): ParsedBackup {
  let decoded: unknown
  try {
    decoded = JSON.parse(text)
  } catch {
    return invalid('不是有效的 JSON')
  }
  const root = record(decoded)
  if (root.format !== 'axonkey-backup' || root.version !== 2) return invalid('不是支持的 Axonkey 数据备份版本')
  const exportedAt = string(root.exportedAt, '备份时间')
  if (!Number.isFinite(Date.parse(exportedAt))) return invalid('备份时间不正确')
  if (!Array.isArray(root.profiles) || !root.profiles.length) return invalid('至少需要一个配置文件')
  const profileIds = new Set<string>()
  const profiles = root.profiles.map(value => {
    const raw = record(value)
    const id = string(raw.id, '配置 ID')
    if (profileIds.has(id)) return invalid('配置 ID 重复')
    profileIds.add(id)
    const name = string(raw.name, '配置名称')
    if (name.length > 40 || /[\u0000-\u001f\u007f]/.test(name)) return invalid('配置名称不正确')
    const map = createEmptyBehaviorMap()
    const device = devices.find(device => device.id === raw.deviceId)
    if (!device) return invalid('包含当前版本不支持的设备')
    const keys = record(raw.keys)
    const entries = new Map(device.inputIds.map(id => [device.id === 'mouse' ? id.replace(/^mouse\./, '') : id, id]))
    if ([...entries.keys()].some(key => !Object.prototype.hasOwnProperty.call(keys, key)))
      return invalid('设备按键列表不完整')
    for (const [key, value] of Object.entries(keys)) {
      const input = entries.get(key)
      if (!input) return invalid('包含当前版本不支持的按键')
      const triggers = record(value)
      if (Object.keys(triggers).some(trigger => !(triggerTypes as readonly string[]).includes(trigger)))
        return invalid('包含不支持的触发方式')
      const ids = new Set<string>()
      for (const trigger of triggerTypes) {
        const list = triggers[trigger]
        if (!Array.isArray(list)) return invalid('按键序列不完整')
        map[input][trigger] = list.map(value => {
          const item = behavior(value)
          if (ids.has(item.id)) return invalid('同一按键的行为 ID 重复')
          ids.add(item.id)
          return item
        })
      }
    }
    return { id, name, behaviors: map, deviceId: device.id }
  })
  const activeIds = record(root.activeProfileIds)
  if (Object.keys(activeIds).some(id => !devices.some(device => device.id === id)))
    return invalid('包含当前版本不支持的设备')
  const activeProfileIds = Object.fromEntries(
    devices.map(device => {
      const activeId = string(activeIds[device.id], `${device.name}当前配置`)
      if (!profiles.some(profile => profile.id === activeId && profile.deviceId === device.id))
        return invalid('当前配置不属于对应设备')
      return [device.id, activeId]
    }),
  ) as Record<DeviceId, string>
  if (!Array.isArray(root.savedBehaviors)) return invalid('已保存的行为列表缺失')
  let savedSequences: SavedSequence[]
  try {
    savedSequences = parseSavedSequences(
      JSON.stringify(
        root.savedBehaviors.map(value => {
          const raw = record(value)
          if (!Array.isArray(raw.behaviors) || !raw.behaviors.length) return invalid('已保存的行为序列为空')
          return {
            id: string(raw.id, '行为 ID'),
            name: string(raw.name, '行为名称'),
            sequence: serializeSequence(raw.behaviors.map(behavior)),
          }
        }),
      ),
    )
  } catch {
    return invalid('已保存的行为列表不完整或包含重复 ID')
  }
  const settings = record(root.settings)
  const audio = record(root.audio)
  const preferences = record(root.preferences)
  return {
    profiles,
    activeProfileIds,
    savedSequences,
    exportedAt,
    appVersion: string(root.appVersion, '应用版本'),
    settings: {
      enabled: boolean(settings.enabled, '映射总开关'),
      mouseEnabled: boolean(settings.mouseEnabled, '鼠标映射开关'),
      cmiotA15RecordingMode: settings.cmiotA15RecordingMode === 'click' ? 'click' : 'hold',
      showRemoteKeyGrid: boolean(settings.showRemoteKeyGrid, '遥控器按键列表'),
      showMouseKeyGrid: boolean(settings.showMouseKeyGrid, '鼠标按键列表'),
      mouseIgnoreScrollAcceleration: boolean(settings.mouseIgnoreScrollAcceleration, '滚动加速设置'),
      mouseScrollSensitivity: integer(settings.mouseScrollSensitivity, 25, 400, '滚动灵敏度'),
      mouseVerticalScrollIntervalMs: integer(settings.mouseVerticalScrollIntervalMs, 0, 10000, '垂直触发间隔'),
      mouseHorizontalScrollIntervalMs: integer(settings.mouseHorizontalScrollIntervalMs, 0, 10000, '横向触发间隔'),
      mouseKeyHoldMs: integer(settings.mouseKeyHoldMs, 0, 1000, '按键保持时间'),
      mouseEdgeWidth: integer(settings.mouseEdgeWidth, 1, 100, '边缘宽度'),
    },
    audio: {
      gain: integer(audio.gain, -30, 30, '音频增益'),
      stretchCompensation: boolean(audio.stretchCompensation, '语音补偿'),
    },
    preferences: { sidebarCollapsed: boolean(preferences.sidebarCollapsed, '侧栏设置') },
  }
}

/** Keep the previous complete dataset when any storage write fails. */
export function writeBackupStorage(
  storage: Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>,
  changes: Record<string, string>,
): void {
  const previous = Object.keys(changes).map(key => [key, storage.getItem(key)] as const)
  try {
    for (const [key, value] of Object.entries(changes)) storage.setItem(key, value)
  } catch (error) {
    try {
      for (const [key] of previous) storage.removeItem(key)
      for (const [key, value] of previous) if (value !== null) storage.setItem(key, value)
    } catch {
      throw new Error('备份导入失败，原数据恢复未完成；请保留备份文件并重试')
    }
    throw error
  }
}

export function restoreBackupStorage(
  storage: Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>,
  backup: ParsedBackup,
  keys: { profiles: string; settings: string; savedSequences: string; audio: string; uiState: string },
  uiState: object,
): void {
  const behaviors = composeActiveProfileBehaviors(backup.profiles, backup.activeProfileIds)
  writeBackupStorage(storage, {
    [keys.profiles]: JSON.stringify({
      version: 2,
      migrationReviewed: true,
      activeProfileIds: backup.activeProfileIds,
      profiles: backup.profiles,
    }),
    [keys.settings]: JSON.stringify({ ...backup.settings, behaviors }),
    [keys.savedSequences]: JSON.stringify(backup.savedSequences),
    [keys.audio]: JSON.stringify(backup.audio),
    [keys.uiState]: JSON.stringify({
      ...uiState,
      sidebarCollapsed: backup.preferences.sidebarCollapsed,
      activePage: 'settings',
      settingsSection: 'backup',
    }),
  })
}
