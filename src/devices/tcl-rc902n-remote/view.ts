import type { RemoteView } from '../types.ts'
import { tclRc902nRemoteButtons } from './buttons.ts'
import { tclRc902nRemoteKeyRegions, tclRc902nRemoteViewBox } from './geometry.ts'

export { tclRc902nRemoteButtonIds, tclRc902nRemoteButtons } from './buttons.ts'
export { tclRc902nRemoteKeyRegions, tclRc902nRemoteViewBox } from './geometry.ts'

export const tclRc902nRemoteView: RemoteView = {
  buttons: tclRc902nRemoteButtons,
  viewBox: tclRc902nRemoteViewBox,
  keyRegions: tclRc902nRemoteKeyRegions,
  artworkUrl: '/tcl-rc902n-remote-keymap.svg',
  ariaLabel: 'TCL RC902N 按键',
}
