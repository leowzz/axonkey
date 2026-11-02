import type { DeviceSupportPackage } from '../types.ts'
import artwork from './xbox-controller.svg'
import { xboxInputs } from './inputs.ts'

export const xboxSupportPackage: DeviceSupportPackage = {
  kind: 'xboxBluetooth',
  name: '标准手柄',
  model: 'Xbox 蓝牙 · 045E:02E0',
  artwork,
  inputs: xboxInputs,
}
