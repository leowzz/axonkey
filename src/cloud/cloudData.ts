import { createDefaultBehaviorMap, normalizeBehavior, triggerTypes } from '../behaviorModel.ts'
import type { TriggerBehaviors } from '../behaviorModel.ts'
import { parseDataBackupDocument } from '../dataBackup.ts'
import type { BackupDocument } from '../dataBackup.ts'
import { defaultDeviceDisplaySettings, getSupportPackages } from '../devices/integration/model.ts'
import type { DeviceDisplaySettings, DeviceInstance, ProfileDisplayConfig } from '../devices/integration/model.ts'
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
  const { cmiotA15RecordingMode: _mode, ...settings } = backup.settings
  return {
    documents: [
      ...instances
        .filter(
          instance =>
            memory[`${instance.kind}/${instance.id}`] ||
            instance.profiles.some(
              profile => profile.quick || hasBehaviors(profile.behaviors) || hasCustomProfileDisplay(profile.display),
            ) ||
            instance.applicationProfiles?.length ||
            hasNonDefaultDeviceDisplay(instance.display),
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
                ...(profile.applicationIds ? { applicationIds: [...profile.applicationIds] } : {}),
                ...(profile.quick ? { quick: true } : {}),
                ...(profile.quick && profile.promptMode ? { promptMode: true } : {}),
                behaviors: profile.keys,
              })),
            ...(kind === 'mouse' && backup.applicationProfileSwitching
              ? { appProfileSwitching: backup.applicationProfileSwitching.mouse }
              : {}),
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
  const hasApplicationMappings = profiles.some(profile => profile.applicationIds?.length)
  const hasQuickProfiles = profiles.some(profile => profile.quick)
  if (!profiles.some(profile => hasBehaviors(profile.keys)) && !hasApplicationMappings && !hasQuickProfiles)
    return false
  const defaults: Record<string, TriggerBehaviors> = createDefaultBehaviorMap()
  return (
    profiles.length > 1 ||
    profiles.some(
      profile =>
        profile.id !== `${kind}:default` ||
        profile.name !== '默认配置' ||
        Boolean(profile.applicationIds?.length) ||
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

function hasNonDefaultDeviceDisplay(display: DeviceDisplaySettings | undefined): boolean {
  if (!display) return false
  return (
    display.brightness !== defaultDeviceDisplaySettings.brightness ||
    display.sleepTimeoutSec !== defaultDeviceDisplaySettings.sleepTimeoutSec ||
    display.showKeyToast !== defaultDeviceDisplaySettings.showKeyToast ||
    display.showProfileToast !== defaultDeviceDisplaySettings.showProfileToast
  )
}

function hasCustomProfileDisplay(display: ProfileDisplayConfig | undefined): boolean {
  if (!display) return false
  return display.mode === 'custom' || display.line1.length > 0 || display.line2.length > 0
}

function isValidDisplayLine(value: string): boolean {
  let runes = 0
  for (const ch of value) {
    runes += 1
    if (runes > 64) return false
    const code = ch.codePointAt(0)!
    if (code <= 0x1f || code === 0x7f || (code >= 0xd800 && code <= 0xdfff)) return false
  }
  return true
}

function portableInstance(instance: DeviceInstance): Record<string, unknown> {
  return {
    name: instance.name,
    enabled: instance.enabled,
    profiles: instance.profiles,
    activeProfileId: instance.activeProfileId,
    ...(instance.appProfileSwitching === undefined ? {} : { appProfileSwitching: instance.appProfileSwitching }),
    ...(instance.applicationProfiles === undefined ? {} : { applicationProfiles: instance.applicationProfiles }),
    ...(instance.audioGainDb === undefined ? {} : { audioGainDb: instance.audioGainDb }),
    ...(instance.cmiotA15RecordingMode === undefined ? {} : { cmiotA15RecordingMode: instance.cmiotA15RecordingMode }),
    ...(instance.display === undefined
      ? {}
      : {
          display: {
            brightness: instance.display.brightness,
            sleepTimeoutSec: instance.display.sleepTimeoutSec,
            showKeyToast: instance.display.showKeyToast,
            showProfileToast: instance.display.showProfileToast,
          },
        }),
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
    const support = getSupportPackages().find(item => item.kind === kind)
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
            applicationProfiles: [],
          }
    }
    const targetKey = legacyKind ? legacyKeys[legacyKind] : target!.id
    const profiles = legacyKind
      ? backup.profiles
          .filter(item => item.deviceId === legacyKind)
          .map(item => ({
            id: item.id,
            name: item.name,
            ...(item.applicationIds ? { applicationIds: [...item.applicationIds] } : {}),
            ...(item.quick ? { quick: true } : {}),
            ...(item.quick && item.promptMode ? { promptMode: true } : {}),
            behaviors: item.keys,
          }))
      : target!.profiles
    if (legacyKind === 'mouse' && config.appProfileSwitching !== undefined) {
      backup.applicationProfileSwitching = {
        ...backup.applicationProfileSwitching,
        mouse: config.appProfileSwitching,
      }
    }
    const restoredIdMap = new Map<string, string>()
    for (const item of profiles) {
      const prior = metadata[profileMetadataKey(targetKey, item.id)]
      if (prior?.restored_from?.device_config_id === document.id) {
        restoredIdMap.set(prior.restored_from.profile_id, item.id)
      }
    }
    const newlyRestored: (typeof profiles)[number][] = []
    for (const id of selected.profileIds) {
      const profile = config.profiles.find(item => item.id === id) as
        (DeviceInstance['profiles'][number] & { app_version?: string | null; applicationIds?: string[] }) | undefined
      if (!profile) throw new Error('所选云端方案已不存在，请刷新后重试')
      const already = profiles.find(item => {
        const prior = metadata[profileMetadataKey(targetKey, item.id)]
        return (
          prior?.restored_from?.device_config_id === document.id &&
          prior.restored_from.profile_id === profile.id &&
          prior.restored_content === profileContent(item) &&
          prior.source_content === profileContent(profile)
        )
      })
      if (already) {
        restoredIdMap.set(profile.id, already.id)
        continue
      }
      const restored = { ...structuredClone(profile), id: crypto.randomUUID() }
      restoredIdMap.set(profile.id, restored.id)
      newlyRestored.push(restored)
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
      profiles.push(restored)
      if (target) {
        if (target.display === undefined && config.display !== undefined)
          target.display = structuredClone(config.display)
        const bindings = target.applicationProfiles ?? []
        if (
          config.appProfileSwitching !== undefined &&
          config.applicationProfiles?.some(binding => binding.profileId === profile.id)
        )
          target.appProfileSwitching = config.appProfileSwitching
        target.applicationProfiles = [
          ...bindings,
          ...(config.applicationProfiles ?? [])
            .filter(
              binding =>
                binding.profileId === profile.id &&
                !bindings.some(item => item.application.id === binding.application.id),
            )
            .map(binding => ({ ...binding, profileId: restored.id })),
        ]
      }
      imported++
      if (legacyKind)
        backup.profiles.push({
          id: restored.id,
          name: restored.name,
          deviceId: legacyKind,
          ...(restored.applicationIds ? { applicationIds: [...restored.applicationIds] } : {}),
          ...(restored.quick ? { quick: true } : {}),
          ...(restored.quick && restored.promptMode ? { promptMode: true } : {}),
          keys: restored.behaviors,
        })
    }
    for (const restored of newlyRestored) {
      for (const triggers of Object.values(restored.behaviors)) {
        for (const trigger of triggerTypes) {
          triggers[trigger] = triggers[trigger].map(action =>
            action.type === 'quickOverlay' && restoredIdMap.has(action.profileId)
              ? { ...action, profileId: restoredIdMap.get(action.profileId)! }
              : action,
          )
        }
      }
      // The display name and local quickOverlay links belong to this local copy; keep the source content version.
      metadata[profileMetadataKey(targetKey, restored.id)].content = profileContent(restored)
      metadata[profileMetadataKey(targetKey, restored.id)].restored_content = profileContent(restored)
    }
    if (target) {
      if (!target.profiles.some(item => !item.quick)) {
        const firstNonQuick = config.profiles.find(item => !item.quick)
        if (firstNonQuick) {
          target.profiles.unshift({ ...structuredClone(firstNonQuick), id: crypto.randomUUID() })
        } else if (target.profiles[0]) {
          delete target.profiles[0].quick
          delete target.profiles[0].promptMode
        }
      }
      if (!target.activeProfileId || !target.profiles.some(item => item.id === target.activeProfileId && !item.quick)) {
        target.activeProfileId = (target.profiles.find(item => !item.quick) ?? target.profiles[0]).id
      }
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
  if (value.appProfileSwitching !== undefined && typeof value.appProfileSwitching !== 'boolean') return fail()
  if (value.applicationProfiles !== undefined && !Array.isArray(value.applicationProfiles)) return fail()
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
  if (value.display !== undefined) {
    if (!value.display || typeof value.display !== 'object' || Array.isArray(value.display)) return fail()
    const display = value.display as Record<string, unknown>
    if (
      Object.keys(display).some(
        key =>
          key !== 'brightness' && key !== 'sleepTimeoutSec' && key !== 'showKeyToast' && key !== 'showProfileToast',
      ) ||
      typeof display.brightness !== 'number' ||
      !Number.isInteger(display.brightness) ||
      display.brightness < 0 ||
      display.brightness > 100 ||
      typeof display.sleepTimeoutSec !== 'number' ||
      !Number.isInteger(display.sleepTimeoutSec) ||
      (display.sleepTimeoutSec !== 0 && (display.sleepTimeoutSec < 15 || display.sleepTimeoutSec > 3600)) ||
      typeof display.showKeyToast !== 'boolean' ||
      typeof display.showProfileToast !== 'boolean'
    )
      return fail()
  }
  const profileIds = new Set<string>()
  const applicationIds = new Set<string>()
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
    if (
      profile.applicationIds !== undefined &&
      (!Array.isArray(profile.applicationIds) || profile.applicationIds.some((id: unknown) => typeof id !== 'string'))
    )
      return fail()
    if (profile.quick !== undefined && typeof profile.quick !== 'boolean') return fail()
    if (profile.promptMode !== undefined && typeof profile.promptMode !== 'boolean') return fail()
    if (profile.display !== undefined) {
      if (!profile.display || typeof profile.display !== 'object' || Array.isArray(profile.display)) return fail()
      const pDisplay = profile.display as Record<string, unknown>
      if (
        Object.keys(pDisplay).some(key => key !== 'mode' && key !== 'line1' && key !== 'line2') ||
        (pDisplay.mode !== 'auto' && pDisplay.mode !== 'custom') ||
        typeof pDisplay.line1 !== 'string' ||
        !isValidDisplayLine(pDisplay.line1) ||
        typeof pDisplay.line2 !== 'string' ||
        !isValidDisplayLine(pDisplay.line2)
      )
        return fail()
    }
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
  if (Array.isArray(value.applicationProfiles)) {
    if (value.applicationProfiles.length > 128) return fail()
    for (const binding of value.applicationProfiles) {
      if (!binding || typeof binding !== 'object' || Array.isArray(binding)) return fail()
      const application = (binding as Record<string, unknown>).application
      const profileId = (binding as Record<string, unknown>).profileId
      if (
        !application ||
        typeof application !== 'object' ||
        Array.isArray(application) ||
        typeof profileId !== 'string' ||
        !profileIds.has(profileId)
      )
        return fail()
      const app = application as Record<string, unknown>
      if (
        typeof app.id !== 'string' ||
        !app.id ||
        typeof app.name !== 'string' ||
        !app.name.trim() ||
        typeof app.path !== 'string' ||
        !app.path.trim() ||
        applicationIds.has(app.id)
      )
        return fail()
      applicationIds.add(app.id)
    }
  }
  return portableInstance(value as DeviceInstance) as Pick<
    DeviceInstance,
    | 'name'
    | 'enabled'
    | 'profiles'
    | 'activeProfileId'
    | 'appProfileSwitching'
    | 'applicationProfiles'
    | 'audioGainDb'
    | 'cmiotA15RecordingMode'
    | 'display'
  >
}
