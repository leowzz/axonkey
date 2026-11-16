import type { DeviceSupportPackage } from '../types.ts'
import { phicommDb1RRemoteView } from './view.ts'

export const phicommDb1RSupportPackage: DeviceSupportPackage = {
  kind: 'phicommDb1R',
  name: '斐讯 DB1-R',
  model: 'DB1-R',
  artwork: phicommDb1RRemoteView.artworkUrl,
  inputs: phicommDb1RRemoteView.buttons,
  remoteView: phicommDb1RRemoteView,
}
