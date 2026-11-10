import type { RemoteView } from '../types.ts'
import { xmBt29RemoteButtons } from './buttons.ts'
import { xmBt29RemoteKeyRegions, xmBt29RemoteViewBox } from './geometry.ts'

export { xmBt29RemoteButtonIds, xmBt29RemoteButtons } from './buttons.ts'
export { xmBt29RemoteKeyRegions, xmBt29RemoteViewBox } from './geometry.ts'

export const xmBt29RemoteView: RemoteView = {
  buttons: xmBt29RemoteButtons,
  viewBox: xmBt29RemoteViewBox,
  keyRegions: xmBt29RemoteKeyRegions,
  artworkUrl: '/device-descriptors/xm-bt-29.svg',
  ariaLabel: '移动遥控器 XM-BT-29 按键',
}
