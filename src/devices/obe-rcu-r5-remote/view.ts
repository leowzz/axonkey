import type { RemoteView } from '../types.ts'
import { obeRcuR5RemoteButtons } from './buttons.ts'
import { obeRcuR5RemoteKeyRegions, obeRcuR5RemoteViewBox } from './geometry.ts'

export { obeRcuR5RemoteButtonIds, obeRcuR5RemoteButtons } from './buttons.ts'
export { obeRcuR5RemoteKeyRegions, obeRcuR5RemoteViewBox } from './geometry.ts'

export const obeRcuR5RemoteView: RemoteView = {
  buttons: obeRcuR5RemoteButtons,
  viewBox: obeRcuR5RemoteViewBox,
  keyRegions: obeRcuR5RemoteKeyRegions,
  artworkUrl: '/obe-rcu-r5-remote-keymap.svg',
  ariaLabel: '投影仪语音遥控器 OBE_RCU_R5 按键',
}
