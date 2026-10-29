import { createDefaultBehaviorMap, createEmptyBehaviorMap } from './behaviorModel.ts'
import { devices } from './deviceModel.ts'
import { parseDataBackupDocument, restoreBackupStorage, writeBackupStorage } from './dataBackup.ts'
import type { ParsedBackup } from './dataBackup.ts'
import { inspectConfigMigration, legacyProfilesKey, migrateConfig } from './configMigration.ts'
import type { MigrationPlan, MigrationSelection } from './configMigration.ts'
import type { DeviceInstance } from './devices/integration/model.ts'
import { savedSequencesStorageKey } from './savedSequences.ts'
import { createDefaultDeviceProfiles, parseStoredDeviceProfiles } from './deviceProfiles.ts'

export type LegacyBackupImport = { plan: MigrationPlan; backup?: ParsedBackup }
export type BackupImport = { kind: 'current'; data: ParsedBackup } | ({ kind: 'legacy' } & LegacyBackupImport)
type StorageAccess = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>
const profilesKey = 'axonkey.mapping-profiles.v2'
const settingsKey = 'axonkey.settings.v1'
const backupKeys = {
  profiles: profilesKey,
  settings: settingsKey,
  savedSequences: savedSequencesStorageKey,
  audio: 'axonkey.audio-settings.v2',
  uiState: 'axonkey.ui-state.v1',
}

export function parseBackupImport(text: string): BackupImport {
  let decoded: unknown
  try {
    decoded = JSON.parse(text)
  } catch {
    throw new Error('备份文件无效：不是有效的 JSON')
  }
  const root = record(decoded)
  if (root.format === 'axonkey-backup') {
    if (root.version === 1) return legacyBackup(root)
    if (root.version === 2 && isLegacyDeviceBackup(root)) return legacyBackup(root)
    return { kind: 'current', data: parseDataBackupDocument(root) }
  }
  let source: Record<string, string>
  if (root.format === 'axonkey-legacy-config' && root.version === 1) {
    const storage = record(root.storage)
    source = {}
    for (const key of [legacyProfilesKey, profilesKey, settingsKey]) {
      if (storage[key] === undefined) continue
      if (typeof storage[key] !== 'string') throw new Error('旧配置快照的数据结构不正确')
      source[key] = storage[key]
    }
  } else if (root.format === undefined && (root.version === 1 || root.version === 2) && Array.isArray(root.profiles)) {
    source = { [root.version === 1 ? legacyProfilesKey : profilesKey]: JSON.stringify(root) }
  } else if (root.format === undefined && ('behaviors' in root || 'actions' in root || 'mappings' in root)) {
    source = { [settingsKey]: JSON.stringify(root) }
  } else throw new Error('不是支持的 Axonkey 数据备份版本')
  return { kind: 'legacy', plan: inspectImport(source) }
}

export async function migrateBackupImport(
  storage: StorageAccess,
  imported: LegacyBackupImport,
  saveRemote: (instance: DeviceInstance) => Promise<void>,
  onProgress: (message: string) => void,
  remoteTarget: DeviceInstance | null,
  selection: MigrationSelection = { mouse: true, remote: true },
): Promise<string | null> {
  const changes: Record<string, string> = {}
  const staged = {
    getItem: (key: string) => changes[key] ?? storage.getItem(key),
    setItem: (key: string, value: string) => {
      changes[key] = value
    },
    removeItem: () => {
      throw new Error('导入不能删除本机旧配置')
    },
  }
  let remote: DeviceInstance | undefined
  const bindingId = await migrateConfig(
    staged,
    imported.plan,
    async instance => {
      remote = instance
    },
    onProgress,
    remoteTarget,
    false,
    selection,
  )
  if (imported.backup) {
    const current = parseStoredDeviceProfiles(staged.getItem(profilesKey), createDefaultBehaviorMap())
    const otherProfiles = imported.backup.profiles.filter(
      profile => profile.deviceId !== 'rc003' && profile.deviceId !== 'mouse',
    )
    const profiles = [
      ...current.profiles.filter(profile => !otherProfiles.some(other => other.deviceId === profile.deviceId)),
      ...otherProfiles,
    ]
    const activeProfileIds = { ...current.activeProfileIds }
    for (const profile of otherProfiles)
      activeProfileIds[profile.deviceId] = imported.backup.activeProfileIds[profile.deviceId]
    restoreBackupStorage(
      staged,
      { ...imported.backup, profiles, activeProfileIds },
      backupKeys,
      JSON.parse(storage.getItem(backupKeys.uiState) ?? '{}'),
    )
  }
  const previous = Object.keys(changes).map(key => [key, storage.getItem(key)] as const)
  writeBackupStorage(storage, changes)
  try {
    if (remote) await saveRemote(remote)
  } catch (error) {
    for (const [key, value] of previous) {
      if (value === null) storage.removeItem(key)
      else storage.setItem(key, value)
    }
    throw error
  }
  return bindingId
}

function legacyBackup(root: Record<string, unknown>): BackupImport {
  if (!Array.isArray(root.profiles) || !root.profiles.length) throw new Error('旧备份至少需要一个配置文件')
  const profiles = root.profiles.flatMap(value => {
    const profile = record(value)
    if (typeof profile.id !== 'string' || !profile.id.trim()) throw new Error('旧备份配置 ID 不能为空')
    const groups = root.version === 1 ? record(profile.devices) : { [String(profile.deviceId)]: { keys: profile.keys } }
    if (Object.keys(groups).some(id => !devices.some(device => device.id === id)))
      throw new Error('旧备份包含不支持的设备')
    return Object.entries(groups).map(([id, group]) => {
      const keys = { ...record(record(group).keys) }
      const legacyMouseInputs = id === 'mouse' && !Object.keys(keys).some(key => key.endsWith('.buttonMiddle'))
      const device = devices.find(device => device.id === id)!
      const empty = createEmptyBehaviorMap()
      for (const input of device.inputIds) {
        const key = id === 'mouse' ? input.replace(/^mouse\./, '') : input
        if (root.version === 1 || (legacyMouseInputs && key.endsWith('.buttonMiddle'))) {
          if (!(key in keys)) keys[key] = empty[input]
        }
      }
      return { id: root.version === 1 ? `${id}:${profile.id}` : profile.id, name: profile.name, deviceId: id, keys }
    })
  })
  if (root.version === 1 && (typeof root.activeProfileId !== 'string' || !root.activeProfileId.trim()))
    throw new Error('旧备份当前配置不能为空')
  const activeProfileIds =
    root.version === 1
      ? Object.fromEntries(devices.map(device => [device.id, `${device.id}:${root.activeProfileId}`]))
      : { ...record(root.activeProfileIds) }
  const originalDevices = new Set(profiles.map(profile => profile.deviceId))
  // Earlier backups predate A15 support; validate them without importing defaults for absent devices.
  const defaults = createDefaultDeviceProfiles(createEmptyBehaviorMap())
  for (const device of devices.filter(device => !originalDevices.has(device.id))) {
    const fallback = defaults.profiles.find(profile => profile.deviceId === device.id)!
    profiles.push({
      id: fallback.id,
      name: fallback.name,
      deviceId: device.id,
      keys: Object.fromEntries(
        device.inputIds.map(input => [
          device.id === 'mouse' ? input.replace(/^mouse\./, '') : input,
          fallback.behaviors[input],
        ]),
      ),
    })
    activeProfileIds[device.id] = fallback.id
  }
  const backup = parseDataBackupDocument({ ...root, version: 2, profiles, activeProfileIds })
  backup.profiles = backup.profiles.filter(profile => originalDevices.has(profile.deviceId))
  const source = { version: 2, profiles: backup.profiles, activeProfileIds: backup.activeProfileIds }
  return { kind: 'legacy', backup, plan: inspectImport({ [profilesKey]: JSON.stringify(source) }) }
}

function isLegacyDeviceBackup(root: Record<string, unknown>): boolean {
  if (!Array.isArray(root.profiles) || !root.profiles.length) return false
  // 1.0.20 introduced device-instance migration; older v2 backups may already have all mouse inputs.
  const version = typeof root.appVersion === 'string' ? /^(\d+)\.(\d+)\.(\d+)(?:[-+].*)?$/.exec(root.appVersion) : null
  const legacyAppVersion =
    version &&
    (Number(version[1]) < 1 || (Number(version[1]) === 1 && Number(version[2]) === 0 && Number(version[3]) < 20))
  return (
    !!legacyAppVersion ||
    !root.profiles.some(value => record(value).deviceId === 'cmiotA15') ||
    root.profiles.some(value => {
      const profile = record(value)
      return (
        profile.deviceId === 'mouse' && !Object.keys(record(profile.keys)).some(key => key.endsWith('.buttonMiddle'))
      )
    })
  )
}

function inspectImport(source: Record<string, string>): MigrationPlan {
  const plan = inspectConfigMigration({ getItem: key => source[key] ?? null })
  if (plan.error) throw new Error(plan.error)
  if (!plan.found || (!plan.mouse.length && !plan.remote)) throw new Error('备份中没有可迁移的鼠标或小米遥控器配置')
  return plan
}

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('备份文件的数据结构不正确')
  return value as Record<string, unknown>
}
