import type { DeviceSupportPackage } from '../types.ts'
import { xmBt29RemoteView } from './view.ts'

export const xmBt29SupportPackage: DeviceSupportPackage = {
  kind: 'xmBt29',
  name: 'XM-BT-29',
  model: 'XM-BT-29',
  artwork: xmBt29RemoteView.artworkUrl,
  inputs: xmBt29RemoteView.buttons,
  remoteView: xmBt29RemoteView,
}
