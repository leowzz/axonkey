import source from '../../device-packages/builtin.json' with { type: 'json' }
import type { MappingInput, RemoteButton } from '../appTypes.ts'
import type { RemoteView, DeviceSupportPackage } from './types.ts'

export type HardwareDefinition = {
  id: string
  vendorId: number
  productId: number
  usagePage: number
  usage: number
  initialPackageId: string
  softwareFallbackPackageId: string | null
  hidPlatforms: string[]
  windows: { prefixes: string[]; vidTokens: string[]; requireHidService: boolean; includeHardwareId: boolean }
}
export type PackageDefinition = {
  id: string
  version: number
  adapter: string
  hardwareId: string
  name: string
  model: string
  softwareMarker: string | null
  capabilities: {
    voice: 'rc003-atvv' | 'a15-g7221' | 'obe-sbc' | null
    recordingModes: ('hold' | 'click')[]
    defaultRecordingMode: 'hold' | 'click'
  }
  presentation:
    | ({ renderer: 'remote'; artwork: string } & Omit<RemoteView, 'buttons' | 'artworkUrl'>)
    | { renderer: 'xbox'; artwork: string }
  inputs: (MappingInput<string> & Partial<Omit<RemoteButton, 'id' | 'label' | 'icon'>>)[]
}
export type DeviceCatalog = { schemaVersion: 1; hardware: HardwareDefinition[]; packages: PackageDefinition[] }

export function loadDeviceCatalog(value: unknown): DeviceCatalog {
  object(value, 'catalog')
  check(value.schemaVersion === 1, '不支持的 schemaVersion')
  const hardware = records(value.hardware, 'hardware')
  const packages = records(value.packages, 'packages')
  uniqueIds(hardware, 'hardware')
  uniqueIds(packages, 'packages')
  check(new Set(hardware.map(item => `${item.vendorId}:${item.productId}`)).size === hardware.length, '硬件匹配重复')
  for (const item of hardware) validateHardware(item)
  for (const item of packages) validatePackage(item, hardware)
  for (const item of hardware) {
    for (const id of [item.initialPackageId, item.softwareFallbackPackageId].filter(id => id !== null)) {
      check(
        packages.some(pkg => pkg.id === id && pkg.hardwareId === item.id),
        `${item.id}: 型号引用不属于该硬件`,
      )
    }
    const markers = packages
      .filter(pkg => pkg.hardwareId === item.id && pkg.softwareMarker !== null)
      .map(pkg => pkg.softwareMarker)
    check(new Set(markers).size === markers.length, `${item.id}: 软件识别标记重复`)
  }
  return value as unknown as DeviceCatalog
}

export class DevicePackageRegistry {
  readonly packages: readonly PackageDefinition[]
  readonly hardware: readonly HardwareDefinition[]
  private readonly byId: Map<string, PackageDefinition>

  constructor(value: unknown) {
    const catalog = loadDeviceCatalog(value)
    this.packages = catalog.packages
    this.hardware = catalog.hardware
    this.byId = new Map(this.packages.map(pkg => [pkg.id, pkg]))
  }

  get(id: string): PackageDefinition {
    const pkg = this.byId.get(id)
    if (!pkg) throw new Error(`未知设备支持包：${id}`)
    return pkg
  }

  forHardware(vendorId: number, productId: number): HardwareDefinition | undefined {
    return this.hardware.find(item => item.vendorId === vendorId && item.productId === productId)
  }

  forSoftware(hardwareId: string, software: string | null | undefined): PackageDefinition | undefined {
    return software
      ? this.packages.find(
          pkg => pkg.hardwareId === hardwareId && pkg.softwareMarker !== null && software.includes(pkg.softwareMarker),
        )
      : undefined
  }
}

export const devicePackages = new DevicePackageRegistry(source)

export function remoteViewFor(id: string): RemoteView {
  const pkg = devicePackages.get(id)
  const view = pkg.presentation
  if (view.renderer !== 'remote') throw new Error(`${id}: 不是遥控器视图`)
  return {
    buttons: pkg.inputs as RemoteButton[],
    viewBox: view.viewBox,
    keyRegions: view.keyRegions,
    artworkUrl: view.artwork,
    ariaLabel: view.ariaLabel,
  }
}

export function supportPackageFor(id: string): DeviceSupportPackage {
  const pkg = devicePackages.get(id)
  return {
    kind: pkg.id,
    name: pkg.name,
    model: pkg.model,
    artwork: pkg.presentation.artwork,
    inputs: pkg.inputs,
    version: pkg.version,
    adapter: pkg.adapter,
    hardwareId: pkg.hardwareId,
    capabilities: pkg.capabilities,
    ...(pkg.presentation.renderer === 'remote' ? { remoteView: remoteViewFor(id) } : {}),
  }
}

function check(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`设备支持包无效：${message}`)
}
function object(value: unknown, name: string): asserts value is Record<string, unknown> {
  check(value !== null && typeof value === 'object' && !Array.isArray(value), name)
}
function records(value: unknown, name: string): Record<string, unknown>[] {
  check(Array.isArray(value) && value.length > 0, name)
  for (const item of value) object(item, name)
  return value
}
function text(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0
}
function integer(value: unknown, min: number, max: number): boolean {
  return typeof value === 'number' && Number.isInteger(value) && value >= min && value <= max
}
function uniqueIds(items: Record<string, unknown>[], name: string) {
  check(
    items.every(item => text(item.id)),
    `${name}: 缺少 ID`,
  )
  check(new Set(items.map(item => item.id)).size === items.length, `${name}: ID 重复`)
}
function validateHardware(item: Record<string, unknown>) {
  for (const field of ['vendorId', 'productId', 'usagePage', 'usage'])
    check(integer(item[field], 0, 65535), `${item.id}: ${field}`)
  check(
    text(item.initialPackageId) && (item.softwareFallbackPackageId === null || text(item.softwareFallbackPackageId)),
    `${item.id}: 型号引用`,
  )
  check(
    Array.isArray(item.hidPlatforms) && item.hidPlatforms.every(p => ['windows', 'macos', 'linux'].includes(p)),
    `${item.id}: hidPlatforms`,
  )
  object(item.windows, 'windows')
  check(
    Array.isArray(item.windows.prefixes) && item.windows.prefixes.length > 0 && item.windows.prefixes.every(text),
    `${item.id}: Windows 前缀`,
  )
  check(
    Array.isArray(item.windows.vidTokens) &&
      item.windows.vidTokens.length > 0 &&
      item.windows.vidTokens.every(token => text(token) && /^[0-9A-F]+$/.test(token)),
    `${item.id}: Windows VID`,
  )
  check(typeof item.windows.includeHardwareId === 'boolean', `${item.id}: includeHardwareId`)
  check(typeof item.windows.requireHidService === 'boolean', `${item.id}: requireHidService`)
}
function validatePackage(pkg: Record<string, unknown>, hardware: Record<string, unknown>[]) {
  check(integer(pkg.version, 1, 2147483647), `${pkg.id}: version`)
  check(
    ['rc003', 'cmiotA15', 'xmBt29', 'rc313', 'obeRcuR5', 'xboxBluetooth'].includes(pkg.adapter as string),
    `${pkg.id}: 未安装的原生适配器`,
  )
  for (const field of ['adapter', 'name', 'model']) check(text(pkg[field]), `${pkg.id}: ${field}`)
  check(
    hardware.some(item => item.id === pkg.hardwareId),
    `${pkg.id}: 未知硬件引用`,
  )
  check(pkg.softwareMarker === null || text(pkg.softwareMarker), `${pkg.id}: softwareMarker`)
  object(pkg.capabilities, 'capabilities')
  check(
    pkg.capabilities.voice === null ||
      ['rc003-atvv', 'a15-g7221', 'obe-sbc'].includes(pkg.capabilities.voice as string),
    `${pkg.id}: voice`,
  )
  check(
    Array.isArray(pkg.capabilities.recordingModes) &&
      pkg.capabilities.recordingModes.every(mode => mode === 'hold' || mode === 'click'),
    `${pkg.id}: recordingModes`,
  )
  check(['hold', 'click'].includes(pkg.capabilities.defaultRecordingMode as string), `${pkg.id}: defaultRecordingMode`)
  const inputs = records(pkg.inputs, 'inputs')
  uniqueIds(inputs, `${pkg.id}.inputs`)
  const icons = [
    'power',
    'locate',
    'mic',
    'up',
    'left',
    'center',
    'right',
    'down',
    'back',
    'volumeUp',
    'volumeDown',
    'home',
    'menu',
    'tv',
    'mute',
    'settings',
    'm',
    'number',
    'delete',
  ]
  for (const input of inputs)
    check(text(input.label) && icons.includes(input.icon as string), `${pkg.id}/${input.id}: label/icon`)
  object(pkg.presentation, 'presentation')
  const view = pkg.presentation
  check(
    text(view.artwork) &&
      view.artwork.startsWith('/') &&
      !view.artwork.startsWith('//') &&
      !view.artwork.includes('..'),
    `${pkg.id}: 本地图片地址`,
  )
  check(view.renderer === 'remote' || view.renderer === 'xbox', `${pkg.id}: renderer`)
  if (view.renderer === 'remote') validateRemoteView(view, inputs)
}
function validateRemoteView(view: Record<string, unknown>, inputs: Record<string, unknown>[]) {
  check(text(view.ariaLabel), 'ariaLabel')
  object(view.viewBox, 'viewBox')
  for (const dimension of ['width', 'height'])
    check(
      typeof view.viewBox[dimension] === 'number' &&
        Number.isFinite(view.viewBox[dimension]) &&
        view.viewBox[dimension] > 0,
      `viewBox.${dimension}`,
    )
  object(view.keyRegions, 'keyRegions')
  check(Object.keys(view.keyRegions).length === inputs.length, '区域与输入数量不一致')
  for (const input of inputs) {
    check(text(input.short) && ['left', 'right'].includes(input.side as string), `${input.id}: short/side`)
    for (const axis of ['x', 'y'])
      check(typeof input[axis] === 'number' && Number.isFinite(input[axis]), `${input.id}: ${axis}`)
    const region = view.keyRegions[input.id as string]
    object(region, `${input.id}: 缺少区域`)
    check(text(region.path), `${input.id}: path`)
    object(region.anchor, 'anchor')
    for (const axis of ['x', 'y'])
      check(
        typeof region.anchor[axis] === 'number' && Number.isFinite(region.anchor[axis]),
        `${input.id}: anchor.${axis}`,
      )
  }
}
