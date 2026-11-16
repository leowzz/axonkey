import type { DeviceSupportPackage } from '../types.ts'
import { kivoK18LiteView } from './view.ts'

export const kivoK18LiteSupportPackage: DeviceSupportPackage = {
  kind: 'kivoK18Lite',
  name: 'Kivo K18 Lite',
  model: 'K18 Lite',
  artwork: kivoK18LiteView.artworkUrl,
  inputs: kivoK18LiteView.buttons,
  remoteView: kivoK18LiteView,
}
