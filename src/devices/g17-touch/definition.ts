import type { DeviceSupportPackage } from '../types.ts'
import { g17TouchView } from './view.ts'

export const g17TouchSupportPackage: DeviceSupportPackage = {
  kind: 'g17Touch',
  name: 'G17 Touch',
  model: 'G17 Touch',
  artwork: g17TouchView.artworkUrl,
  inputs: g17TouchView.buttons,
  remoteView: g17TouchView,
  workspaceLayout: 'single-lane',
}
