import type { DeviceSupportPackage } from '../types.ts'
import { rc313RemoteView } from './view.ts'

export const rc313SupportPackage: DeviceSupportPackage = {
  kind: 'rc313',
  name: 'RC-313',
  model: 'RC-313',
  artwork: rc313RemoteView.artworkUrl,
  inputs: rc313RemoteView.buttons,
  remoteView: rc313RemoteView,
}
