import {
  createDefaultBehaviorMap,
  requiresNewBehaviorVersion,
  normalizeBehavior,
  triggerTypes,
} from '../behaviorModel.ts'
import type { TriggerBehaviors } from '../behaviorModel.ts'
import { parseDataBackupDocument } from '../dataBackup.ts'
import type { BackupDocument } from '../dataBackup.ts'
import { supportPackages } from '../devices/integration/model.ts'
import type { DeviceInstance } from '../devices/integration/model.ts'
import { profileContent, profileMetadataKey, readProfileMetadata } from './cloudMetadata.ts'
import type { ProfileMetadata, RestoreSource } from './cloudMetadata.ts'
import { fingerprint } from './cloudSync.ts'
import type { CloudSnapshot, CloudState, SyncMemory } from './cloudSync.ts'

const legacyKeys = { rc003: 'legacy-rc003', cmiotA15: 'legacy-cmiotA15', mouse: 'system-mouse' } as const

export function createCloudSnapshot(
  backup: BackupDocument,
  instances: DeviceInstance[],
  memory: SyncMemory = {},
): CloudSnapshot {
  if (
    backup.version === 3 ||
    instances.some(instance =>
      instance.profiles.some(profile =>
        requiresNewBehaviorVersion(
          Object.values(profile.behaviors).flatMap(triggers => triggerTypes.flatMap(trigger => triggers[trigger])),
        ),
      ),
    )
  )
    throw new Error('云端尚不支持“模拟输入文字”或“打开文件或文件夹”，本次同步已停止，本地配置已保留。')
  const { cmiotA15RecordingMode: _mode, ...settings } = backup.settings
  return {
    documents: [
      ...instances
        .filter(
          instance =>
            memory[`${instance.kind}/${instance.id}`] ||
            instance.profiles.some(profile => hasBehaviors(profile.behaviors)),
        )
        .map(instance => ({ key: instance.id, kind: instance.kind, config: portableInstance(instance) })),
      // Keep previously synced documents so clearing a mapping still reaches the cloud.
      ...(['rc003', 'cmiotA15', 'mouse'] as const)
        .filter(kind => memory[`${kind}/${legacyKeys[kind]}`] || hasLegacyData(backup, kind))
        .map(kind => ({
          key: legacyKeys[kind],
          kind,
          config: {
            name: kind === 'mouse' ? '系统鼠标' : `${kind} 旧版映射`,
            enabled: kind === 'mouse' ? backup.settings.mouseEnabled : backup.settings.enabled,
            activeProfileId: backup.activeProfileIds[kind],
            profiles: backup.profiles
              .filter(profile => profile.deviceId === kind)
              .map(profile => ({
                id: profile.id,
                name: profile.name,
                behaviors: profile.keys,
              })),
            ...(kind === 'rc003' ? { audioGainDb: backup.audio.gain } : {}),
            ...(kind === 'cmiotA15' ? { cmiotA15RecordingMode: backup.settings.cmiotA15RecordingMode } : {}),
          },
        })),
    ],
    settings: {
      ...settings,
      sidebarCollapsed: backup.preferences.sidebarCollapsed,
      audioStretchCompensation: backup.audio.stretchCompensation,
      savedBehaviors: backup.savedBehaviors,
    },
  }
}

function hasLegacyData(backup: BackupDocument, kind: keyof typeof legacyKeys): boolean {
  const profiles = backup.profiles.filter(profile => profile.deviceId === kind)
  if (!profiles.some(profile => hasBehaviors(profile.keys))) return false
  const defaults: Record<string, TriggerBehaviors> = createDefaultBehaviorMap()
  return (
    profiles.length > 1 ||
    profiles.some(
      profile =>
        profile.id !== `${kind}:default` ||
        profile.name !== '默认配置' ||
        Object.entries(profile.keys).some(
          ([input, behaviors]) =>
            fingerprint(behaviors) !== fingerprint(defaults[kind === 'mouse' ? `mouse.${input}` : input]),
        ),
    )
  )
}

function hasBehaviors(behaviors: Record<string, TriggerBehaviors>): boolean {
  return Object.values(behaviors).some(triggers => triggerTypes.some(trigger => triggers[trigger].length > 0))
}

function portableInstance(instance: DeviceInstance): Record<string, unknown> {
  return {
    name: instance.name,
    enabled: instance.enabled,
    profiles: instance.profiles,
    activeProfileId: instance.activeProfileId,
    ...(instance.audioGainDb === undefined ? {} : { audioGainDb: instance.audioGainDb }),
    ...(instance.cmiotA15RecordingMode === undefined ? {} : { cmiotA15RecordingMode: instance.cmiotA15RecordingMode }),
  }
}

export type RestoreSelection = {
  devices: { documentId: string; profileIds: string[]; targetId: string }[]
  settings: boolean
  savedBehaviors: boolean
}
export type RestoreMetadata = Record<string, ProfileMetadata>

export function prepareCloudRestore(
  cloud: CloudState,
  local: BackupDocument,
  instances: DeviceInstance[],
  selection: RestoreSelection,
) {
  const backup = structuredClone(local)
  const targets = new Map<string, DeviceInstance>()
  const metadata: RestoreMetadata = { ...readProfileMetadata() }
  let imported = 0
  for (const selected of selection.devices) {
    if (!selected.profileIds.length) continue
    const document = cloud.documents.find(item => item.id === selected.documentId)
    if (!document) throw new Error('所选云端设备已不存在，请刷新后重试')
    const kind = cloud.models.find(model => model.id === document.model_id)?.code
    const legacyKind = (Object.keys(legacyKeys) as (keyof typeof legacyKeys)[]).find(
      key => selected.targetId === `legacy:${key}` && key === kind,
    )
    const support = supportPackages.find(item => item.kind === kind)
    if (!support && kind !== 'mouse') throw new Error(`当前版本不支持云端设备型号 ${kind}`)
    const inputs =
      kind === 'mouse'
        ? Object.keys(createDefaultBehaviorMap())
            .filter(key => key.startsWith('mouse.'))
            .map(key => key.slice(6))
        : support!.inputs.map(input => input.id)
    const config = parseInstanceConfig(document.config, inputs)
    let target: DeviceInstance | undefined
    if (!legacyKind) {
      if (!support) throw new Error('系统鼠标只能恢复到本机鼠标映射')
      const existing =
        targets.get(selected.targetId) ?? instances.find(item => item.id === selected.targetId.replace(/^new:/, ''))
      if (existing && existing.kind !== kind) throw new Error('请选择同型号的本机设备')
      if (!existing && !selected.targetId.startsWith('new:')) throw new Error('本机目标设备已不存在，请重新选择')
      target = existing
        ? structuredClone(existing)
        : {
            ...config,
            id: selected.targetId.slice(4),
            kind: support.kind,
            binding: null,
            enabled: false,
            profiles: [],
            activeProfileId: '',
          }
    }
    const targetKey = legacyKind ? legacyKeys[legacyKind] : target!.id
    const profiles = legacyKind
      ? backup.profiles
          .filter(item => item.deviceId === legacyKind)
          .map(item => ({ id: item.id, name: item.name, behaviors: item.keys }))
      : target!.profiles
    for (const id of selected.profileIds) {
      const profile = config.profiles.find(item => item.id === id) as
        (DeviceInstance['profiles'][number] & { app_version?: string | null }) | undefined
      if (!profile) throw new Error('所选云端方案已不存在，请刷新后重试')
      const already = profiles.some(item => {
        const prior = metadata[profileMetadataKey(targetKey, item.id)]
        return (
          prior?.restored_from?.device_config_id === document.id &&
          prior.restored_from.profile_id === profile.id &&
          prior.restored_content === profileContent(item) &&
          prior.source_content === profileContent(profile)
        )
      })
      if (already) continue
      const restored = { ...profile, id: crypto.randomUUID() }
      const origin: RestoreSource = {
        device_config_id: document.id,
        profile_id: profile.id,
        revision: document.revision,
        source_platform: document.source_platform ?? 'unknown',
        source_computer_name: document.source_computer_name ?? null,
        app_version: profile.app_version ?? null,
      }
      metadata[profileMetadataKey(targetKey, restored.id)] = {
        content: profileContent(restored),
        app_version: origin.app_version,
        restored_from: origin,
        source_content: profileContent(profile),
      }
      if (profiles.some(item => item.name === restored.name)) restored.name += '（云端副本）'
      // The display name belongs to this local copy; keep the source content version.
      metadata[profileMetadataKey(targetKey, restored.id)].content = profileContent(restored)
      metadata[profileMetadataKey(targetKey, restored.id)].restored_content = profileContent(restored)
      profiles.push(restored)
      imported++
      if (legacyKind)
        backup.profiles.push({ id: restored.id, name: restored.name, deviceId: legacyKind, keys: restored.behaviors })
    }
    if (target) {
      if (!target.activeProfileId) target.activeProfileId = target.profiles[0].id
      targets.set(selected.targetId, target)
    }
  }
  if (cloud.settings) {
    const { sidebarCollapsed, audioStretchCompensation, savedBehaviors, ...settings } = cloud.settings.settings
    if (selection.settings) {
      backup.settings = { ...backup.settings, ...settings }
      if (sidebarCollapsed !== undefined) backup.preferences.sidebarCollapsed = sidebarCollapsed as boolean
      if (audioStretchCompensation !== undefined) backup.audio.stretchCompensation = audioStretchCompensation as boolean
    }
    if (selection.savedBehaviors && savedBehaviors !== undefined)
      backup.savedBehaviors = savedBehaviors as BackupDocument['savedBehaviors']
  }
  return { backup: parseDataBackupDocument(backup), instances: [...targets.values()], metadata, imported }
}

function parseInstanceConfig(value: Record<string, unknown>, inputs: string[]) {
  const fail = (): never => {
    throw new Error('云端设备配置包含不支持或不完整的数据')
  }
  if (
    typeof value.name !== 'string' ||
    !value.name.trim() ||
    typeof value.enabled !== 'boolean' ||
    !Array.isArray(value.profiles) ||
    !value.profiles.length
  )
    return fail()
  if (
    value.audioGainDb !== undefined &&
    (!Number.isInteger(value.audioGainDb) || (value.audioGainDb as number) < -30 || (value.audioGainDb as number) > 30)
  )
    return fail()
  if (
    value.cmiotA15RecordingMode !== undefined &&
    value.cmiotA15RecordingMode !== 'hold' &&
    value.cmiotA15RecordingMode !== 'click'
  )
    return fail()
  const profileIds = new Set<string>()
  for (const profile of value.profiles) {
    if (
      !profile ||
      typeof profile.id !== 'string' ||
      !profile.id ||
      profileIds.has(profile.id) ||
      typeof profile.name !== 'string' ||
      !profile.name.trim() ||
      !profile.behaviors ||
      typeof profile.behaviors !== 'object' ||
      Array.isArray(profile.behaviors)
    )
      return fail()
    profileIds.add(profile.id)
    for (const [input, triggers] of Object.entries(profile.behaviors)) {
      if (!inputs.includes(input) || !triggers || typeof triggers !== 'object' || Object.keys(triggers).length !== 3)
        return fail()
      const ids = new Set<string>()
      for (const trigger of triggerTypes) {
        const actions = (triggers as Record<string, unknown>)[trigger]
        if (!Array.isArray(actions)) return fail()
        for (const action of actions) {
          const normalized = normalizeBehavior(action)
          if (
            !normalized ||
            Object.entries(normalized).some(([key, entry]) => JSON.stringify(action[key]) !== JSON.stringify(entry)) ||
            ids.has(normalized.id)
          )
            return fail()
          ids.add(normalized.id)
        }
      }
    }
  }
  if (typeof value.activeProfileId !== 'string' || !profileIds.has(value.activeProfileId)) return fail()
  return portableInstance(value as DeviceInstance) as Pick<
    DeviceInstance,
    'name' | 'enabled' | 'profiles' | 'activeProfileId' | 'audioGainDb' | 'cmiotA15RecordingMode'
  >
}
