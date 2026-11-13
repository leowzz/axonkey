import type { CmiotA15RecordingMode, MappingInput, RemoteButton } from '../appTypes'
import type { XiaomiRemoteButtonId } from './xiaomi-remote/buttons.ts'
import type { CmiotA15RemoteButtonId } from './cmiot-a15-remote/buttons.ts'
import type { XmBt29RemoteButtonId } from './xm-bt-29-remote/buttons.ts'
import type { ObeRcuR5RemoteButtonId } from './obe-rcu-r5-remote/buttons.ts'
import type { HisenseRcf3b65RemoteButtonId } from './hisense-rcf3b65-remote/buttons.ts'
import type { PhicommDb1RRemoteButtonId } from './phicomm-db1-r-remote/buttons.ts'
import type { MouseInputId } from './system-mouse/inputs.ts'

export type RemoteKeyRegion = {
  path: string
  anchor: { x: number; y: number }
  transform?: string
}

export type RemoteView<Id extends string = string> = {
  buttons: readonly (RemoteButton<Id> & { kind: string; threshold: number; releaseThreshold: number })[]
  identities: readonly {
    vendorIds: readonly number[]
    productIds: readonly number[]
    softwareContains: string
    softwareFallback: boolean
    windowsPrefix: string
    informationRequired: boolean
    modelContains: string
    manufacturerContains: string
  }[]
  voice: { engine: string; transport: string; triggerModes: readonly string[] } | null
  viewBox: { width: number; height: number }
  keyRegions: Record<string, RemoteKeyRegion>
  artworkUrl: string
  ariaLabel: string
}

export type RemoteButtonId =
  | XiaomiRemoteButtonId
  | CmiotA15RemoteButtonId
  | XmBt29RemoteButtonId
  | ObeRcuR5RemoteButtonId
  | HisenseRcf3b65RemoteButtonId
  | PhicommDb1RRemoteButtonId
export type InputId = RemoteButtonId | MouseInputId
export type DeviceId = 'rc003' | 'cmiotA15' | 'mouse'
export type DeviceKind =
  | 'xboxBluetooth'
  | 'rc003'
  | 'cmiotA15'
  | 'xmBt29'
  | 'rc313'
  | 'obeRcuR5'
  | 'tclRc802a'
  | 'tclRc902n'
  | 'tclRc902v'
  | 'hisenseRcf3b65'
  | 'phicommDb1R'

export type DeviceSupportPackage = {
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
