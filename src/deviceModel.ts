/** Device identity and input capabilities are independent of output behaviors. */
export const remoteButtonIds = ['power', 'voice', 'up', 'left', 'confirm', 'right', 'down', 'back', 'volumeUp', 'home', 'volumeDown', 'menu', 'tv'] as const
export const mouseScopes = [
  { id: 'global', label: '任意位置', description: '指针位于任意位置时生效' },
  { id: 'top', label: '上边缘', description: '指针靠近屏幕上边缘时生效' },
  { id: 'left', label: '左边缘', description: '指针靠近屏幕左边缘时生效' },
  { id: 'right', label: '右边缘', description: '指针靠近屏幕右边缘时生效' },
] as const
export const mouseControls = [
  { id: 'buttonLeft', label: '鼠标左键', kind: 'button', icon: 'center' },
  { id: 'buttonForward', label: '鼠标前进键', kind: 'button', icon: 'center' },
  { id: 'buttonBack', label: '鼠标后退键', kind: 'button', icon: 'center' },
  { id: 'buttonRight', label: '鼠标右键', kind: 'button', icon: 'center' },
  { id: 'up', label: '向上滚动', kind: 'wheel', icon: 'up' },
  { id: 'down', label: '向下滚动', kind: 'wheel', icon: 'down' },
  { id: 'left', label: '向左滚动', kind: 'wheel', icon: 'left' },
  { id: 'right', label: '向右滚动', kind: 'wheel', icon: 'right' },
] as const
export type MouseScopeId = typeof mouseScopes[number]['id']
export type MouseControlId = typeof mouseControls[number]['id']
export type RemoteButtonId = typeof remoteButtonIds[number]
export type MouseInputId = Exclude<`mouse.${MouseScopeId}.${MouseControlId}`, 'mouse.global.buttonLeft' | 'mouse.global.buttonRight' | 'mouse.global.up' | 'mouse.global.down' | 'mouse.global.left' | 'mouse.global.right'>
export function mouseControlAllowsGlobal(control: MouseControlId) {
  return control === 'buttonForward' || control === 'buttonBack'
}
export function mouseScopesForControl(control: MouseControlId) {
  return mouseScopes.filter((scope) => scope.id !== 'global' || mouseControlAllowsGlobal(control))
}
export function mouseInputId(scope: MouseScopeId, control: MouseControlId): MouseInputId {
  const allowedScopes = mouseScopesForControl(control)
  const selectedScope = allowedScopes.find((item) => item.id === scope) ?? allowedScopes[0]
  return `mouse.${selectedScope.id}.${control}` as MouseInputId
}
export const mouseInputIds = mouseControls.flatMap((control) => mouseScopesForControl(control.id).map((scope) => mouseInputId(scope.id, control.id)))
export function mouseInputParts(id: InputId) {
  const [, scopeId, controlId] = id.split('.')
  return {
    scope: mouseScopes.find((scope) => scope.id === scopeId) ?? mouseScopes[0],
    control: mouseControls.find((control) => control.id === controlId) ?? mouseControls[0],
  }
}
export type InputId = RemoteButtonId | MouseInputId
export type DeviceId = 'rc003' | 'mouse'
export type DeviceDefinition = {
  id: DeviceId
  name: string
  inputIds: readonly InputId[]
  inputKind: 'button' | 'mouse'
}
export const devices: readonly DeviceDefinition[] = [
  { id: 'rc003', name: '小米遥控器', inputIds: remoteButtonIds, inputKind: 'button' },
  { id: 'mouse', name: '鼠标', inputIds: mouseInputIds, inputKind: 'mouse' },
]
export const inputIds: readonly InputId[] = devices.flatMap((device) => device.inputIds)
export function deviceForInput(id: InputId): DeviceDefinition {
  return devices.find((device) => device.inputIds.includes(id))!
}
