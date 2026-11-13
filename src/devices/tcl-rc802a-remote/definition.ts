import type { DeviceSupportPackage } from '../types.ts'
import { tclRc802aRemoteView } from './view.ts'

export const tclRc802aSupportPackage: DeviceSupportPackage = {
  kind: 'tclRc802a',
  name: 'TCL RC802A',
  model: 'RC802A',
  artwork: tclRc802aRemoteView.artworkUrl,
  inputs: tclRc802aRemoteView.buttons,
  remoteView: tclRc802aRemoteView,
}
