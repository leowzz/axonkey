import type { TriggerBehaviors } from '../../behaviorModel'
import type { ApplicationProfile } from '../../applications'
import type { DeviceKind, DeviceSupportPackage } from '../types.ts'
import { xiaomiRemoteSupportPackage } from '../xiaomi-remote/definition.ts'
import { cmiotA15SupportPackage } from '../cmiot-a15-remote/definition.ts'
import { xmBt29SupportPackage } from '../xm-bt-29-remote/definition.ts'
import { obeRcuR5SupportPackage } from '../obe-rcu-r5-remote/definition.ts'
import { rc313SupportPackage } from '../rc-313-remote/definition.ts'
import { xboxSupportPackage } from '../xbox-controller/index.ts'

export type { DeviceKind } from '../types.ts'
export type InstanceProfile = { id: string; name: string; behaviors: Record<string, TriggerBehaviors> }
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
    }
  >
  error: string | null
  scanError: string | null
  scanning: boolean
}
export const supportPackages: readonly DeviceSupportPackage[] = [
  xboxSupportPackage,
  xiaomiRemoteSupportPackage,
  cmiotA15SupportPackage,
  xmBt29SupportPackage,
  rc313SupportPackage,
  obeRcuR5SupportPackage,
]
const mobileRemotePackages = supportPackages.filter(pkg =>
  pkg.remoteView?.identities.some(identity => identity.softwareContains),
)
export const mobileRemoteKinds = mobileRemotePackages.map(pkg => pkg.kind)
export const mobileRemoteFallbackKind = mobileRemotePackages.find(pkg =>
  pkg.remoteView?.identities.some(identity => identity.softwareFallback),
)!.kind
export function isMobileRemoteDevice(device: Pick<DiscoveredDevice, 'vendorId' | 'productId'>) {
  return mobileRemotePackages.some(pkg =>
    pkg.remoteView!.identities.some(
      identity => identity.vendorIds.includes(device.vendorId) && identity.productIds.includes(device.productId),
    ),
  )
}
export function isMobileRemoteKind(kind: DeviceKind | undefined): kind is (typeof mobileRemoteKinds)[number] {
  return kind !== undefined && mobileRemoteKinds.includes(kind as (typeof mobileRemoteKinds)[number])
}
export function mobileRemoteKindForSoftware(software: string | null | undefined): DeviceKind | null {
  if (!software) return null
  return (
    mobileRemotePackages.find(pkg =>
      pkg.remoteView!.identities.some(
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
export const packageFor = (kind: DeviceKind) => supportPackages.find(p => p.kind === kind)!
export function usesHidVoice(kind: DeviceKind | undefined) {
  const engine = kind && packageFor(kind).remoteView?.voice?.engine
  return engine === 'cmiot-a15.g7221' || engine === 'obe-rcu-r5.sbc'
}
export function supportsWindowsDriver(kind: DeviceKind | undefined) {
  return kind !== undefined && packageFor(kind).remoteView!.identities.some(identity => identity.windowsPrefix)
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
        exclusive: '独占拦截中',
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
    const value = JSON.parse(window.localStorage.getItem(deviceCardOrderKey) ?? '[]')
    return Array.isArray(value) ? value.filter((id): id is string => typeof id === 'string') : []
  } catch {
    return []
  }
}

export function saveDeviceCardOrder(order: string[]) {
  try {
    window.localStorage.setItem(deviceCardOrderKey, JSON.stringify(order))
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
