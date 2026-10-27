export type DriverKind = 'input' | 'audio'

export type DriverStatus = 'unknown' | 'checking' | 'missing' | 'installed' | 'restartRequired' | 'error'

export type DriverActionKind = 'install' | 'uninstall'
export type DriverActionStatus = 'idle' | 'running' | 'succeeded' | 'failed'

export type DriverActionState = {
  kind: DriverActionKind | null
  status: DriverActionStatus
  startedAt?: number
  finishedAt?: number
  error?: string
}

export type DriverState = {
  status: DriverStatus
  action: DriverActionState
  restartRequired: boolean
  checkedAt?: number
  message?: string
}

export type DeviceConnectionStatus =
  'unknown' | 'checking' | 'disconnected' | 'connecting' | 'connected' | 'unsupported' | 'error'

export type DeviceConnectionState = {
  status: DeviceConnectionStatus
  name?: string
  hardwareId?: string
  checkedAt?: number
  message?: string
}

export type SystemState = {
  drivers: Record<DriverKind, DriverState>
  device: DeviceConnectionState
  updatedAt: number
}

export function createDefaultSystemState(): SystemState {
  return {
    drivers: { input: createDriverState(), audio: createDriverState() },
    device: { status: 'unknown' },
    updatedAt: 0,
  }
}

function createDriverState(): DriverState {
  return {
    status: 'unknown',
    action: { kind: null, status: 'idle' },
    restartRequired: false,
  }
}

function cloneState(state: SystemState): SystemState {
  return {
    ...state,
    drivers: {
      input: { ...state.drivers.input, action: { ...state.drivers.input.action } },
      audio: { ...state.drivers.audio, action: { ...state.drivers.audio.action } },
    },
    device: { ...state.device },
  }
}

export function setDriverStatus(
  state: SystemState,
  driver: DriverKind,
  status: DriverStatus,
  options: { message?: string; checkedAt?: number; restartRequired?: boolean } = {},
): SystemState {
  const next = cloneState(state)
  next.drivers[driver] = {
    ...next.drivers[driver],
    status,
    restartRequired: options.restartRequired ?? status === 'restartRequired',
    checkedAt: options.checkedAt ?? Date.now(),
    message: options.message,
  }
  next.updatedAt = Date.now()
  return next
}

export function beginDriverAction(
  state: SystemState,
  driver: DriverKind,
  kind: DriverActionKind,
  now = Date.now(),
): SystemState {
  const next = cloneState(state)
  next.drivers[driver] = {
    ...next.drivers[driver],
    action: { kind, status: 'running', startedAt: now },
  }
  next.updatedAt = now
  return next
}

export function finishDriverAction(
  state: SystemState,
  driver: DriverKind,
  kind: DriverActionKind,
  result: { success: boolean; status?: DriverStatus; message?: string; restartRequired?: boolean; error?: string },
  now = Date.now(),
): SystemState {
  const next = cloneState(state)
  const current = next.drivers[driver]
  const actionStatus: DriverActionStatus = result.success ? 'succeeded' : 'failed'
  const defaultStatus: DriverStatus = kind === 'uninstall' ? 'missing' : 'installed'
  next.drivers[driver] = {
    ...current,
    status: result.status ?? (result.success ? defaultStatus : 'error'),
    restartRequired: result.restartRequired ?? current.restartRequired,
    message: result.message,
    action: {
      kind,
      status: actionStatus,
      startedAt: current.action.kind === kind ? current.action.startedAt : undefined,
      finishedAt: now,
      error: result.error,
    },
    checkedAt: now,
  }
  next.updatedAt = now
  return next
}

export function setDeviceConnection(state: SystemState, patch: Partial<DeviceConnectionState>): SystemState {
  const next = cloneState(state)
  next.device = {
    ...next.device,
    ...patch,
    checkedAt: patch.checkedAt ?? Date.now(),
  }
  next.updatedAt = Date.now()
  return next
}
