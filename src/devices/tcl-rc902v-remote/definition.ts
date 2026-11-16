import type { DeviceSupportPackage } from '../types.ts'
import { tclRc902vRemoteView } from './view.ts'

export const tclRc902vSupportPackage: DeviceSupportPackage = {
  kind: 'tclRc902v',
  name: 'TCL RC902V',
  model: 'RC902V',
  artwork: tclRc902vRemoteView.artworkUrl,
  inputs: tclRc902vRemoteView.buttons,
  remoteView: tclRc902vRemoteView,
}
