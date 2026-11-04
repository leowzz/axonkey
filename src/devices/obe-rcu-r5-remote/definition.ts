import type { DeviceSupportPackage } from '../types.ts'
import { obeRcuR5RemoteView } from './view.ts'

export const obeRcuR5SupportPackage: DeviceSupportPackage = {
  kind: 'obeRcuR5',
  name: '投影仪语音遥控器 OBE_RCU_R5',
  model: 'OBE_RCU_R5',
  artwork: obeRcuR5RemoteView.artworkUrl,
  inputs: obeRcuR5RemoteView.buttons,
  remoteView: obeRcuR5RemoteView,
}
