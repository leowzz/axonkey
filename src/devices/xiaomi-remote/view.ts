import type { RemoteView } from '../types.ts'
import { xiaomiRemoteButtons } from './buttons.ts'
import { xiaomiRemoteKeyRegions, xiaomiRemoteViewBox } from './geometry.ts'

export { xiaomiRemoteButtonIds, xiaomiRemoteButtons } from './buttons.ts'
export { xiaomiRemoteKeyRegions, xiaomiRemoteViewBox } from './geometry.ts'

export const xiaomiRemoteView: RemoteView = {
  buttons: xiaomiRemoteButtons,
  viewBox: xiaomiRemoteViewBox,
  keyRegions: xiaomiRemoteKeyRegions,
  artworkUrl: '/rc003-remote-keymap.svg',
  ariaLabel: '小米 RC003 遥控器按键',
}
