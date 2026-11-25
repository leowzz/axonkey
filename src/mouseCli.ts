import { createEmptyBehaviorMap, createBehavior } from './behaviorModel.ts'
import type { Behavior, InputId, TriggerType } from './behaviorModel.ts'
import { behaviorToCliBehavior, cliBehaviorToBehavior } from './cliContract.ts'
import type { CliPlatform } from './cliContract.ts'
import { devices } from './devices/index.ts'
import { snapshotDeviceProfiles } from './deviceProfiles.ts'
import { applySharedProfileSwitch, removeSharedProfileSwitch } from './profileNavigation.ts'
import type { ProfileState } from './profileNavigation.ts'
import { bindMouseApplication, deleteMouseProfile } from './mouseProfiles.ts'
import { InstanceCliError } from './devices/integration/instanceCli.ts'

export type MouseCliState = ProfileState & { globalProfileId: string; autoSwitching: boolean }

export async function processMouseCliRequest(
  method: string,
  params: Record<string, unknown>,
  state: MouseCliState,
  platform: CliPlatform,
  save: (state: MouseCliState) => Promise<void>,
): Promise<Record<string, unknown>> {
  const dryRun = booleanParam(params.dryRun, 'dryRun')
  const profiles = snapshotDeviceProfiles(state.profiles, state.activeProfileIds, state.behaviors)
  let next = { ...state, profiles }
  const mouse = profiles.filter(profile => profile.deviceId === 'mouse')
  const profileValue = stringParam(params.profile, 'profile')
  const profile = resolveProfile(profileValue || state.globalProfileId, mouse, state.globalProfileId)
  const identity = (item: typeof profile) => ({
    id: item.id,
    name: item.name,
    active: item.id === state.globalProfileId,
    ...(item.quick ? { quick: true } : {}),
    ...(item.quick && item.promptMode ? { promptMode: true } : {}),
  })
  const target = { device: 'mouse', profile: identity(profile) }
  let result: Record<string, unknown>
  if (method === 'preset.list') {
    return { device: 'mouse', instance: null, presets: [] }
  }
  if (method === 'preset.apply') {
    throw new InstanceCliError('invalid_target', '系统鼠标暂不支持预制配置文件')
  }
  if (method === 'profile.list')
    return {
      device: 'mouse',
      profiles: mouse.map(item => ({
        ...identity(item),
        ...(item.quick ? { trigger: findMouseQuickTrigger(mouse, item.id) } : {}),
        applicationIds: item.applicationIds ?? [],
      })),
      applicationProfileSwitching: state.autoSwitching,
    }
  if (method === 'profile.application-list')
    return {
      device: 'mouse',
      applicationProfileSwitching: state.autoSwitching,
      applications: mouse.flatMap(item => (item.applicationIds ?? []).map(id => ({ id, profile: identity(item) }))),
    }
  if (method === 'profile.create') {
    const name = stringParam(params.name, 'name')
    if (!name || name.length > 40) throw new InstanceCliError('invalid_arguments', '配置名称需要 1–40 个字符')
    if (mouse.some(item => item.name === name)) throw new InstanceCliError('invalid_target', '配置名称已存在')
    const quick = booleanParam(params.quick, 'quick')
    const promptMode = booleanParam(params.promptMode, 'promptMode')
    if (promptMode && !quick)
      throw new InstanceCliError('invalid_arguments', '纯 Prompt 模式仅适用于快捷交互配置（--quick）')
    const behaviors = createEmptyBehaviorMap()
    if (!quick) {
      for (const input of devices.find(device => device.id === 'mouse')!.inputIds)
        for (const trigger of triggers)
          behaviors[input][trigger] = profile.behaviors[input][trigger]
            .filter(behavior => behavior.type === 'switchProfile')
            .map(behavior => createBehavior({ ...behavior, id: undefined }))
    }
    const created = {
      id: crypto.randomUUID(),
      name,
      deviceId: 'mouse' as const,
      behaviors,
      ...(quick ? { quick: true } : {}),
      ...(quick && promptMode ? { promptMode: true } : {}),
    }
    next.profiles = [...profiles, created]
    if (!quick) next.globalProfileId = created.id
    result = {
      device: 'mouse',
      profile: { ...identity(created), active: !quick },
      previousActiveProfileId: state.globalProfileId,
    }
  } else if (method === 'profile.activate') {
    if (!profileValue) throw new InstanceCliError('invalid_arguments', '激活配置需要 --profile')
    if (profile.quick)
      throw new InstanceCliError('invalid_target', '快捷交互配置仅用于按键单次唤起，不能设为常驻生效配置')
    next.globalProfileId = profile.id
    result = {
      ...target,
      profile: { ...identity(profile), active: true },
      before: state.globalProfileId,
      after: profile.id,
    }
  } else if (method === 'profile.rename') {
    const name = stringParam(params.name, 'name')
    if (!name || name.length > 40) throw new InstanceCliError('invalid_arguments', '配置名称需要 1–40 个字符')
    if (mouse.some(item => item.id !== profile.id && item.name === name))
      throw new InstanceCliError('invalid_target', '配置名称已存在')
    next.profiles = profiles.map(item => (item.id === profile.id ? { ...item, name } : item))
    result = {
      device: 'mouse',
      before: profile.name,
      after: name,
      profile: { ...identity(profile), name },
    }
  } else if (method === 'profile.duplicate') {
    const requestedName = stringParam(params.name, 'name')
    if (requestedName.length > 40) throw new InstanceCliError('invalid_arguments', '配置名称需要 1–40 个字符')
    if (requestedName && mouse.some(item => item.name === requestedName))
      throw new InstanceCliError('invalid_target', '配置名称已存在')
    const asQuick = booleanParam(params.quick, 'quick') || Boolean(profile.quick)
    const nextName =
      requestedName ||
      nextMouseCopyName(
        mouse.map(item => item.name),
        `${profile.name} 副本`,
      )
    const cloned = {
      id: crypto.randomUUID(),
      name: nextName,
      deviceId: 'mouse' as const,
      behaviors: cloneMouseProfileBehaviors(profile.behaviors, asQuick),
      ...(asQuick ? { quick: true } : {}),
      ...(asQuick && profile.promptMode ? { promptMode: true } : {}),
    }
    next.profiles = [...profiles, cloned]
    if (!asQuick) next.globalProfileId = cloned.id
    result = {
      device: 'mouse',
      sourceProfileId: profile.id,
      profile: {
        id: cloned.id,
        name: cloned.name,
        active: !asQuick,
        ...(cloned.quick ? { quick: true } : {}),
        ...(cloned.quick && cloned.promptMode ? { promptMode: true } : {}),
      },
      previousActiveProfileId: state.globalProfileId,
    }
  } else if (method === 'profile.delete') {
    if (!profileValue) throw new InstanceCliError('invalid_arguments', '删除配置需要 --profile')
    if (!booleanParam(params.yes, 'yes')) throw new InstanceCliError('invalid_arguments', '删除配置需要 --yes')
    if (!profile.quick && mouse.filter(item => !item.quick).length <= 1)
      throw new InstanceCliError('invalid_target', '至少需要保留一个常规配置文件')
    const deleted = deleteMouseProfile(profiles, profile.id, state.globalProfileId)
    next.profiles = profile.quick ? removeMouseQuickReferences(deleted.profiles, profile.id) : deleted.profiles
    next.globalProfileId = deleted.globalProfileId
    result = {
      device: 'mouse',
      deleted: identity(profile),
      activeProfileId: deleted.globalProfileId,
    }
  } else if (method === 'profile.prompt-mode') {
    if (!profileValue) throw new InstanceCliError('invalid_arguments', '设置纯 Prompt 模式需要 --profile')
    if (typeof params.enabled !== 'boolean')
      throw new InstanceCliError('invalid_arguments', '设置纯 Prompt 模式需要 --on 或 --off')
    if (!profile.quick) throw new InstanceCliError('invalid_target', '纯 Prompt 模式仅适用于快捷交互配置')
    const promptMode = params.enabled === true
    next.profiles = profiles.map(item => {
      if (item.id !== profile.id) return item
      if (promptMode) return { ...item, promptMode: true }
      const { promptMode: _removed, ...rest } = item
      return rest
    })
    result = {
      device: 'mouse',
      promptMode,
      profile: {
        id: profile.id,
        name: profile.name,
        active: profile.id === state.globalProfileId,
        quick: true,
        ...(promptMode ? { promptMode: true } : {}),
      },
    }
  } else if (method === 'profile.application-set' || method === 'profile.application-remove') {
    const application = stringParam(params.application, 'application')
    if (!application) throw new InstanceCliError('invalid_arguments', '应用绑定需要 --application')
    if (method === 'profile.application-set' && !profileValue)
      throw new InstanceCliError('invalid_arguments', '应用配置绑定需要 --profile')
    if (method === 'profile.application-remove' && !mouse.some(item => item.applicationIds?.includes(application)))
      throw new InstanceCliError('invalid_target', '找不到指定的应用绑定')
    next.profiles = bindMouseApplication(
      profiles,
      application,
      method === 'profile.application-set' ? profile.id : null,
    )
    if (method === 'profile.application-set' && !mouse.some(item => item.applicationIds?.length))
      next.autoSwitching = true
    result = { ...target, application }
  } else if (method === 'profile.application-toggle') {
    if (typeof params.enabled !== 'boolean')
      throw new InstanceCliError('invalid_arguments', '应用自动切换需要 --on 或 --off')
    next.autoSwitching = params.enabled
    result = { device: 'mouse', applicationProfileSwitching: next.autoSwitching }
  } else {
    const [prefix, action, extra] = method.split('.')
    if (
      extra !== undefined ||
      !['mapping', 'shortcut'].includes(prefix) ||
      !['list', 'get', 'set', 'clear'].includes(action)
    )
      throw new InstanceCliError('invalid_arguments', '不支持的 CLI 操作：' + method)
    const inputs = devices.find(device => device.id === 'mouse')!.inputIds
    const inputValue = stringParam(params.button ?? params.input, 'button')
    if (action === 'list' && !inputValue)
      return {
        ...target,
        mappings: inputs.flatMap(button =>
          triggers.map(trigger => ({
            button,
            trigger,
            actions: profile.behaviors[button][trigger].map(item => behaviorToCliBehavior(item, platform)),
          })),
        ),
      }
    const input = inputValue as InputId
    if (!inputs.includes(input)) throw new InstanceCliError('invalid_target', '鼠标没有按键：' + input)
    const trigger = triggerParam(params.trigger)
    const before = profile.behaviors[input][trigger].map(item => behaviorToCliBehavior(item, platform))
    const mappingTarget = { ...target, button: input, trigger }
    if (action === 'get' || action === 'list') return { ...mappingTarget, actions: before }
    if (action === 'clear' && !booleanParam(params.yes, 'yes'))
      throw new InstanceCliError('invalid_arguments', '清除映射需要 --yes')
    const raw =
      action === 'clear'
        ? []
        : prefix === 'shortcut'
          ? [{ type: 'shortcut', keys: params.keys }]
          : (params.sequence ?? params.actions ?? (params.action === undefined ? undefined : [params.action]))
    if (!Array.isArray(raw)) throw new InstanceCliError('invalid_behavior', '行为序列必须为数组')
    const normalized = raw.map(item => cliBehaviorToBehavior(item, platform))
    if (normalized.some(item => item === null)) throw new InstanceCliError('invalid_behavior', '行为格式不正确')
    const sequence = normalized as Behavior[]
    const switchBehavior = sequence.find(item => item.type === 'switchProfile')
    if (switchBehavior && sequence.length !== 1)
      throw new InstanceCliError('invalid_behavior', '切换配置必须是唯一行为')
    const quickBehavior = sequence.find(item => item.type === 'quickOverlay')
    if (quickBehavior) {
      if (sequence.length !== 1) throw new InstanceCliError('invalid_behavior', '快捷交互窗必须是唯一行为')
      const targetProfile = resolveProfile(quickBehavior.profileId, mouse, state.globalProfileId)
      quickBehavior.profileId = targetProfile.id
    }
    const clipboardBehavior = sequence.find(item => item.type === 'clipboardOverlay')
    if (clipboardBehavior && sequence.length !== 1)
      throw new InstanceCliError('invalid_behavior', '剪贴板浮窗必须是该触发方式的唯一行为')
    if (switchBehavior) next = { ...next, ...applySharedProfileSwitch(next, input, trigger, switchBehavior) }
    else if (profile.behaviors[input][trigger].some(item => item.type === 'switchProfile'))
      next = {
        ...next,
        ...removeSharedProfileSwitch(next, {
          profileId: profile.id,
          inputId: input,
          triggers: [trigger],
          sequences: { ...profile.behaviors[input], [trigger]: sequence },
        }),
      }
    else
      next.profiles = profiles.map(item =>
        item.id === profile.id
          ? {
              ...item,
              behaviors: { ...item.behaviors, [input]: { ...item.behaviors[input], [trigger]: sequence } },
            }
          : item,
      )
    const affectedProfiles = next.profiles.flatMap((candidate, index) => {
      if (candidate.deviceId !== 'mouse') return []
      const previous = profiles[index].behaviors[input][trigger].map(item => behaviorToCliBehavior(item, platform))
      const after = candidate.behaviors[input][trigger].map(item => behaviorToCliBehavior(item, platform))
      return JSON.stringify(previous) === JSON.stringify(after)
        ? []
        : [{ id: candidate.id, name: candidate.name, before: previous, after }]
    })
    result = {
      ...mappingTarget,
      before,
      after: sequence.map(item => behaviorToCliBehavior(item, platform)),
      affectedProfiles,
    }
  }
  if (dryRun) return { ...result, dryRun: true }
  await save(next)
  return { ...result, applied: true, saved: true }
}

const triggers: TriggerType[] = ['click', 'doubleClick', 'longPress']

function stringParam(value: unknown, name: string): string {
  if (value === undefined) return ''
  if (typeof value !== 'string' || !value.trim())
    throw new InstanceCliError('invalid_arguments', name + ' 必须是非空字符串')
  return value.trim()
}

function booleanParam(value: unknown, name: string): boolean {
  if (value !== undefined && typeof value !== 'boolean')
    throw new InstanceCliError('invalid_arguments', name + ' 必须是布尔值')
  return value === true
}

function triggerParam(value: unknown): TriggerType {
  if (value === undefined) return 'click'
  if (value === 'double-click') return 'doubleClick'
  if (value === 'long-press') return 'longPress'
  if (triggers.includes(value as TriggerType)) return value as TriggerType
  throw new InstanceCliError('invalid_target', '不支持的触发方式')
}

function resolveProfile(value: string, profiles: ProfileState['profiles'], globalId: string) {
  const byId = profiles.find(item => item.id === (value === 'active' ? globalId : value))
  if (byId) return byId
  const matches = profiles.filter(item => item.name === value)
  if (matches.length !== 1) throw new InstanceCliError('invalid_target', '找不到唯一的指定配置文件，请使用配置 ID')
  return matches[0]
}

function nextMouseCopyName(existingNames: readonly string[], preferred: string): string {
  const clean = preferred.trim().slice(0, 40) || '配置 副本'
  const taken = new Set(existingNames)
  if (!taken.has(clean)) return clean
  for (let index = 2; index < 1000; index += 1) {
    const suffix = ` ${index}`
    const candidate = `${clean.slice(0, 40 - suffix.length)}${suffix}`
    if (!taken.has(candidate)) return candidate
  }
  return clean
}

function cloneMouseProfileBehaviors(source: ProfileState['profiles'][number]['behaviors'], stripSwitch: boolean) {
  const cloned = createEmptyBehaviorMap()
  for (const input of devices.find(device => device.id === 'mouse')!.inputIds) {
    for (const trigger of triggers) {
      cloned[input][trigger] = source[input][trigger]
        .filter(behavior => !stripSwitch || behavior.type !== 'switchProfile')
        .map(behavior => createBehavior({ ...behavior, id: undefined }))
    }
  }
  return cloned
}

function findMouseQuickTrigger(mouseProfiles: readonly ProfileState['profiles'][number][], quickProfileId: string) {
  for (const candidate of mouseProfiles) {
    if (candidate.quick || candidate.id === quickProfileId) continue
    for (const [inputId, sequences] of Object.entries(candidate.behaviors)) {
      if (!sequences || typeof sequences !== 'object') continue
      for (const trigger of triggers) {
        if (
          sequences[trigger]?.some(
            step => step.enabled && step.type === 'quickOverlay' && step.profileId === quickProfileId,
          )
        ) {
          return { profileId: candidate.id, inputId, trigger }
        }
      }
    }
  }
  return null
}

function removeMouseQuickReferences(
  profiles: ProfileState['profiles'],
  quickProfileId: string,
): ProfileState['profiles'] {
  return profiles.map(item => {
    if (item.deviceId !== 'mouse' || item.quick) return item
    let changed = false
    const nextBehaviors = { ...item.behaviors }
    for (const input of devices.find(device => device.id === 'mouse')!.inputIds) {
      const seq = nextBehaviors[input]
      let seqChanged = false
      const updated = { ...seq }
      for (const trigger of triggers) {
        const filtered = seq[trigger].filter(
          step => !(step.type === 'quickOverlay' && step.profileId === quickProfileId),
        )
        if (filtered.length !== seq[trigger].length) {
          updated[trigger] = filtered
          seqChanged = true
        }
      }
      if (seqChanged) {
        nextBehaviors[input] = updated
        changed = true
      }
    }
    return changed ? { ...item, behaviors: nextBehaviors } : item
  })
}
