import type { Behavior, TriggerBehaviors, TriggerType } from '../../behaviorModel.ts'
import { behaviorToCliBehavior, cliBehaviorToBehavior } from '../../cliContract.ts'
import type { CliPlatform } from '../../cliContract.ts'
import type { CatalogDeviceModel } from '../../cloud/deviceModelCatalog.ts'
import { emptyTriggers, getSupportPackages, instanceState, packageFor } from './model.ts'
import type { DeviceInstance, DeviceSnapshot, InstanceProfile } from './model.ts'
import type { Application } from '../../applications.ts'
import {
  addInstanceProfile,
  addQuickInstanceProfile,
  applyInstanceProfileSwitch,
  bindQuickOverlayTrigger,
  deleteInstanceProfile,
  findQuickOverlayTriggerBinding,
  nextQuickProfileName,
  removeInstanceProfileSwitch,
  replaceInstanceProfileBehaviors,
  updateInstanceSequence,
} from './instanceProfiles.ts'
import { setApplicationProfile } from './applicationProfiles.ts'
import {
  clonePresetBehaviors,
  countConfiguredInputs,
  getPresetsForDevice,
  materializePresetToProfile,
  summarizePresetHighlights,
} from '../bundledPresets.ts'

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
  catalogModels?: ReadonlyMap<string, CatalogDeviceModel>
}

export function normalizeCliDeviceSelector(value: unknown): string {
  const device = stringParam(value, 'device').toLowerCase()
  if (!device) return ''
  const aliases: Record<string, string> = {
    remote: 'rc003',
    xiaomi: 'rc003',
    cmiot: 'cmiota15',
    'cmiot-a15': 'cmiota15',
    a15: 'cmiota15',
    'xm-bt-29': 'xmbt29',
    'rc-313': 'rc313',
    'rcu-r5': 'obercur5',
    'obe-rcu-r5': 'obercur5',
    obe_rcu_r5: 'obercur5',
    xbox: 'xboxbluetooth',
    rc802a: 'tclrc802a',
    'tcl-rc802a': 'tclrc802a',
    rc902n: 'tclrc902n',
    'tcl-rc902n': 'tclrc902n',
    rc902v: 'tclrc902v',
    'tcl-rc902v': 'tclrc902v',
    sony: 'rmftx800c',
    tx800c: 'rmftx800c',
    'rmf-tx800c': 'rmftx800c',
    'sony-rmf-tx800c': 'rmftx800c',
    rcf3b65: 'hisensercf3b65',
    'hisense-rcf3b65': 'hisensercf3b65',
    'db1-r': 'phicommdb1r',
    db1r: 'phicommdb1r',
    'phicomm-db1-r': 'phicommdb1r',
    'rc-001a': 'oneplusrc001a',
    rc001a: 'oneplusrc001a',
    'oneplus-rc-001a': 'oneplusrc001a',
    'oneplus-rc': 'oneplusrc001a',
    kivo: 'kivok18lite',
    k18: 'kivok18lite',
    'k18-lite': 'kivok18lite',
    'kivo-k18-lite': 'kivok18lite',
    g17: 'g17touch',
    'g17-touch': 'g17touch',
  }
  if (aliases[device]) return aliases[device]
  if (device === 'mouse') return 'mouse'
  const packages = getSupportPackages()
  const exact = packages.find(pkg => pkg.kind.toLowerCase() === device)
  if (exact) return exact.kind.toLowerCase()
  const compact = device.replace(/[-_\s]+/g, '')
  const matches = packages.filter(pkg =>
    [pkg.kind, pkg.model, pkg.name].some(candidate => candidate.toLowerCase().replace(/[-_\s]+/g, '') === compact),
  )
  return matches.length === 1 ? matches[0].kind.toLowerCase() : device
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
  { platform, snapshot, update, catalogModels }: Context,
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
        effectiveProfile: profileIdentity(
          instance,
          resolveProfile(instance, snapshot.runtime[instance.id]?.effectiveProfileId ?? ''),
        ),
      })),
    }
  }
  if (method === 'preset.list') {
    const selector = normalizeCliDeviceSelector(params.device)
    let instance: DeviceInstance | null = null
    let kind: string
    if (params.instance !== undefined || !selector) {
      instance = resolveCliInstance(params, snapshot)
      kind = instance.kind
    } else if (selector === 'mouse') {
      return { device: 'mouse', instance: null, presets: [] }
    } else {
      const pkg = getSupportPackages().find(item => item.kind.toLowerCase() === selector)
      if (!pkg) {
        instance = resolveCliInstance(params, snapshot)
        kind = instance.kind
      } else {
        kind = pkg.kind
        const matchedInstances = snapshot.store.instances.filter(item => item.kind === kind)
        if (matchedInstances.length === 1) instance = matchedInstances[0]
      }
    }
    const pkg = packageFor(kind)
    const presets = getPresetsForDevice(kind, catalogModels?.get(kind) ?? null, platform)
    return {
      device: kind,
      instance: instance ? instanceIdentity(instance) : null,
      presets: presets.map(preset => ({
        id: preset.id,
        slug: preset.slug,
        name: preset.name,
        description: preset.description,
        source: preset.source,
        platform: preset.platform,
        isDefault: preset.isDefault,
        quick: preset.quick,
        promptMode: preset.promptMode,
        configuredKeyCount: countConfiguredInputs(preset.behaviors),
        highlights: summarizePresetHighlights(preset, pkg.inputs, platform),
      })),
    }
  }
  if (
    ![
      'device.toggle',
      'preset.apply',
      'profile.list',
      'profile.create',
      'profile.activate',
      'profile.rename',
      'profile.duplicate',
      'profile.delete',
      'profile.prompt-mode',
      'profile.application-list',
      'profile.application-set',
      'profile.application-remove',
      'profile.application-toggle',
      ...mappingMethods,
    ].includes(method)
  )
    throw new InstanceCliError('invalid_arguments', '不支持的 CLI 操作：' + method)
  const instance = resolveCliInstance(params, snapshot)
  const target = { device: instance.kind, instance: instanceIdentity(instance), revision: snapshot.store.revision }
  if (method === 'device.toggle') {
    if (typeof params.enabled !== 'boolean')
      throw new InstanceCliError('invalid_arguments', '启用或停用设备需要 --on 或 --off')
    const nextEnabled = params.enabled === true
    if (dryRun) return { ...target, dryRun: true, before: instance.enabled, enabled: nextEnabled }
    const saved = await update(instance.id, current => ({ ...current, enabled: nextEnabled }))
    return { ...target, revision: saved.store.revision, applied: true, saved: true, enabled: nextEnabled }
  }
  if (method === 'profile.list') {
    return {
      ...target,
      profiles: instance.profiles.map(profile => ({
        ...profileIdentity(instance, profile),
        ...(profile.quick ? { trigger: findQuickOverlayTriggerBinding(instance, profile.id) } : {}),
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
    const application = applicationParam(params, instance)
    const profileValue = stringParam(params.profile, 'profile')
    if (!profileValue) throw new InstanceCliError('invalid_arguments', '应用配置绑定需要 --profile')
    const profile = resolveProfile(instance, profileValue)
    const change = (current: DeviceInstance) => setApplicationProfile(current, application, profile.id)

    if (dryRun) return { ...target, dryRun: true, application, profile: profileIdentity(instance, profile) }
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
    if (!applicationId) throw new InstanceCliError('invalid_arguments', '移除应用绑定需要 --application')
    if (!instance.applicationProfiles?.some(binding => binding.application.id === applicationId))
      throw new InstanceCliError('invalid_target', '找不到指定的应用绑定')
    const change = (current: DeviceInstance) => ({
      ...current,
      applicationProfiles: (current.applicationProfiles ?? []).filter(
        binding => binding.application.id !== applicationId,
      ),
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
    if (!name || name.length > 40) throw new InstanceCliError('invalid_arguments', '新建配置需要 1–40 个字符的 --name')
    const quick = booleanParam(params.quick, 'quick')
    const promptMode = booleanParam(params.promptMode, 'promptMode')
    if (promptMode && !quick)
      throw new InstanceCliError('invalid_arguments', '纯 Prompt 模式仅适用于快捷交互配置（--quick）')
    const create = (current: DeviceInstance) => {
      if (current.profiles.some(profile => profile.name === name))
        throw new InstanceCliError('invalid_target', '配置名称已存在：' + name)
      if (quick) {
        const created = addQuickInstanceProfile(current, name)
        if (!promptMode) return created.instance
        return {
          ...created.instance,
          profiles: created.instance.profiles.map(item =>
            item.id === created.profileId ? { ...item, promptMode: true } : item,
          ),
        }
      }
      const next = addInstanceProfile(current, false)
      next.profiles[next.profiles.length - 1].name = name
      return next
    }
    const saved = dryRun ? null : await update(instance.id, create)
    const next = saved ? saved.store.instances.find(i => i.id === instance.id)! : create(instance)
    const createdProfile = next.profiles[next.profiles.length - 1]
    return {
      ...target,
      ...(dryRun ? { dryRun: true } : { applied: true, saved: true }),
      revision: saved?.store.revision ?? snapshot.store.revision,
      profile: profileIdentity(next, quick ? createdProfile : resolveProfile(next, '')),
      previousActiveProfileId: instance.activeProfileId,
    }
  }
  if (method === 'preset.apply') {
    const presetSelector = stringParam(params.preset, 'preset')
    if (!presetSelector) throw new InstanceCliError('invalid_arguments', '套用预制配置需要 --preset')
    const mode = stringParam(params.mode, 'mode') || 'copy'
    if (mode !== 'copy' && mode !== 'overwrite')
      throw new InstanceCliError('invalid_arguments', '--mode 仅支持 copy 或 overwrite')
    const presets = getPresetsForDevice(instance.kind, catalogModels?.get(instance.kind) ?? null, platform)
    const nameMatches = presets.filter(item => item.name === presetSelector)
    const preset =
      presets.find(item => item.slug.toLowerCase() === presetSelector.toLowerCase()) ??
      presets.find(item => item.id === presetSelector) ??
      (nameMatches.length === 1 ? nameMatches[0] : undefined)
    if (!preset) throw new InstanceCliError('invalid_target', '找不到指定的预制配置，请先运行 preset list')

    if (mode === 'copy') {
      const customName = stringParam(params.name, 'name')
      if (customName.length > 40) throw new InstanceCliError('invalid_arguments', '配置名称需要 1–40 个字符')
      const applyCopy = (current: DeviceInstance) => {
        if (customName && current.profiles.some(item => item.name === customName))
          throw new InstanceCliError('invalid_target', '配置名称已存在：' + customName)
        const nextProfile = materializePresetToProfile(preset, {
          ...(customName ? { name: customName } : {}),
          existingNames: current.profiles.map(item => item.name),
        })
        if (!nextProfile.quick) {
          const reference =
            current.profiles.find(item => item.id === current.activeProfileId && !item.quick) ??
            current.profiles.find(item => !item.quick)
          preserveSharedProfileSwitches(nextProfile.behaviors, reference?.behaviors)
        }
        return {
          ...current,
          profiles: [...current.profiles, nextProfile],
          ...(nextProfile.quick ? {} : { activeProfileId: nextProfile.id }),
        }
      }
      const saved = dryRun ? null : await update(instance.id, applyCopy)
      const next = saved ? saved.store.instances.find(i => i.id === instance.id)! : applyCopy(instance)
      const createdProfile = next.profiles[next.profiles.length - 1]
      return {
        ...target,
        mode,
        preset: { id: preset.id, slug: preset.slug, name: preset.name, source: preset.source },
        profile: profileIdentity(next, createdProfile),
        configuredKeyCount: countConfiguredInputs(preset.behaviors),
        previousActiveProfileId: instance.activeProfileId,
        revision: saved?.store.revision ?? snapshot.store.revision,
        ...(dryRun ? { dryRun: true } : { applied: true, saved: true }),
      }
    }

    const targetProfile = resolveProfile(instance, profileValue)
    if (Boolean(preset.quick) !== Boolean(targetProfile.quick)) {
      throw new InstanceCliError(
        'invalid_target',
        preset.quick
          ? '快捷交互预制只能覆盖快捷交互配置'
          : '常规预制配置不能覆盖快捷交互配置，请改用 --mode copy 或指定常规配置',
      )
    }
    const applyOverwrite = (current: DeviceInstance) => {
      const selected = resolveProfile(current, targetProfile.id)
      const freshBehaviors = clonePresetBehaviors(preset.behaviors, true)
      if (!selected.quick) preserveSharedProfileSwitches(freshBehaviors, selected.behaviors)
      const replaced = replaceInstanceProfileBehaviors(current, selected.id, freshBehaviors)
      return {
        ...replaced,
        profiles: replaced.profiles.map(entry => {
          if (entry.id !== selected.id) return entry
          const nextEntry: InstanceProfile = {
            ...entry,
            ...(preset.display ? { display: { ...preset.display } } : {}),
          }
          if (selected.quick) {
            if (preset.promptMode) nextEntry.promptMode = true
            else delete nextEntry.promptMode
          }
          return nextEntry
        }),
      }
    }
    const saved = dryRun ? null : await update(instance.id, applyOverwrite)
    const next = saved ? saved.store.instances.find(i => i.id === instance.id)! : applyOverwrite(instance)
    return {
      ...target,
      mode,
      preset: { id: preset.id, slug: preset.slug, name: preset.name, source: preset.source },
      profile: profileIdentity(next, resolveProfile(next, targetProfile.id)),
      beforeConfiguredKeyCount: countConfiguredInputs(targetProfile.behaviors),
      configuredKeyCount: countConfiguredInputs(preset.behaviors),
      revision: saved?.store.revision ?? snapshot.store.revision,
      ...(dryRun ? { dryRun: true } : { applied: true, saved: true }),
    }
  }
  const profile = resolveProfile(instance, profileValue)
  if (method === 'profile.activate') {
    if (!profileValue) throw new InstanceCliError('invalid_arguments', '激活配置需要 --profile')
    if (profile.quick)
      throw new InstanceCliError('invalid_target', '快捷交互配置仅用于按键单次唤起，不能设为常驻生效配置')
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
  if (method === 'profile.rename') {
    const name = stringParam(params.name, 'name')
    if (!name || name.length > 40)
      throw new InstanceCliError('invalid_arguments', '重命名配置需要 1–40 个字符的 --name')
    const rename = (current: DeviceInstance) => {
      const selected = resolveProfile(current, profile.id)
      if (current.profiles.some(item => item.id !== selected.id && item.name === name))
        throw new InstanceCliError('invalid_target', '配置名称已存在：' + name)
      return {
        ...current,
        profiles: current.profiles.map(item => (item.id === selected.id ? { ...item, name } : item)),
      }
    }
    const saved = dryRun ? null : await update(instance.id, rename)
    const next = saved ? saved.store.instances.find(i => i.id === instance.id)! : rename(instance)
    return {
      ...target,
      before: profile.name,
      after: name,
      profile: profileIdentity(next, resolveProfile(next, profile.id)),
      revision: saved?.store.revision ?? snapshot.store.revision,
      ...(dryRun ? { dryRun: true } : { applied: true, saved: true }),
    }
  }
  if (method === 'profile.duplicate') {
    const requestedName = stringParam(params.name, 'name')
    if (requestedName.length > 40) throw new InstanceCliError('invalid_arguments', '配置名称需要 1–40 个字符')
    const asQuick = booleanParam(params.quick, 'quick') || Boolean(profile.quick)
    const duplicate = (current: DeviceInstance) => {
      const source = resolveProfile(current, profile.id)
      if (requestedName && current.profiles.some(item => item.name === requestedName))
        throw new InstanceCliError('invalid_target', '配置名称已存在：' + requestedName)
      if (asQuick) {
        return addQuickInstanceProfile(current, requestedName || undefined, source.id).instance
      }
      const nextName =
        requestedName ||
        nextQuickProfileName(
          current.profiles.map(item => item.name),
          `${source.name} 副本`,
        )
      const cloned: InstanceProfile = {
        id: crypto.randomUUID(),
        name: nextName,
        behaviors: clonePresetBehaviors(source.behaviors, true),
        ...(source.display ? { display: structuredClone(source.display) } : {}),
      }
      return {
        ...current,
        activeProfileId: cloned.id,
        profiles: [...current.profiles, cloned],
      }
    }
    const saved = dryRun ? null : await update(instance.id, duplicate)
    const next = saved ? saved.store.instances.find(i => i.id === instance.id)! : duplicate(instance)
    const createdProfile = next.profiles[next.profiles.length - 1]
    return {
      ...target,
      sourceProfileId: profile.id,
      profile: profileIdentity(next, createdProfile),
      previousActiveProfileId: instance.activeProfileId,
      revision: saved?.store.revision ?? snapshot.store.revision,
      ...(dryRun ? { dryRun: true } : { applied: true, saved: true }),
    }
  }
  if (method === 'profile.delete') {
    if (!profileValue) throw new InstanceCliError('invalid_arguments', '删除配置需要 --profile')
    if (!booleanParam(params.yes, 'yes')) throw new InstanceCliError('invalid_arguments', '删除配置需要 --yes')
    if (!profile.quick && instance.profiles.filter(item => !item.quick).length <= 1)
      throw new InstanceCliError('invalid_target', '至少需要保留一个常规配置文件')
    const remove = (current: DeviceInstance) => {
      const next = deleteInstanceProfile(current, profile.id)
      return profile.quick ? bindQuickOverlayTrigger(next, profile.id, '', null) : next
    }
    const saved = dryRun ? null : await update(instance.id, remove)
    const next = saved ? saved.store.instances.find(i => i.id === instance.id)! : remove(instance)
    return {
      ...target,
      deleted: profileIdentity(instance, profile),
      activeProfileId: next.activeProfileId,
      revision: saved?.store.revision ?? snapshot.store.revision,
      ...(dryRun ? { dryRun: true } : { applied: true, saved: true }),
    }
  }
  if (method === 'profile.prompt-mode') {
    if (!profileValue) throw new InstanceCliError('invalid_arguments', '设置纯 Prompt 模式需要 --profile')
    if (typeof params.enabled !== 'boolean')
      throw new InstanceCliError('invalid_arguments', '设置纯 Prompt 模式需要 --on 或 --off')
    if (!profile.quick) throw new InstanceCliError('invalid_target', '纯 Prompt 模式仅适用于快捷交互配置')
    const promptMode = params.enabled === true
    const toggle = (current: DeviceInstance) => ({
      ...current,
      profiles: current.profiles.map(item => {
        if (item.id !== profile.id) return item
        if (promptMode) return { ...item, promptMode: true }
        const { promptMode: _removed, ...rest } = item
        return rest
      }),
    })
    const saved = dryRun ? null : await update(instance.id, toggle)
    const next = saved ? saved.store.instances.find(i => i.id === instance.id)! : toggle(instance)
    return {
      ...target,
      promptMode,
      profile: profileIdentity(next, resolveProfile(next, profile.id)),
      revision: saved?.store.revision ?? snapshot.store.revision,
      ...(dryRun ? { dryRun: true } : { applied: true, saved: true }),
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
  const quickBehavior = behaviors.find(behavior => behavior.type === 'quickOverlay')
  if (quickBehavior) {
    if (behaviors.length !== 1) throw new InstanceCliError('invalid_behavior', '快捷交互窗必须是该触发方式的唯一行为')
    const targetProfile = resolveProfile(instance, quickBehavior.profileId)
    quickBehavior.profileId = targetProfile.id
  }
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

function preserveSharedProfileSwitches(
  targetBehaviors: Record<string, TriggerBehaviors>,
  referenceBehaviors: Record<string, TriggerBehaviors> | undefined,
) {
  if (!referenceBehaviors) return
  for (const [inputId, refTriggers] of Object.entries(referenceBehaviors)) {
    if (!refTriggers || typeof refTriggers !== 'object') continue
    for (const trigger of triggers) {
      const shared = refTriggers[trigger]?.find(item => item.type === 'switchProfile')
      if (!shared) continue
      const existing = targetBehaviors[inputId] ?? emptyTriggers()
      targetBehaviors[inputId] = { ...existing, [trigger]: [{ ...shared, id: crypto.randomUUID() }] }
    }
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
  return {
    id: profile.id,
    name: profile.name,
    active: profile.id === instance.activeProfileId,
    ...(profile.quick ? { quick: true } : {}),
    ...(profile.quick && profile.promptMode ? { promptMode: true } : {}),
  }
}

function publicSequence(sequence: Behavior[], platform: CliPlatform) {
  return sequence.map(behavior => behaviorToCliBehavior(behavior, platform))
}

function applicationParam(params: Record<string, unknown>, instance: DeviceInstance): Application {
  const id = stringParam(params.application, 'application')
  if (!id) throw new InstanceCliError('invalid_arguments', '应用配置绑定需要 --application')
  const existing = instance.applicationProfiles?.find(binding => binding.application.id === id)?.application
  const path = stringParam(params.applicationPath, 'application-path') || existing?.path || id
  const name = stringParam(params.applicationName, 'application-name') || existing?.name || id.split(/[\\/]/).pop()!
  const bytes = new TextEncoder()
  if (bytes.encode(id).length > 4096 || bytes.encode(name).length > 200 || bytes.encode(path).length > 32768)
    throw new InstanceCliError('invalid_arguments', '应用 ID、名称或路径过长')
  if (!existing && (instance.applicationProfiles?.length ?? 0) >= 128)
    throw new InstanceCliError('invalid_arguments', '每台设备最多关联 128 个应用')
  return { id, name, path }
}
