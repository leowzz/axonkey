import { createDefaultBehaviorMap, normalizeBehavior, triggerTypes } from '../behaviorModel.ts'
import type { TriggerBehaviors } from '../behaviorModel.ts'
import { parseDataBackupDocument } from '../dataBackup.ts'
import type { BackupDocument } from '../dataBackup.ts'
import { supportPackages } from '../devices/integration/model.ts'
import type { DeviceInstance } from '../devices/integration/model.ts'
import { fingerprint } from './cloudSync.ts'
import type { CloudSnapshot, CloudState, SyncMemory } from './cloudSync.ts'

const legacyKeys = { rc003: 'legacy-rc003', cmiotA15: 'legacy-cmiotA15', mouse: 'system-mouse' } as const

export function createCloudSnapshot(
  backup: BackupDocument,
  instances: DeviceInstance[],
  memory: SyncMemory = {},
): CloudSnapshot {
  const { cmiotA15RecordingMode: _mode, ...settings } = backup.settings
  return {
    documents: [
      ...instances.map(instance => ({ key: instance.id, kind: instance.kind, config: portableInstance(instance) })),
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

export function prepareCloudRestore(cloud: CloudState, local: BackupDocument, instances: DeviceInstance[]) {
  if (!cloud.documents.length && !cloud.settings) throw new Error('云端还没有配置')
  const backup = structuredClone(local)
  const restoredInstances: DeviceInstance[] = []
  for (const document of cloud.documents) {
    const kind = cloud.models.find(model => model.id === document.model_id)?.code
    const legacyKind = (Object.keys(legacyKeys) as (keyof typeof legacyKeys)[]).find(
      key => kind === key && document.instance_key === legacyKeys[key],
    )
    if (legacyKind) {
      const config = document.config
      if (!Array.isArray(config.profiles)) throw new Error('云端配置方案格式无效')
      backup.profiles = [
        ...backup.profiles.filter(profile => profile.deviceId !== legacyKind),
        ...config.profiles.map(profile => ({
          id: profile.id,
          name: profile.name,
          deviceId: legacyKind,
          keys: profile.behaviors,
        })),
      ]
      backup.activeProfileIds[legacyKind] = config.activeProfileId as string
      if (legacyKind === 'rc003' && config.audioGainDb !== undefined) backup.audio.gain = config.audioGainDb as number
      if (legacyKind === 'cmiotA15' && config.cmiotA15RecordingMode !== undefined)
        backup.settings.cmiotA15RecordingMode = config.cmiotA15RecordingMode as 'hold' | 'click'
      continue
    }
    const support = supportPackages.find(item => item.kind === kind)
    if (!support) throw new Error(`当前版本不支持云端设备型号 ${kind ?? document.model_id}`)
    const config = parseInstanceConfig(
      document.config,
      support.inputs.map(input => input.id),
    )
    const existing = instances.find(instance => instance.id === document.instance_key)
    if (existing && existing.kind !== support.kind) throw new Error('云端实例与本机设备型号不一致')
    restoredInstances.push({
      ...existing,
      ...config,
      id: document.instance_key,
      kind: support.kind,
      binding: existing?.binding ?? null,
    })
  }
  if (cloud.settings) {
    const { sidebarCollapsed, audioStretchCompensation, savedBehaviors, ...settings } = cloud.settings.settings
    backup.settings = { ...backup.settings, ...settings }
    if (sidebarCollapsed !== undefined) backup.preferences.sidebarCollapsed = sidebarCollapsed as boolean
    if (audioStretchCompensation !== undefined) backup.audio.stretchCompensation = audioStretchCompensation as boolean
    if (savedBehaviors !== undefined) backup.savedBehaviors = savedBehaviors as BackupDocument['savedBehaviors']
  }
  return { backup: parseDataBackupDocument(backup), instances: restoredInstances }
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
