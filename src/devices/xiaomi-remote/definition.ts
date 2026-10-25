import type { DeviceDefinition } from '../types.ts'
import { xiaomiRemoteButtonIds, xiaomiRemoteView } from './view.ts'

export const xiaomiRemoteDevice: DeviceDefinition = {
  id: 'rc003', name: '小米遥控器', model: 'RC003',
  inputIds: xiaomiRemoteButtonIds, inputKind: 'button',
  buttons: xiaomiRemoteView.buttons, remoteView: xiaomiRemoteView,
}
