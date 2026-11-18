import { appStorage } from '../../appStorage.ts'
import type { TriggerBehaviors } from '../../behaviorModel'
import type { ApplicationProfile } from '../../applications'
import type { BuiltinDeviceKind, DeviceKind, DeviceSupportPackage } from '../types.ts'
import { xiaomiRemoteSupportPackage } from '../xiaomi-remote/definition.ts'
import { cmiotA15SupportPackage } from '../cmiot-a15-remote/definition.ts'
import { xmBt29SupportPackage } from '../xm-bt-29-remote/definition.ts'
import { obeRcuR5SupportPackage } from '../obe-rcu-r5-remote/definition.ts'
import { rc313SupportPackage } from '../rc-313-remote/definition.ts'
import { xboxSupportPackage } from '../xbox-controller/index.ts'
import { tclRc802aSupportPackage } from '../tcl-rc802a-remote/definition.ts'
import { tclRc902nSupportPackage } from '../tcl-rc902n-remote/definition.ts'
import { tclRc902vSupportPackage } from '../tcl-rc902v-remote/definition.ts'
import { hisenseRcf3b65SupportPackage } from '../hisense-rcf3b65-remote/definition.ts'
import { phicommDb1RSupportPackage } from '../phicomm-db1-r-remote/definition.ts'
import { kivoK18LiteSupportPackage } from '../kivo-k18-lite/definition.ts'
import { g17TouchSupportPackage } from '../g17-touch/definition.ts'

export type { BuiltinDeviceKind, DeviceKind } from '../types.ts'
export const deviceScreenSelectionId = '__screen__'
export type ProfileDisplayMode = 'auto' | 'custom'
export type ProfileDisplayConfig = {
  mode: ProfileDisplayMode
  line1: string
  line2: string
}
export type DeviceDisplaySettings = {
  brightness: number
  sleepTimeoutSec: number
  showKeyToast: boolean
  showProfileToast: boolean
}
export const defaultProfileDisplay: ProfileDisplayConfig = {
  mode: 'auto',
  line1: '',
  line2: '',
}
export const defaultDeviceDisplaySettings: DeviceDisplaySettings = {
  brightness: 100,
  sleepTimeoutSec: 180,
  showKeyToast: true,
  showProfileToast: true,
}
export type InstanceProfile = {
  id: string
  name: string
  behaviors: Record<string, TriggerBehaviors>
  display?: ProfileDisplayConfig
  quick?: boolean
}
export type DeviceInstance = {
  id: string
  kind: DeviceKind
  name: string
  binding: string | null
  bindingQuality?: string | null
  bindingPairingId?: string | null
  audioGainDb?: number
  cmiotA15RecordingMode?: 'hold' | 'click'
  quarborTarget?: string | null
  hideDriverMissingReminder?: boolean
  display?: DeviceDisplaySettings
  enabled: boolean
  profiles: InstanceProfile[]
  activeProfileId: string
  appProfileSwitching?: boolean
  applicationProfiles?: ApplicationProfile[]
}
export type DeviceInformation = {
  status: 'pending' | 'ready' | 'retrying' | 'error' | 'disconnected'
  bluetoothName?: string | null
  batteryLevel?: number | null
  manufacturer?: string | null
  modelNumber?: string | null
  serialNumber?: string | null
  hardwareRevision?: string | null
  firmwareRevision?: string | null
  softwareRevision?: string | null
  detectedKind?: DeviceKind | null
  updatedAt?: number | null
  error?: string | null
}
export type DiscoveredDevice = {
  id: string
  kind: DeviceKind
  name: string
  transport: string
  identityQuality: 'serial' | 'session' | 'ambiguous'
  vendorId: number
  productId: number
  connected: boolean
  paired: boolean
  bluetoothAddress?: string | null
  deviceInfo?: DeviceInformation
  pairingId?: string | null
}
export type DeviceSnapshot = {
  store: { version: number; revision: number; instances: DeviceInstance[] }
  discovered: DiscoveredDevice[]
  runtime: Record<
    string,
    {
      state: string
      error: string | null
      reports: number
      recording?: boolean
      effectiveProfileId?: string
      driverInstalled?: boolean
      driverState?: string
      mappingErrors?: Record<string, Record<string, string>>
    }
  >
  error: string | null
  scanError: string | null
  scanning: boolean
}

export const bundledSupportPackages: readonly DeviceSupportPackage[] = Object.freeze([
  xiaomiRemoteSupportPackage,
  cmiotA15SupportPackage,
  xmBt29SupportPackage,
  rc313SupportPackage,
  obeRcuR5SupportPackage,
  tclRc802aSupportPackage,
  tclRc902nSupportPackage,
  tclRc902vSupportPackage,
  hisenseRcf3b65SupportPackage,
  phicommDb1RSupportPackage,
  kivoK18LiteSupportPackage,
  g17TouchSupportPackage,
  xboxSupportPackage,
])

const builtinKindSet = new Set<string>(bundledSupportPackages.map(pkg => pkg.kind))

export function isBuiltinDeviceKind(kind: string): kind is BuiltinDeviceKind {
  return builtinKindSet.has(kind)
}

const mutableSupportPackages: DeviceSupportPackage[] = [...bundledSupportPackages]
export const supportPackages: readonly DeviceSupportPackage[] = mutableSupportPackages
let supportPackagesSnapshot: readonly DeviceSupportPackage[] = Object.freeze([...bundledSupportPackages])
const supportPackageListeners = new Set<() => void>()

export function getSupportPackages(): readonly DeviceSupportPackage[] {
  return supportPackagesSnapshot
}

export function subscribeSupportPackages(listener: () => void): () => void {
  supportPackageListeners.add(listener)
  return () => {
    supportPackageListeners.delete(listener)
  }
}

function getMobileRemotePackages(list: readonly DeviceSupportPackage[] = mutableSupportPackages) {
  return list.filter(pkg =>
    pkg.remoteView?.identities.some(identity => identity.softwareContains && !identity.informationRequired),
  )
}

const mutableMobileRemoteKinds: DeviceKind[] = getMobileRemotePackages().map(pkg => pkg.kind)
export const mobileRemoteKinds: readonly DeviceKind[] = mutableMobileRemoteKinds
export const mobileRemoteFallbackKind: DeviceKind =
  getMobileRemotePackages().find(pkg => pkg.remoteView?.identities.some(identity => identity.softwareFallback))?.kind ??
  'rc313'

export type LocalCloudDescriptorOverride = {
  kind: string
  name: string
  cloudName: string
  differsFromCloud: boolean
}

let cloudOverlayPackages: readonly DeviceSupportPackage[] = []
let localCustomOverlayPackages: readonly DeviceSupportPackage[] = []
let localCloudOverridesSnapshot: readonly LocalCloudDescriptorOverride[] = Object.freeze([])

export function getLocalCloudDescriptorOverrides(): readonly LocalCloudDescriptorOverride[] {
  return localCloudOverridesSnapshot
}

export function localCloudOverrideWarningText(overrides: readonly LocalCloudDescriptorOverride[]): string {
  if (overrides.length === 0) return ''
  const names = overrides.map(item => item.name).join('、')
  if (overrides.some(item => item.differsFromCloud)) {
    return `本机目录文件正在覆盖「${names}」的云端配置（内容与云端不同），云端更新暂不生效。`
  }
  return `本机目录文件正在覆盖「${names}」的云端配置，后续云端更新将不会自动生效。`
}

function rebuildSupportPackages(): boolean {
  const overlayByKind = new Map<string, DeviceSupportPackage>()
  const cloudByKind = new Map<string, DeviceSupportPackage>()
  for (const pkg of cloudOverlayPackages) {
    const kind = pkg?.kind?.trim()
    if (!kind || kind === 'mouse') continue
    cloudByKind.set(kind, pkg)
    overlayByKind.set(kind, pkg)
  }
  const nextOverrides: LocalCloudDescriptorOverride[] = []
  for (const pkg of localCustomOverlayPackages) {
    const kind = pkg?.kind?.trim()
    if (!kind || kind === 'mouse') continue
    overlayByKind.set(kind, pkg)
    const cloudPkg = cloudByKind.get(kind)
    if (cloudPkg) {
      nextOverrides.push({
        kind,
        name: pkg.name,
        cloudName: cloudPkg.name,
        differsFromCloud: pkg.artwork !== cloudPkg.artwork,
      })
    }
  }

  const next: DeviceSupportPackage[] = bundledSupportPackages.map(pkg => {
    const overlay = overlayByKind.get(pkg.kind)
    if (!overlay) return pkg
    return {
      ...overlay,
      ...(overlay.workspaceLayout === undefined && pkg.workspaceLayout !== undefined
        ? { workspaceLayout: pkg.workspaceLayout }
        : {}),
      ...(overlay.screenRegion === undefined && pkg.screenRegion !== undefined
        ? { screenRegion: pkg.screenRegion }
        : {}),
    }
  })
  for (const [kind, pkg] of overlayByKind) {
    if (!builtinKindSet.has(kind)) next.push(pkg)
  }
  const packagesUnchanged =
    next.length === supportPackagesSnapshot.length &&
    next.every((pkg, index) => {
      const prev = supportPackagesSnapshot[index]
      return (
        prev.kind === pkg.kind &&
        prev.name === pkg.name &&
        prev.model === pkg.model &&
        prev.artwork === pkg.artwork &&
        prev.inputs.length === pkg.inputs.length &&
        prev.remoteView?.usesVendorUsbHid === pkg.remoteView?.usesVendorUsbHid &&
        prev.workspaceLayout === pkg.workspaceLayout &&
        prev.screenRegion?.label === pkg.screenRegion?.label &&
        prev.screenRegion?.path === pkg.screenRegion?.path
      )
    })
  const overridesUnchanged =
    nextOverrides.length === localCloudOverridesSnapshot.length &&
    nextOverrides.every((item, index) => {
      const prev = localCloudOverridesSnapshot[index]
      return (
        prev.kind === item.kind &&
        prev.name === item.name &&
        prev.cloudName === item.cloudName &&
        prev.differsFromCloud === item.differsFromCloud
      )
    })
  if (packagesUnchanged && overridesUnchanged) return false

  mutableSupportPackages.splice(0, mutableSupportPackages.length, ...next)
  const nextMobileKinds = getMobileRemotePackages(next).map(pkg => pkg.kind)
  mutableMobileRemoteKinds.splice(0, mutableMobileRemoteKinds.length, ...nextMobileKinds)
  supportPackagesSnapshot = Object.freeze([...next])
  localCloudOverridesSnapshot = Object.freeze(nextOverrides)
  for (const listener of supportPackageListeners) listener()
  return true
}

export function setRuntimeSupportPackages(overlays: readonly DeviceSupportPackage[]): boolean {
  cloudOverlayPackages = [...overlays]
  return rebuildSupportPackages()
}

export function setLocalCustomSupportPackages(overlays: readonly DeviceSupportPackage[]): boolean {
  localCustomOverlayPackages = [...overlays]
  return rebuildSupportPackages()
}

export function resetRuntimeSupportPackages(): boolean {
  cloudOverlayPackages = []
  localCustomOverlayPackages = []
  return rebuildSupportPackages()
}

const bundledDeviceIdAliases: Readonly<Record<string, BuiltinDeviceKind>> = {
  'xiaomi.rc003': 'rc003',
  'xbox.bluetooth': 'xboxBluetooth',
  'xbox-bluetooth-045e-02e0': 'xboxBluetooth',
}

export function deriveDeviceKindFromId(deviceId: string): string {
  const trimmed = deviceId.trim()
  if (!trimmed) return ''
  if (trimmed in bundledDeviceIdAliases) return bundledDeviceIdAliases[trimmed]
  const parts = trimmed.split(/[^A-Za-z0-9]+/).filter(Boolean)
  if (parts.length === 0) return ''
  let code = parts
    .map((part, index) =>
      index === 0 ? part.toLowerCase() : part.charAt(0).toUpperCase() + part.slice(1).toLowerCase(),
    )
    .join('')
  if (/^[0-9]/.test(code)) code = `d${code}`
  code = code.slice(0, 64)
  if (code === 'mouse') code = 'customMouse'
  return /^[A-Za-z][A-Za-z0-9_-]{0,63}$/.test(code) ? code : ''
}

export function isMobileRemoteDevice(device: Pick<DiscoveredDevice, 'vendorId' | 'productId'>) {
  return getMobileRemotePackages().some(pkg =>
    pkg.remoteView?.identities.some(
      identity => identity.vendorIds.includes(device.vendorId) && identity.productIds.includes(device.productId),
    ),
  )
}
export function isMobileRemoteKind(kind: DeviceKind | undefined): kind is DeviceKind {
  return kind !== undefined && mutableMobileRemoteKinds.includes(kind)
}
export function mobileRemoteKindForSoftware(software: string | null | undefined): DeviceKind | null {
  if (!software) return null
  return (
    getMobileRemotePackages().find(pkg =>
      pkg.remoteView?.identities.some(
        identity =>
          identity.softwareContains && identity.softwareContains.split('|').some(marker => software.includes(marker)),
      ),
    )?.kind ?? null
  )
}
export const emptySnapshot = (): DeviceSnapshot => ({
  store: { version: 1, revision: 0, instances: [] },
  discovered: [],
  runtime: {},
  error: null,
  scanError: null,
  scanning: false,
})

const placeholderArtworkUrl =
  'data:image/svg+xml;charset=utf-8,' +
  encodeURIComponent(
    '<svg xmlns="http://www.w3.org/2000/svg" width="240" height="520" viewBox="0 0 240 520" fill="none"><rect x="36" y="20" width="168" height="480" rx="44" fill="#EEF2F6" stroke="#CBD5E1" stroke-width="4"/></svg>',
  )
const placeholderCache = new Map<string, DeviceSupportPackage>()

function placeholderPackageFor(kind: DeviceKind): DeviceSupportPackage {
  let cached = placeholderCache.get(kind)
  if (!cached) {
    cached = {
      kind,
      name: kind,
      model: kind,
      artwork: placeholderArtworkUrl,
      inputs: [],
      remoteView: {
        buttons: [],
        identities: [],
        voice: null,
        viewBox: { width: 240, height: 520 },
        keyRegions: {},
        artworkUrl: placeholderArtworkUrl,
        ariaLabel: kind,
      },
    }
    placeholderCache.set(kind, cached)
  }
  return cached
}

export const packageFor = (kind: DeviceKind): DeviceSupportPackage =>
  mutableSupportPackages.find(p => p.kind === kind) ?? placeholderPackageFor(kind)

export function usesSingleLaneWorkspace(kind: DeviceKind | undefined) {
  return kind !== undefined && packageFor(kind).workspaceLayout === 'single-lane'
}
export function usesHidVoice(kind: DeviceKind | undefined) {
  const engine = kind && packageFor(kind).remoteView?.voice?.engine
  return engine === 'cmiot-a15.g7221' || engine === 'obe-rcu-r5.sbc' || engine === 'tcl-rc802a.ico'
}
export function deviceMatchesKind(device: DiscoveredDevice, kind: DeviceKind) {
  const identities = packageFor(kind).remoteView?.identities ?? []
  if (!identities.some(identity => identity.informationRequired)) return device.kind === kind
  return identities.some(
    identity =>
      identity.vendorIds.includes(device.vendorId) &&
      identity.productIds.includes(device.productId) &&
      [
        [identity.modelContains, device.deviceInfo?.modelNumber],
        [identity.manufacturerContains, device.deviceInfo?.manufacturer],
        [identity.softwareContains, device.deviceInfo?.softwareRevision],
      ].every(([marker, value]) => !marker || Boolean(value && marker.split('|').some(part => value.includes(part)))),
  )
}
export function supportsWindowsDriver(kind: DeviceKind | undefined) {
  if (kind === undefined || kind === 'mouse') return false
  const view = packageFor(kind).remoteView
  if (!view || view.identities.length === 0) return false
  if (view.usesVendorUsbHid !== undefined) return !view.usesVendorUsbHid
  return view.identities.some(identity => Boolean(identity.windowsPrefix))
}
export function supportsDeviceInformation(kind: DeviceKind) {
  const view = packageFor(kind).remoteView
  return Boolean(
    view?.voice ||
    view?.identities.some(identity => identity.informationRequired || identity.windowsPrefix === 'BTHLEDEVICE'),
  )
}
export function defaultRecordingMode(kind: DeviceKind): 'hold' | 'click' {
  const modes = packageFor(kind).remoteView?.voice?.triggerModes ?? []
  return modes.length && !modes.includes('click') ? 'hold' : 'click'
}
export const emptyTriggers = (): TriggerBehaviors => ({ click: [], doubleClick: [], longPress: [] })
export function newInstance(kind: DeviceKind, binding: string | null): DeviceInstance {
  return {
    id: '',
    kind,
    name: packageFor(kind).name,
    binding,
    audioGainDb: 0,
    cmiotA15RecordingMode: defaultRecordingMode(kind),
    enabled: true,
    activeProfileId: 'default',
    profiles: [{ id: 'default', name: '默认配置', behaviors: {} }],
  }
}
export function batteryForDevice(binding: string | null, discovered: DiscoveredDevice[]): number | null {
  const device = discovered.find(device => device.id === binding)
  if (!device?.connected || device.identityQuality === 'ambiguous') return null
  return device.deviceInfo?.batteryLevel ?? null
}
export function stateLabel(state?: string): string {
  return (
    (
      {
        paused: '已暂停',
        unbound: '等待绑定',
        disconnected: '未连接',
        needsRebind: '未连接 · 需重新绑定',
        opening: '正在连接',
        error: '需要处理',
        exclusive: '拦截中',
        unsupported: '等待输入适配',
      } as Record<string, string>
    )[state ?? ''] ?? '等待启动'
  )
}
export function instanceStatusLabel(instance: DeviceInstance, snapshot: DeviceSnapshot): string {
  return stateLabel(instanceState(instance, snapshot))
}
export function instanceState(instance: DeviceInstance, snapshot: DeviceSnapshot): string | undefined {
  const state = snapshot.runtime[instance.id]?.state
  if (
    instance.binding &&
    !snapshot.scanning &&
    !snapshot.discovered.some(device => device.id === instance.binding && device.connected)
  ) {
    return state === 'needsRebind' ? state : 'disconnected'
  }
  return state
}

export const deviceCardOrderKey = 'axonkey.device-hub-card-order.v1'
export const systemMouseCardId = 'system-mouse'

export function getStoredDeviceCardOrder(): string[] {
  if (typeof window === 'undefined') return []
  try {
    const value = JSON.parse(appStorage.getItem(deviceCardOrderKey) ?? '[]')
    return Array.isArray(value) ? value.filter((id): id is string => typeof id === 'string') : []
  } catch {
    return []
  }
}

export function saveDeviceCardOrder(order: string[]) {
  try {
    appStorage.setItem(deviceCardOrderKey, JSON.stringify(order))
  } catch {
    /* UI preference is best-effort. */
  }
}

export function buildWorkspaceDeviceOptions(
  instances: DeviceInstance[],
  savedOrder: string[] = getStoredDeviceCardOrder(),
) {
  const byId = new Map(instances.map(item => [item.id, item]))
  const allIds = [...instances.map(item => item.id), systemMouseCardId]
  const available = new Set(allIds)
  const orderedIds = [...savedOrder.filter(id => available.has(id)), ...allIds.filter(id => !savedOrder.includes(id))]
  const nameCounts = new Map<string, number>([['系统鼠标', 1]])
  for (const item of instances) {
    nameCounts.set(item.name, (nameCounts.get(item.name) ?? 0) + 1)
  }
  return orderedIds.map(id => {
    const item = byId.get(id)
    if (!item) {
      return { id: systemMouseCardId, name: '系统鼠标', artwork: '/mouse-device.svg' }
    }
    const duplicate = (nameCounts.get(item.name) ?? 0) > 1
    return {
      id: item.id,
      name: item.name,
      artwork: packageFor(item.kind).artwork,
      ...(duplicate ? { detail: `${packageFor(item.kind).model} · ${item.id.slice(-4)}` } : {}),
    }
  })
}
