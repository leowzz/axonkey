import type { CmiotA15RecordingMode, RemoteButton } from '../appTypes'
import type { XiaomiRemoteButtonId } from './xiaomi-remote/buttons.ts'
import type { CmiotA15RemoteButtonId } from './cmiot-a15-remote/buttons.ts'
import type { MouseInputId } from './system-mouse/inputs.ts'

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


export type RemoteButtonId = XiaomiRemoteButtonId | CmiotA15RemoteButtonId
export type InputId = RemoteButtonId | MouseInputId
export type DeviceId = 'rc003' | 'cmiotA15' | 'mouse'

export type DeviceSettingsPageProps = {
  cmiotA15RecordingMode: CmiotA15RecordingMode
  onCmiotA15RecordingModeChange: (mode: CmiotA15RecordingMode) => void
  onBackToDevices: () => void
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
