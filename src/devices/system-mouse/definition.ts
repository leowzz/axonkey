import type { DeviceDefinition } from '../types.ts'
import { mouseInputIds } from './inputs.ts'

export const systemMouseDevice: DeviceDefinition = {
  id: 'mouse', name: '系统鼠标', model: 'SYSTEM-MOUSE',
  inputIds: mouseInputIds, inputKind: 'mouse',
}
