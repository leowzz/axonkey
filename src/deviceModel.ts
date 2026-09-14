/** Device identity and input capabilities are independent of output behaviors. */
export const remoteButtonIds = ['power', 'voice', 'up', 'left', 'confirm', 'right', 'down', 'back', 'volumeUp', 'home', 'volumeDown', 'menu', 'tv'] as const
export const mouseInputIds = ['mouse.top.up', 'mouse.top.down', 'mouse.top.left', 'mouse.top.right', 'mouse.left.up', 'mouse.left.down', 'mouse.right.up', 'mouse.right.down'] as const
export type RemoteButtonId = typeof remoteButtonIds[number]
export type MouseInputId = typeof mouseInputIds[number]
export type InputId = RemoteButtonId | MouseInputId
export type DeviceId = 'rc003' | 'mouse'
export type DeviceDefinition = {
  id: DeviceId
  name: string
  inputIds: readonly InputId[]
  inputKind: 'button' | 'edgeScroll'
}
export const devices: readonly DeviceDefinition[] = [
  { id: 'rc003', name: '小米遥控器', inputIds: remoteButtonIds, inputKind: 'button' },
  { id: 'mouse', name: '鼠标', inputIds: mouseInputIds, inputKind: 'edgeScroll' },
]
export const inputIds: readonly InputId[] = devices.flatMap((device) => device.inputIds)
export function deviceForInput(id: InputId): DeviceDefinition {
  return devices.find((device) => device.inputIds.includes(id))!
}
