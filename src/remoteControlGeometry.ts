// Backwards-compatible exports for consumers of the old shared module. The
// Xiaomi-specific geometry now lives beside its device implementation.
export { xiaomiRemoteKeyRegions as remoteKeyRegions, xiaomiRemoteViewBox as remoteViewBox } from './devices/xiaomi-remote/index.ts'
