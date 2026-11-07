import type { DeviceDefinition, DeviceSupportPackage } from '../types.ts'
import { xiaomiRemoteButtonIds, xiaomiRemoteView } from './view.ts'

export const xiaomiRemoteDevice: DeviceDefinition = {
  id: 'rc003',
  name: '小米蓝牙遥控器2Pro',
  model: 'RC003',
  inputIds: xiaomiRemoteButtonIds,
  inputKind: 'button',
  buttons: xiaomiRemoteView.buttons,
  remoteView: xiaomiRemoteView,
}

export const xiaomiRemoteSupportPackage: DeviceSupportPackage = {
  kind: 'rc003',
  name: '小米蓝牙遥控器2Pro',
  model: 'RC003',
  artwork: xiaomiRemoteView.artworkUrl,
  inputs: xiaomiRemoteView.buttons,
  remoteView: xiaomiRemoteView,
}
