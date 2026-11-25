import type { DeviceSupportPackage } from '../types.ts'
import { axonkeyMobileView } from './view.ts'

export const axonkeyMobileSupportPackage: DeviceSupportPackage = {
  kind: 'axonkeyMobile',
  name: 'Axonkey Mobile',
  model: 'Axonkey Mobile',
  artwork: axonkeyMobileView.artworkUrl,
  inputs: axonkeyMobileView.buttons,
  remoteView: axonkeyMobileView,
}
