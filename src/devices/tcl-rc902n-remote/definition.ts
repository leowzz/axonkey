import type { DeviceSupportPackage } from '../types.ts'
import { tclRc902nRemoteView } from './view.ts'

export const tclRc902nSupportPackage: DeviceSupportPackage = {
  kind: 'tclRc902n',
  name: 'TCL RC902N',
  model: 'RC902N',
  artwork: tclRc902nRemoteView.artworkUrl,
  inputs: tclRc902nRemoteView.buttons,
  remoteView: tclRc902nRemoteView,
}
