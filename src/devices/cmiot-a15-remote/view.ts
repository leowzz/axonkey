import type { RemoteView } from '../types.ts'
import { cmiotA15RemoteButtons } from './buttons.ts'
import { cmiotA15RemoteKeyRegions, cmiotA15RemoteViewBox } from './geometry.ts'

export { cmiotA15RemoteButtonIds, cmiotA15RemoteButtons } from './buttons.ts'
export { cmiotA15RemoteKeyRegions, cmiotA15RemoteViewBox } from './geometry.ts'

export const cmiotA15RemoteView: RemoteView = {
  buttons: cmiotA15RemoteButtons,
  viewBox: cmiotA15RemoteViewBox,
  keyRegions: cmiotA15RemoteKeyRegions,
  artworkUrl: '/cmiot-a15-remote-keymap.svg',
  ariaLabel: '移动遥控器 CMIOT-A15 按键',
}
