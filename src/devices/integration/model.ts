import type { TriggerBehaviors } from '../../behaviorModel'
import type { DeviceKind, DeviceSupportPackage } from '../types.ts'
import { xiaomiRemoteSupportPackage } from '../xiaomi-remote/definition.ts'
import { cmiotA15SupportPackage } from '../cmiot-a15-remote/definition.ts'
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
  cmiotA15RecordingModeEditable?: boolean
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
    cmiotA15RecordingMode: 'hold',
    cmiotA15RecordingModeEditable: false,
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
