import type { Behavior, BehaviorMap, ButtonId, InputId } from './behaviorModel'
import type { DeviceId } from './deviceModel'

export type MappingInput<Id extends string = InputId> = {
  id: Id
  label: string
  icon: RemoteButton['icon']
  triggerLabel?: string
  contextLabel?: string
  originalDescription?: string
  inheritDefault?: boolean
  originalLabel?: string
}

export type RemoteButton = {
  id: ButtonId
  label: string
  short: string
  side: 'left' | 'right'
  x: number
  y: number
  icon:
    | 'power'
    | 'mic'
    | 'up'
    | 'left'
    | 'center'
    | 'right'
    | 'down'
    | 'back'
    | 'volumeUp'
    | 'volumeDown'
    | 'home'
    | 'menu'
    | 'tv'
    | 'mute'
    | 'settings'
    | 'm'
}

export type Platform = 'windows' | 'macos' | 'unsupported'

export type MacPermissions = {
  inputMonitoring: boolean
  accessibility: boolean
  captureActive: boolean
}

export type MacPermissionKind = 'inputMonitoring' | 'accessibility'
export type AppPage = 'home' | 'mapping' | 'settings' | 'device-settings'

export type SystemProbe = {
  platform: Platform
  rc003_connected: boolean
  input_backend_ready: boolean
  input_backend_error?: string | null
  device_hardware_id?: string | null
  input_monitoring_granted?: boolean | null
  input_authorization_stale?: boolean | null
  accessibility_granted?: boolean | null
  capture_active: boolean
}

export type RemoteKeyEvent = {
  button: ButtonId
  pressed: boolean
}

export type ManagedDriverUninstallResult = {
  deviceCount: number
  uninstalledCount: number
  unboundCount: number
  rebootRequired: boolean
  failures: Array<{ instanceId: string; error: string }>
}
export type ManagedDriverCleanupState = {
  status: 'idle' | 'running' | 'done'
  result?: ManagedDriverUninstallResult
  error?: string
}

export type DriverActionResult = {
  logPath: string
  rebootRequired: boolean
  installationState?: 'installed' | 'reinstalled' | 'restart_before_install'
}

export type ManagedDriverAction = {
  instanceId: string
  status: 'idle' | 'running' | 'error' | 'restartRequired'
  error?: string
  message?: string
}

export type AudioProbe = {
  driverInstalled: boolean
  state:
    | 'stopped'
    | 'driverMissing'
    | 'bluetoothUnavailable'
    | 'scanning'
    | 'connecting'
    | 'ready'
    | 'forwarding'
    | 'error'
    | 'unknown'
    | 'unsupported'
  bluetoothConnected: boolean
  forwarding: boolean
  receivedData?: boolean
  outputReady?: boolean
  eventVersion?: number
  error?: string | null
}

export type CommonBehaviorPreset =
  | 'wheelUp'
  | 'wheelDown'
  | 'wheelLeft'
  | 'wheelRight'
  | 'mouseLeft'
  | 'mouseRight'
  | 'cursorUp'
  | 'cursorDown'
  | 'cursorLeft'
  | 'cursorRight'
  | 'original'
  | 'disabled'
  | 'escape'
  | 'enter'
  | 'space'
  | 'rightCtrl'
  | 'rightAlt'
  | 'rightCommand'
  | 'tab'
  | 'previousTab'
  | 'nextTab'
  | 'backspace'
  | 'delete'
  | 'deleteAllText'
  | 'keyHome'
  | 'keyEnd'
  | 'pageUp'
  | 'pageDown'
  | 'arrowUp'
  | 'arrowDown'
  | 'arrowLeft'
  | 'arrowRight'
  | 'volumeUp'
  | 'volumeDown'
  | 'volumeMute'
  | 'mediaPlayPause'
  | 'mediaPrevious'
  | 'mediaNext'
  | 'mediaStop'
  | 'textAndEnter'
  | 'customKey'
  | 'openApp'
  | 'openWebsite'

export type AdvancedBehaviorType = 'key' | 'paste' | 'delay' | 'openApp' | 'openWebsite'

export type DraftBehaviorState = {
  behavior: Behavior
  mode: 'replace' | 'append'
}

export type ManualKeyOption = { value: string; label: string }

export type CmiotA15RecordingMode = 'hold' | 'click'

export type StoredSettings = {
  cmiotA15RecordingMode: CmiotA15RecordingMode
  mouseEdgeWidth: number
  showRemoteKeyGrid: boolean
  showMouseKeyGrid: boolean
  behaviors: BehaviorMap
  enabled: boolean
  mouseEnabled: boolean
  mouseVerticalScrollIntervalMs: number
  mouseHorizontalScrollIntervalMs: number
  mouseKeyHoldMs: number
  mouseScrollSensitivity: number
  mouseIgnoreScrollAcceleration: boolean
}

/** A named set of input behaviors owned by one device. */
export type MappingProfile = {
  id: string
  name: string
  deviceId: DeviceId
  behaviors: BehaviorMap
}

export type StoredProfiles = {
  activeProfileIds: Record<DeviceId, string>
  profiles: MappingProfile[]
}
