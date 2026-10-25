import type { TriggerBehaviors } from '../../behaviorModel'
import { xiaomiRemoteButtons } from '../xiaomi-remote/buttons'
import { xiaomiRemoteView } from '../xiaomi-remote/view'
import xboxArtwork from '../xbox-controller/xbox-controller.svg'
import { cmiotA15RemoteDevice } from '../cmiot-a15-remote/definition'

export type DeviceKind = 'xboxBluetooth' | 'rc003' | 'cmiotA15'
export type InstanceProfile = { id: string; name: string; behaviors: Record<string, TriggerBehaviors> }
export type DeviceInstance = { id: string; kind: DeviceKind; name: string; binding: string | null; bindingQuality?: string | null; bindingPairingId?: string | null; enabled: boolean; capture: 'shared' | 'exclusive'; profiles: InstanceProfile[]; activeProfileId: string; legacyProfilesMigrated?: boolean }
export type DiscoveredDevice = { id: string; kind: DeviceKind; name: string; transport: string; identityQuality: 'serial' | 'session' | 'ambiguous'; vendorId: number; productId: number; connected: boolean; paired: boolean; pairingId?: string | null }
export type DeviceSnapshot = { store: { version: number; revision: number; instances: DeviceInstance[] }; discovered: DiscoveredDevice[]; runtime: Record<string, { state: string; error: string | null; reports: number }>; error: string | null; scanError: string | null; scanning: boolean }
export const emptySnapshot = (): DeviceSnapshot => ({ store: { version: 1, revision: 0, instances: [] }, discovered: [], runtime: {}, error: null, scanError: null, scanning: false })
export const xboxInputs = [
  ['a', 'A 键'], ['b', 'B 键'], ['x', 'X 键'], ['y', 'Y 键'],
  ['lb', 'LB 左肩键'], ['rb', 'RB 右肩键'], ['lt', 'LT 左扳机'], ['rt', 'RT 右扳机'],
  ['view', 'View 视图键'], ['menu', 'Menu 菜单键'], ['guide', '主键'], ['ls', 'LS 左摇杆按下'], ['rs', 'RS 右摇杆按下'],
  ['dpad.up', '方向键向上'], ['dpad.down', '方向键向下'], ['dpad.left', '方向键向左'], ['dpad.right', '方向键向右'],
  ['ls.up', '左摇杆向上'], ['ls.down', '左摇杆向下'], ['ls.left', '左摇杆向左'], ['ls.right', '左摇杆向右'],
  ['rs.up', '右摇杆向上'], ['rs.down', '右摇杆向下'], ['rs.left', '右摇杆向左'], ['rs.right', '右摇杆向右'],
].map(([id, label]) => ({ id: `xbox.${id}`, label, icon: 'center' as const }))
export const supportPackages = [
  { kind: 'xboxBluetooth' as const, name: '标准手柄', model: 'Xbox 蓝牙 · 045E:02E0', artwork: xboxArtwork, inputs: xboxInputs, note: 'A/B/X/Y、肩键、扳机、十字键和双摇杆；主键依固件上报情况。' },
  { kind: 'rc003' as const, name: '小米遥控器', model: 'RC003', artwork: xiaomiRemoteView.artworkUrl, inputs: xiaomiRemoteButtons, note: 'macOS 支持按物理实例绑定；Windows 继续使用现有驱动工作区。' },
  { kind: 'cmiotA15' as const, name: '移动遥控器', model: 'CMIOT A15', artwork: cmiotA15RemoteDevice.remoteView!.artworkUrl, inputs: cmiotA15RemoteDevice.buttons!, note: '可先建立配置；硬件识别和输入适配尚待验证。' },
]
export const packageFor = (kind: DeviceKind) => supportPackages.find(p => p.kind === kind)!
export const emptyTriggers = (): TriggerBehaviors => ({ click: [], doubleClick: [], longPress: [] })
export function newInstance(kind: DeviceKind, binding: string | null): DeviceInstance {
  return { id: '', kind, name: packageFor(kind).name, binding, enabled: true, capture: 'shared', activeProfileId: 'default', profiles: [{ id: 'default', name: '默认配置', behaviors: {} }] }
}
export function stateLabel(state?: string): string {
  return ({ paused: '已暂停', unbound: '等待绑定', disconnected: '未连接', needsRebind: '未连接 · 需重新绑定', opening: '正在连接', error: '需要处理', listening: '共享监听中', exclusive: '独占拦截中', filtered: '兼容拦截中', unsupported: '等待输入适配' } as Record<string, string>)[state ?? ''] ?? '等待启动'
}
export function instanceStatusLabel(instance: DeviceInstance, snapshot: DeviceSnapshot): string {
  const state = snapshot.runtime[instance.id]?.state
  if (instance.binding && !snapshot.scanning && !snapshot.discovered.some(device => device.id === instance.binding && device.connected)) {
    return stateLabel(state === 'needsRebind' ? state : 'disconnected')
  }
  return stateLabel(state)
}
