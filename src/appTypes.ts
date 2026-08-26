import type { Behavior, BehaviorMap, ButtonId, TriggerType } from './behaviorModel'

export type RemoteButton = {
  id: ButtonId
  label: string
  short: string
  side: 'left' | 'right'
  x: number
  y: number
  icon: 'power' | 'mic' | 'up' | 'left' | 'center' | 'right' | 'down' | 'back' | 'volumeUp' | 'volumeDown' | 'home' | 'menu' | 'tv'
}

export type Platform = 'windows' | 'macos' | 'unsupported'

export type MacPermissions = {
  inputMonitoring: boolean
  accessibility: boolean
  captureActive: boolean
}

export type MacPermissionKind = 'inputMonitoring' | 'accessibility'
export type AppPage = 'home' | 'mapping'

export type SystemProbe = {
  platform: Platform
  input_driver_installed: boolean
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

export type DriverActionResult = {
  logPath: string
}

export type AudioProbe = {
  driverInstalled: boolean
  state: 'stopped' | 'driverMissing' | 'bluetoothUnavailable' | 'scanning' | 'connecting' | 'ready' | 'forwarding' | 'error' | 'unknown' | 'unsupported'
  bluetoothConnected: boolean
  forwarding: boolean
  error?: string | null
}

export type CommonBehaviorPreset =
  | 'original'
  | 'disabled'
  | 'escape'
  | 'enter'
  | 'space'
  | 'tab'
  | 'backspace'
  | 'delete'
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
  | 'textAndEnter'
  | 'customKey'

export type AdvancedBehaviorType = 'key' | 'paste' | 'delay'

export type DraftBehaviorState = {
  behavior: Behavior
  mode: 'replace' | 'append'
}

export type CommonBehaviorUndo = {
  buttonId: ButtonId
  trigger: TriggerType
  behaviors: Behavior[]
}

export type ManualKeyOption = { value: string; label: string }

export type Connector = {
  id: ButtonId
  side: 'left' | 'right'
  x1: number
  y1: number
  x2: number
  y2: number
}

export type HitPosition = { x: number; y: number }

export type StoredSettings = {
  behaviors: BehaviorMap
  enabled: boolean
}
