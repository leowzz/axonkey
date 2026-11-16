import type { DeviceSupportPackage } from '../types.ts'
import { kivoK18LiteView } from './view.ts'

export const kivoK18LiteSupportPackage: DeviceSupportPackage = {
  kind: 'kivoK18Lite',
  name: 'Kivo K18 Lite',
  model: 'K18 Lite',
  artwork: kivoK18LiteView.artworkUrl,
  inputs: kivoK18LiteView.buttons,
  remoteView: kivoK18LiteView,
  workspaceLayout: 'single-lane',
  screenRegion: {
    label: 'OLED 屏幕',
    path: 'M 43 45 H 233 A 8 8 0 0 1 241 53 V 119 A 8 8 0 0 1 233 127 H 43 A 8 8 0 0 1 35 119 V 53 A 8 8 0 0 1 43 45 Z',
  },
}
