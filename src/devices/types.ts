import type { CmiotA15RecordingMode, MappingInput, RemoteButton } from '../appTypes'

export type RemoteKeyRegion = {
  path: string
  anchor: { x: number; y: number }
}

export type RemoteView = {
  buttons: readonly RemoteButton[]
  viewBox: { width: number; height: number }
  keyRegions: Record<string, RemoteKeyRegion>
  artworkUrl: string
  ariaLabel: string
}

export type RemoteButtonId = string
export type InputId = string
export type DeviceId = 'rc003' | 'cmiotA15' | 'mouse'
export type DeviceKind = string

export type DeviceSupportPackage = {
  version: number
  adapter: string
  hardwareId: string
  capabilities: import('./packages.ts').PackageDefinition['capabilities']
  kind: DeviceKind
  name: string
  model: string
  artwork: string
  inputs: readonly MappingInput<string>[]
  remoteView?: RemoteView
}

export type DeviceSettingsPageProps = {
  onOpenAudioDriver: () => void
  cmiotA15RecordingMode: CmiotA15RecordingMode
  onCmiotA15RecordingModeChange: (mode: CmiotA15RecordingMode) => void
  showMouseKeyGrid: boolean
  onShowMouseKeyGridChange: (value: boolean) => void
  mouseIgnoreScrollAcceleration: boolean
  onMouseIgnoreScrollAccelerationChange: (value: boolean) => void
  mouseScrollSensitivity: number
  onMouseScrollSensitivityChange: (value: number) => void
  mouseVerticalScrollIntervalMs: number
  onMouseVerticalScrollIntervalMsChange: (ms: number) => void
  mouseHorizontalScrollIntervalMs: number
  onMouseHorizontalScrollIntervalMsChange: (ms: number) => void
  mouseEdgeWidth: number
  onMouseEdgeWidthChange: (value: number) => void
  mouseKeyHoldMs: number
  onMouseKeyHoldMsChange: (ms: number) => void
}

export type DeviceDefinition = {
  id: DeviceId
  name: string
  model: string
  inputIds: readonly InputId[]
  inputKind: 'button' | 'mouse'
  buttons?: readonly RemoteButton[]
  remoteView?: RemoteView
}
