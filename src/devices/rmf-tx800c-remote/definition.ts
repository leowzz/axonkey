import { createDescriptorView } from '../shared/descriptorSvg.ts'
import type { DeviceSupportPackage } from '../types.ts'

const remoteView = createDescriptorView('rmf-tx800c')

export const rmfTx800cSupportPackage: DeviceSupportPackage = {
  kind: 'rmfTx800c',
  name: 'Sony RMF-TX800C',
  model: 'RMF-TX800C',
  artwork: remoteView.artworkUrl,
  inputs: remoteView.buttons,
  remoteView,
}
