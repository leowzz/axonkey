import type { Behavior, TriggerType } from '../../behaviorModel.ts'
import { behaviorToCliBehavior, cliBehaviorToBehavior } from '../../cliContract.ts'
import type { CliPlatform } from '../../cliContract.ts'
import { emptyTriggers, instanceState, packageFor } from './model.ts'
import type { DeviceInstance, DeviceSnapshot, InstanceProfile } from './model.ts'
import type { Application } from '../../applications.ts'
import {
  addInstanceProfile,
  applyInstanceProfileSwitch,
  removeInstanceProfileSwitch,
  updateInstanceSequence,
} from './instanceProfiles.ts'
import { setApplicationProfile } from './applicationProfiles.ts'

export class InstanceCliError extends Error {
  code: string

  constructor(code: string, message: string) {
    super(message)
    this.code = code
  }
}

type Context = {
  platform: CliPlatform
  snapshot: DeviceSnapshot
  update: (id: string, change: (instance: DeviceInstance) => DeviceInstance) => Promise<DeviceSnapshot>
}

export function normalizeCliDeviceSelector(value: unknown): string {
  const device = stringParam(value, 'device').toLowerCase()
  const aliases: Record<string, string> = {
    remote: 'rc003',
    xiaomi: 'rc003',
    cmiot: 'cmiota15',
    'xm-bt-29': 'xmbt29',
    'rc-313': 'rc313',
    'rcu-r5': 'obercur5',
    xbox: 'xboxbluetooth',
  }
  return aliases[device] ?? device
}

export function resolveCliInstance(params: Record<string, unknown>, snapshot: DeviceSnapshot): DeviceInstance {
  const id = stringParam(params.instance, 'instance')
  const device = normalizeCliDeviceSelector(params.device)
  const matches = snapshot.store.instances.filter(instance =>
    id
      ? instance.id === id &&
        (!device || instance.id.toLowerCase() === device || instance.kind.toLowerCase() === device)
      : !device || instance.id.toLowerCase() === device || instance.kind.toLowerCase() === device,
  )
  if (matches.length === 0) throw new InstanceCliError('invalid_target', '找不到设备实例，请先运行 device list')
  if (matches.length > 1)
    throw new InstanceCliError('invalid_target', '有多个符合条件的设备，请用 --instance 指定 device list 返回的实例 ID')
  return matches[0]
}

export async function processInstanceCliRequest(
  method: string,
  params: Record<string, unknown>,
  { platform, snapshot, update }: Context,
): Promise<Record<string, unknown>> {
  if (snapshot.error) throw new InstanceCliError('app_error', snapshot.error)
  const dryRun = booleanParam(params.dryRun, 'dryRun')
  if (method === 'device.list') {
    return {
      revision: snapshot.store.revision,
      devices: snapshot.store.instances.map(instance => ({
        ...instanceIdentity(instance),
        enabled: instance.enabled,
        binding: instance.binding,
        connected: snapshot.discovered.some(device => device.id === instance.binding && device.connected),
        state: instanceState(instance, snapshot) ?? 'unbound',
        error: snapshot.runtime[instance.id]?.error ?? null,
        activeProfile: profileIdentity(instance, resolveProfile(instance, '')),
      })),
    }
  }
  if (!['profile.list', 'profile.create', 'profile.activate', 'profile.application-list', 'profile.application-set', 'profile.application-remove', 'profile.application-toggle', ...mappingMethods].includes(method))
    throw new InstanceCliError('invalid_arguments', '不支持的 CLI 操作：' + method)
  const instance = resolveCliInstance(params, snapshot)
  const target = { device: instance.kind, instance: instanceIdentity(instance), revision: snapshot.store.revision }
  if (method === 'profile.list') {
    return {
      ...target,
      profiles: instance.profiles.map(profile => ({
        ...profileIdentity(instance, profile),
        applications: (instance.applicationProfiles ?? [])
          .filter(binding => binding.profileId === profile.id)
          .map(binding => binding.application),
      })),
      applicationProfileSwitching: instance.appProfileSwitching === true,
    }
  }
  if (method === 'profile.application-list') {
    return {
      ...target,
      applicationProfileSwitching: instance.appProfileSwitching === true,
      applications: (instance.applicationProfiles ?? []).map(binding => ({
        ...binding.application,
        profile: profileIdentity(instance, resolveProfile(instance, binding.profileId)),
      })),
    }
  }
  if (method === 'profile.application-set') {
    const application = applicationParam(params)
    const profileValue = stringParam(params.profile, 'profile')
    if (!profileValue) throw new InstanceCliError('invalid_arguments', '应用配置绑定需要 --profile')
    const profile = resolveProfile(instance, profileValue)
    const change = (current: DeviceInstance) =>
      setApplicationProfile(current, application, profile.id)

    if (dryRun)
      return { ...target, dryRun: true, application, profile: profileIdentity(instance, profile) }
    const saved = await update(instance.id, change)
    const next = saved.store.instances.find(item => item.id === instance.id)!
    return {
      ...target,
      revision: saved.store.revision,
      applied: true,
      saved: true,
      application,
      profile: profileIdentity(next, resolveProfile(next, profile.id)),
    }
  }
  if (method === 'profile.application-remove') {
    const applicationId = stringParam(params.application, 'application')
    const change = (current: DeviceInstance) => ({
      ...current,
      applicationProfiles: (current.applicationProfiles ?? []).filter(binding => binding.application.id !== applicationId),
    })
    if (dryRun) return { ...target, dryRun: true, application: applicationId }
    const saved = await update(instance.id, change)
    return { ...target, revision: saved.store.revision, applied: true, saved: true, application: applicationId }
  }
  if (method === 'profile.application-toggle') {
    if (typeof params.enabled !== 'boolean')
      throw new InstanceCliError('invalid_arguments', '应用自动切换需要 --on 或 --off')
    const change = (current: DeviceInstance) => ({ ...current, appProfileSwitching: params.enabled === true })
    if (dryRun) return { ...target, dryRun: true, applicationProfileSwitching: params.enabled === true }
    const saved = await update(instance.id, change)
    return {
      ...target,
      revision: saved.store.revision,
      applied: true,
      saved: true,
      applicationProfileSwitching: params.enabled === true,
    }
  }
  const profileValue = stringParam(params.profile, 'profile')
  if (method === 'profile.create') {
    const name = stringParam(params.name, 'name')
    if (!name) throw new InstanceCliError('invalid_arguments', '新建配置需要 --name')
    const create = (current: DeviceInstance) => {
      if (current.profiles.some(profile => profile.name === name))
        throw new InstanceCliError('invalid_target', '配置名称已存在：' + name)
      const next = addInstanceProfile(current, false)
      next.profiles[next.profiles.length - 1].name = name
      return next
    }
    const saved = dryRun ? null : await update(instance.id, create)
    const next = saved ? saved.store.instances.find(i => i.id === instance.id)! : create(instance)
    return {
      ...target,
      ...(dryRun ? { dryRun: true } : { applied: true, saved: true }),
      revision: saved?.store.revision ?? snapshot.store.revision,
      profile: profileIdentity(next, resolveProfile(next, '')),
      previousActiveProfileId: instance.activeProfileId,
    }
  }
  const profile = resolveProfile(instance, profileValue)
  if (method === 'profile.activate') {
    if (!profileValue) throw new InstanceCliError('invalid_arguments', '激活配置需要 --profile')
    if (dryRun)
      return {
        ...target,
        dryRun: true,
        before: instance.activeProfileId,
        after: profile.id,
        profile: { ...profileIdentity(instance, profile), active: true },
      }
    const saved = await update(instance.id, current => {
      const selected = resolveProfile(current, profile.id)
      return { ...current, activeProfileId: selected.id }
    })
    const next = saved.store.instances.find(i => i.id === instance.id)!
    return {
      ...target,
      revision: saved.store.revision,
      applied: true,
      saved: true,
      profile: profileIdentity(next, resolveProfile(next, profile.id)),
    }
  }
  const action = method.split('.')[1]
  const input = params.button ?? params.input
  if (action === 'list' && input === undefined) {
    return {
      ...target,
      profile: profileIdentity(instance, profile),
      mappings: packageFor(instance.kind).inputs.flatMap(input =>
        triggers.map(trigger => ({
          button: input.id,
          trigger,
          actions: publicSequence(profile.behaviors[input.id]?.[trigger] ?? [], platform),
        })),
      ),
    }
  }
  const inputId = stringParam(input, 'button')
  if (!packageFor(instance.kind).inputs.some(input => input.id === inputId))
    throw new InstanceCliError('invalid_target', '设备 ' + instance.kind + ' 没有按键：' + inputId)
  const trigger = triggerParam(params.trigger)
  const sequence = profile.behaviors[inputId]?.[trigger] ?? []
  const before = publicSequence(sequence, platform)
  const mappingTarget = { ...target, profile: profileIdentity(instance, profile), button: inputId, trigger }
  if (action === 'get' || action === 'list') return { ...mappingTarget, actions: before }
  if (action === 'clear' && !booleanParam(params.yes, 'yes'))
    throw new InstanceCliError('invalid_arguments', '清除映射需要 --yes')
  const raw =
    action === 'clear'
      ? []
      : method.startsWith('shortcut.')
        ? [{ type: 'shortcut', keys: params.keys }]
        : (params.sequence ?? params.actions ?? (params.action === undefined ? undefined : [params.action]))
  if (!Array.isArray(raw)) throw new InstanceCliError('invalid_behavior', '行为序列必须为数组，请参考 capabilities')
  const nextSequence = raw.map(item => cliBehaviorToBehavior(item, platform))
  if (nextSequence.some(item => item === null))
    throw new InstanceCliError('invalid_behavior', '行为格式不正确，请参考 capabilities')
  const behaviors = nextSequence as Behavior[]
  const switchBehavior = behaviors.find(behavior => behavior.type === 'switchProfile')
  if (switchBehavior && behaviors.length !== 1)
    throw new InstanceCliError('invalid_behavior', '切换配置必须是该触发方式的唯一行为，并会应用到设备全部配置')
  const change = (current: DeviceInstance) => {
    const selected = resolveProfile(current, profile.id)
    const sequences = { ...(selected.behaviors[inputId] ?? emptyTriggers()), [trigger]: behaviors }
    if (switchBehavior?.type === 'switchProfile')
      return applyInstanceProfileSwitch(current, inputId, trigger, switchBehavior)
    if (selected.behaviors[inputId]?.[trigger].some(behavior => behavior.type === 'switchProfile'))
      return removeInstanceProfileSwitch(current, profile.id, inputId, [trigger], sequences)
    return updateInstanceSequence(current, profile.id, inputId, sequences)
  }
  const proposed = change(instance)
  const affectedProfiles = proposed.profiles.flatMap((candidate, index) => {
    const previous = publicSequence(instance.profiles[index].behaviors[inputId]?.[trigger] ?? [], platform)
    const after = publicSequence(candidate.behaviors[inputId]?.[trigger] ?? [], platform)
    return JSON.stringify(previous) === JSON.stringify(after)
      ? []
      : [{ id: candidate.id, name: candidate.name, before: previous, after }]
  })
  if (dryRun)
    return { ...mappingTarget, dryRun: true, before, after: publicSequence(behaviors, platform), affectedProfiles }
  const saved = await update(instance.id, change)
  const next = saved.store.instances.find(i => i.id === instance.id)!
  return {
    ...mappingTarget,
    revision: saved.store.revision,
    profile: profileIdentity(next, resolveProfile(next, profile.id)),
    applied: true,
    saved: true,
    before,
    after: publicSequence(resolveProfile(next, profile.id).behaviors[inputId]?.[trigger] ?? [], platform),
    affectedProfiles,
  }
}

const triggers: TriggerType[] = ['click', 'doubleClick', 'longPress']
const mappingMethods = ['mapping', 'shortcut'].flatMap(prefix =>
  ['list', 'get', 'set', 'clear'].map(action => prefix + '.' + action),
)

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
  throw new InstanceCliError('invalid_target', '不支持的触发方式：' + String(value))
}

function resolveProfile(instance: DeviceInstance, value: string): InstanceProfile {
  const id = !value || value === 'active' ? instance.activeProfileId : value
  const byId = instance.profiles.find(profile => profile.id === id)
  if (byId) return byId
  const matches = instance.profiles.filter(profile => profile.name === value)
  if (matches.length !== 1) throw new InstanceCliError('invalid_target', '找不到唯一的指定配置文件，请使用配置 ID')
  return matches[0]
}

function instanceIdentity(instance: DeviceInstance) {
  return { id: instance.id, kind: instance.kind, name: instance.name }
}

function profileIdentity(instance: DeviceInstance, profile: InstanceProfile) {
  return { id: profile.id, name: profile.name, active: profile.id === instance.activeProfileId }
}

function publicSequence(sequence: Behavior[], platform: CliPlatform) {
  return sequence.map(behavior => behaviorToCliBehavior(behavior, platform))
}

function applicationParam(params: Record<string, unknown>): Application {
  const id = stringParam(params.application, 'application')
  const name = stringParam(params.applicationName, 'application-name') || id
  const path = stringParam(params.applicationPath, 'application-path') || id
  return { id, name, path }
}
