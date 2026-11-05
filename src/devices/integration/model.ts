import type { TriggerBehaviors } from '../../behaviorModel'
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
      driverInstalled?: boolean
      driverState?: string
    }
  >
  error: string | null
  scanError: string | null
  scanning: boolean
}
export const mobileRemoteKinds = ['cmiotA15', 'xmBt29', 'rc313'] as const
export function isMobileRemoteDevice(device: Pick<DiscoveredDevice, 'vendorId' | 'productId'>) {
  return device.vendorId === 0x0416 && device.productId === 0x0300
}
export function isMobileRemoteKind(kind: DeviceKind | undefined): kind is (typeof mobileRemoteKinds)[number] {
  return kind !== undefined && mobileRemoteKinds.includes(kind as (typeof mobileRemoteKinds)[number])
}
export function mobileRemoteKindForSoftware(software: string | null | undefined): DeviceKind | null {
  if (!software) return null
  if (software.includes('CMIOT3_B311')) return 'cmiotA15'
  if (software.includes('XFRSD0D_M_R01_761')) return 'xmBt29'
  if (software.includes('CMIOT18_B302')) return 'rc313'
  return null
}
export const emptySnapshot = (): DeviceSnapshot => ({
  store: { version: 1, revision: 0, instances: [] },
  discovered: [],
  runtime: {},
  error: null,
  scanError: null,
  scanning: false,
})
export const supportPackages: readonly DeviceSupportPackage[] = [
  xboxSupportPackage,
  xiaomiRemoteSupportPackage,
  cmiotA15SupportPackage,
  xmBt29SupportPackage,
  rc313SupportPackage,
  obeRcuR5SupportPackage,
]
export const packageFor = (kind: DeviceKind) => supportPackages.find(p => p.kind === kind)!
export const emptyTriggers = (): TriggerBehaviors => ({ click: [], doubleClick: [], longPress: [] })
export function newInstance(kind: DeviceKind, binding: string | null): DeviceInstance {
  return {
    id: '',
    kind,
    name: packageFor(kind).name,
    binding,
    audioGainDb: 0,
    cmiotA15RecordingMode: kind === 'xmBt29' || kind === 'rc313' || kind === 'obeRcuR5' ? 'hold' : 'click',
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
  const state = snapshot.runtime[instance.id]?.state
  if (
    instance.binding &&
    !snapshot.scanning &&
    !snapshot.discovered.some(device => device.id === instance.binding && device.connected)
  ) {
    return stateLabel(state === 'needsRebind' ? state : 'disconnected')
  }
  return stateLabel(state)
}
