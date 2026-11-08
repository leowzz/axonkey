import { createEmptyBehaviorMap, createBehavior } from './behaviorModel.ts'
import type { Behavior, InputId, TriggerType } from './behaviorModel.ts'
import { behaviorToCliBehavior, cliBehaviorToBehavior } from './cliContract.ts'
import type { CliPlatform } from './cliContract.ts'
import { devices } from './devices/index.ts'
import { snapshotDeviceProfiles } from './deviceProfiles.ts'
import { applySharedProfileSwitch, removeSharedProfileSwitch } from './profileNavigation.ts'
import type { ProfileState } from './profileNavigation.ts'
import { bindMouseApplication } from './mouseProfiles.ts'
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
  })
  const target = { device: 'mouse', profile: identity(profile) }
  let result: Record<string, unknown>
  if (method === 'profile.list')
    return {
      device: 'mouse',
      profiles: mouse.map(item => ({ ...identity(item), applicationIds: item.applicationIds ?? [] })),
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
    const behaviors = createEmptyBehaviorMap()
    for (const input of devices.find(device => device.id === 'mouse')!.inputIds)
      for (const trigger of triggers)
        behaviors[input][trigger] = profile.behaviors[input][trigger]
          .filter(behavior => behavior.type === 'switchProfile')
          .map(behavior => createBehavior({ ...behavior, id: undefined }))
    const created = { id: crypto.randomUUID(), name, deviceId: 'mouse' as const, behaviors }
    next.profiles = [...profiles, created]
    next.globalProfileId = created.id
    result = {
      device: 'mouse',
      profile: { ...identity(created), active: true },
      previousActiveProfileId: state.globalProfileId,
    }
  } else if (method === 'profile.activate') {
    if (!profileValue) throw new InstanceCliError('invalid_arguments', '激活配置需要 --profile')
    next.globalProfileId = profile.id
    result = {
      ...target,
      profile: { ...identity(profile), active: true },
      before: state.globalProfileId,
      after: profile.id,
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
    result = { ...mappingTarget, before, after: sequence.map(item => behaviorToCliBehavior(item, platform)) }
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
