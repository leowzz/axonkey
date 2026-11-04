import type { DeviceDefinition, DeviceSupportPackage } from '../types.ts'
import { cmiotA15RemoteButtonIds, cmiotA15RemoteView } from './view.ts'

export const cmiotA15RemoteDevice: DeviceDefinition = {
  id: 'cmiotA15',
  name: '移动遥控器CMIOT-A15',
  model: 'CMIOT-A15',
  inputIds: cmiotA15RemoteButtonIds,
  inputKind: 'button',
  buttons: cmiotA15RemoteView.buttons,
  remoteView: cmiotA15RemoteView,
}

export const cmiotA15SupportPackage: DeviceSupportPackage = {
  kind: 'cmiotA15',
  name: 'CMIOT-A15',
  model: 'CMIOT-A15',
  artwork: cmiotA15RemoteView.artworkUrl,
  inputs: cmiotA15RemoteView.buttons,
  remoteView: cmiotA15RemoteView,
}
