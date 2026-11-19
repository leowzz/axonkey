import type { DeviceSupportPackage } from '../types.ts'
import { oneplusRc001aRemoteView } from './view.ts'

export const oneplusRc001aSupportPackage: DeviceSupportPackage = {
  kind: 'oneplusRc001a',
  name: 'OnePlus RC-001A',
  model: 'RC-001A',
  artwork: oneplusRc001aRemoteView.artworkUrl,
  inputs: oneplusRc001aRemoteView.buttons,
  remoteView: oneplusRc001aRemoteView,
}
