import type { DeviceDefinition, InputId } from './types.ts'
import { xiaomiRemoteDevice } from './xiaomi-remote/definition.ts'
import { cmiotA15RemoteDevice } from './cmiot-a15-remote/definition.ts'
import { systemMouseDevice } from './system-mouse/definition.ts'

export const devices: readonly DeviceDefinition[] = [xiaomiRemoteDevice, cmiotA15RemoteDevice, systemMouseDevice]
export const inputIds: readonly InputId[] = devices.flatMap((device) => device.inputIds)
export function deviceForInput(id: InputId): DeviceDefinition {
  return devices.find((device) => device.inputIds.includes(id))!
}
