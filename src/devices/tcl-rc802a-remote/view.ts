import type { RemoteView } from '../types.ts'
import { tclRc802aRemoteButtons } from './buttons.ts'
import { tclRc802aRemoteKeyRegions, tclRc802aRemoteViewBox } from './geometry.ts'

export { tclRc802aRemoteButtonIds, tclRc802aRemoteButtons } from './buttons.ts'
export { tclRc802aRemoteKeyRegions, tclRc802aRemoteViewBox } from './geometry.ts'

export const tclRc802aRemoteView: RemoteView = {
  buttons: tclRc802aRemoteButtons,
  viewBox: tclRc802aRemoteViewBox,
  keyRegions: tclRc802aRemoteKeyRegions,
  artworkUrl: '/tcl-rc802a-remote-keymap.svg',
  ariaLabel: 'TCL RC802A 按键',
}
