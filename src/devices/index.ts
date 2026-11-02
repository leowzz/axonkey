export type {
  DeviceId,
  DeviceDefinition,
  DeviceKind,
  DeviceSupportPackage,
  InputId,
  RemoteButtonId,
  RemoteView,
  RemoteKeyRegion,
} from './types.ts'
export { devices, inputIds, deviceForInput } from './registry.ts'
export * from './xiaomi-remote/index.ts'
export * from './cmiot-a15-remote/index.ts'
export * from './system-mouse/index.ts'
