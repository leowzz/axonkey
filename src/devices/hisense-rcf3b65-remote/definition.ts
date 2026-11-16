import type { DeviceSupportPackage } from '../types.ts'
import { hisenseRcf3b65RemoteView } from './view.ts'

export const hisenseRcf3b65SupportPackage: DeviceSupportPackage = {
  kind: 'hisenseRcf3b65',
  name: 'Hisense RCF3B65',
  model: 'RCF3B65',
  artwork: hisenseRcf3b65RemoteView.artworkUrl,
  inputs: hisenseRcf3b65RemoteView.buttons,
  remoteView: hisenseRcf3b65RemoteView,
}
