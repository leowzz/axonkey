/** Compatibility entry point; implementations live under devices/. */
export type { DeviceId, DeviceDefinition, InputId, RemoteButtonId } from './devices/types.ts'
export { devices, inputIds, deviceForInput } from './devices/registry.ts'
export { xiaomiRemoteButtonIds as remoteButtonIds } from './devices/xiaomi-remote/buttons.ts'
export { cmiotA15RemoteButtonIds as cmiotA15ButtonIds } from './devices/cmiot-a15-remote/buttons.ts'
export * from './devices/system-mouse/inputs.ts'
