/**
 * First-run setup state for Axonkey.
 *
 * This module deliberately contains no React or Tauri dependencies. The UI
 * can keep the returned value in state and persist it with `saveSetupState`.
 * Driver commands are described as metadata only; launching an installer is
 * an application concern and should happen behind an explicit user action.
 */

export const setupStorageKey = 'axonkey.setup.v1'

export const setupStepIds = [
  'welcome',
  'legacyCleanup',
  'deviceConnection',
  'inputDriver',
  'complete',
] as const

export type SetupStepId = (typeof setupStepIds)[number]
export type SetupStepStatus = 'pending' | 'active' | 'complete' | 'skipped'

export type SetupStepDefinition = {
  id: SetupStepId
  title: string
  description: string
  skippable: boolean
}

export const legacyComponentKinds = ['frida', 'interception', 'namedPipeServer'] as const
export type LegacyComponentKind = (typeof legacyComponentKinds)[number]

export type LegacyCleanupState = {
  status: 'unknown' | 'checking' | 'present' | 'clear' | 'error'
  components: Record<LegacyComponentKind, boolean>
  action: LegacyCleanupActionState
  checkedAt?: number
  message?: string
}

export type LegacyCleanupActionStatus = 'idle' | 'running' | 'succeeded' | 'failed'
export type LegacyCleanupActionState = {
  status: LegacyCleanupActionStatus
  startedAt?: number
  finishedAt?: number
  error?: string
  logPath?: string
  rebootRequired?: boolean
}

export const skippableSetupStepIds = [
  'deviceConnection',
  'inputDriver',
] as const satisfies readonly SetupStepId[]

export type SkippableSetupStepId = (typeof skippableSetupStepIds)[number]

export const setupStepDefinitions: readonly SetupStepDefinition[] = [
  {
    id: 'welcome',
    title: '欢迎使用 Axonkey',
    description: '先确认应用用途，再开始检查运行依赖。',
    skippable: false,
  },
  {
    id: 'legacyCleanup',
    title: '卸载旧驱动',
    description: '清理旧版输入组件，再安装新的 Quarbor HID 驱动。',
    skippable: false,
  },
  {
    id: 'deviceConnection',
    title: '连接遥控器',
    description: '在系统蓝牙设置中配对并唤醒 Xiaomi RC003。',
    skippable: true,
  },
  {
    id: 'inputDriver',
    title: '配置输入环境',
    description: '按当前系统安装 Windows 驱动或授予 macOS 原生输入权限。',
    skippable: true,
  },
  {
    id: 'complete',
    title: '完成设置',
    description: '依赖检查完成，可以开始编辑按键行为。',
    skippable: false,
  },
]

export type DriverKind = 'input' | 'audio'

export const driverKinds = ['input', 'audio'] as const

export type DriverStatus =
  | 'unknown'
  | 'checking'
  | 'missing'
  | 'installed'
  | 'restartRequired'
  | 'error'

export type DriverActionKind = 'install' | 'uninstall'
export type DriverActionStatus = 'idle' | 'running' | 'succeeded' | 'skipped' | 'failed'

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
  installSkipped: boolean
  uninstallSkipped: boolean
  restartRequired: boolean
  checkedAt?: number
  message?: string
}

export type DeviceConnectionStatus =
  | 'unknown'
  | 'checking'
  | 'disconnected'
  | 'connecting'
  | 'connected'
  | 'unsupported'
  | 'error'

export type DeviceConnectionState = {
  status: DeviceConnectionStatus
  name?: string
  hardwareId?: string
  checkedAt?: number
  message?: string
}

export type SetupStepState = {
  status: SetupStepStatus
  visited: boolean
}

export type SetupState = {
  version: 1
  currentStep: SetupStepId
  setupSkipped: boolean
  steps: Record<SetupStepId, SetupStepState>
  legacyCleanup: LegacyCleanupState
  drivers: Record<DriverKind, DriverState>
  device: DeviceConnectionState
  updatedAt: number
}

export type DriverDefinition = {
  kind: DriverKind
  title: string
  description: string
  required: boolean
  installerPath: string
}

/** Paths mirror the installers shipped in the repository. */
export const driverDefinitions: Record<DriverKind, DriverDefinition> = {
  input: {
    kind: 'input',
    title: 'Quarbor HID 按键过滤驱动',
    description: '驱动获取遥控器按键输入。',
    required: true,
    installerPath: 'vendor/QuarborHIDFilterUserDriver/QuarborHIDFilterUserDriverInstaller.exe',
  },
  audio: {
    kind: 'audio',
    title: 'CABLE 虚拟麦克风',
    description: '安装 VB-Audio VB-CABLE，使 Windows 出现 CABLE Output 虚拟录音设备。',
    required: false,
    installerPath: 'scripts/vbcable-driver.ps1',
  },
}

const defaultTimestamp = 0

function createStepState(status: SetupStepStatus): SetupStepState {
  return { status, visited: status !== 'pending' }
}

function createDriverState(): DriverState {
  return {
    status: 'unknown',
    action: { kind: null, status: 'idle' },
    installSkipped: false,
    uninstallSkipped: false,
    restartRequired: false,
  }
}

function createLegacyCleanupState(): LegacyCleanupState {
  return {
    status: 'clear',
    components: { frida: false, interception: false, namedPipeServer: false },
    action: { status: 'idle' },
  }
}

/** Returns a fresh setup object suitable for a new user. */
export function createDefaultSetupState(): SetupState {
  return {
    version: 1,
    currentStep: 'welcome',
    setupSkipped: false,
    steps: {
      welcome: createStepState('active'),
      legacyCleanup: createStepState('skipped'),
      inputDriver: createStepState('pending'),
      deviceConnection: createStepState('pending'),
      complete: createStepState('pending'),
    },
    drivers: {
      input: createDriverState(),
      audio: createDriverState(),
    },
    legacyCleanup: createLegacyCleanupState(),
    device: { status: 'unknown' },
    updatedAt: defaultTimestamp,
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isSetupStepId(value: unknown): value is SetupStepId {
  return typeof value === 'string' && (setupStepIds as readonly string[]).includes(value)
}

function normalizeCurrentStep(value: unknown): SetupStepId {
  if (value === 'audioDriver') return 'inputDriver'
  return isSetupStepId(value) ? value : 'welcome'
}

function isDriverKind(value: unknown): value is DriverKind {
  return typeof value === 'string' && (driverKinds as readonly string[]).includes(value)
}

function isStatus<T extends string>(value: unknown, values: readonly T[]): value is T {
  return typeof value === 'string' && values.includes(value as T)
}

const stepStatuses: readonly SetupStepStatus[] = ['pending', 'active', 'complete', 'skipped']
const driverStatuses: readonly DriverStatus[] = ['unknown', 'checking', 'missing', 'installed', 'restartRequired', 'error']
const actionStatuses: readonly DriverActionStatus[] = ['idle', 'running', 'succeeded', 'skipped', 'failed']
const connectionStatuses: readonly DeviceConnectionStatus[] = ['unknown', 'checking', 'disconnected', 'connecting', 'connected', 'unsupported', 'error']

function cleanText(value: unknown) {
  return typeof value === 'string' ? value.trim() : undefined
}

function cleanTime(value: unknown) {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined
}

function normalizeAction(value: unknown): DriverActionState {
  if (!isRecord(value)) return { kind: null, status: 'idle' }
  const kind = isStatus(value.kind, ['install', 'uninstall'] as const) ? value.kind : null
  let status = isStatus(value.status, actionStatuses) ? value.status : 'idle'

  // An interrupted process must not leave a newly opened setup screen stuck
  // in a permanent "running" state.
  if (status === 'running') status = 'idle'
  if (status === 'idle') return { kind: null, status }

  return {
    kind,
    status,
    startedAt: cleanTime(value.startedAt),
    finishedAt: cleanTime(value.finishedAt),
    error: cleanText(value.error),
  }
}

function normalizeDriver(value: unknown, fallback: DriverState): DriverState {
  if (!isRecord(value)) return { ...fallback, action: { ...fallback.action } }
  let status = isStatus(value.status, driverStatuses) ? value.status : fallback.status
  const interruptedCheck = status === 'checking'
  if (interruptedCheck) status = 'unknown'
  const action = normalizeAction(value.action)
  return {
    status,
    action,
    installSkipped: value.installSkipped === true,
    uninstallSkipped: value.uninstallSkipped === true,
    restartRequired: value.restartRequired === true || status === 'restartRequired',
    checkedAt: cleanTime(value.checkedAt),
    message: interruptedCheck ? undefined : cleanText(value.message),
  }
}

function normalizeStep(value: unknown, fallback: SetupStepState): SetupStepState {
  if (!isRecord(value)) return { ...fallback }
  const status = isStatus(value.status, stepStatuses) ? value.status : fallback.status
  return { status, visited: value.visited === true || status !== 'pending' }
}

function normalizeDriverSetupStep(rawSteps: Record<string, unknown>, fallback: SetupStepState): SetupStepState {
  const input = normalizeStep(rawSteps.inputDriver, fallback)
  if (!('audioDriver' in rawSteps)) return input

  const audio = normalizeStep(rawSteps.audioDriver, createStepState('pending'))
  const terminal = (step: SetupStepState) => step.status === 'complete' || step.status === 'skipped'
  if (terminal(input) && terminal(audio)) {
    return {
      status: input.status === 'skipped' && audio.status === 'skipped' ? 'skipped' : 'complete',
      visited: true,
    }
  }
  if (input.visited || audio.visited) return { status: 'active', visited: true }
  return fallback
}

function normalizeDevice(value: unknown, fallback: DeviceConnectionState): DeviceConnectionState {
  if (!isRecord(value)) return { ...fallback }
  return {
    status: isStatus(value.status, connectionStatuses) ? value.status : fallback.status,
    name: cleanText(value.name),
    hardwareId: cleanText(value.hardwareId),
    checkedAt: cleanTime(value.checkedAt),
    message: cleanText(value.message),
  }
}

function normalizeLegacyCleanup(value: unknown, fallback: LegacyCleanupState): LegacyCleanupState {
  if (!isRecord(value)) return { ...fallback, components: { ...fallback.components } }
  const components = {
    frida: Boolean(value.components && isRecord(value.components) && value.components.frida === true),
    interception: Boolean(value.components && isRecord(value.components) && value.components.interception === true),
    namedPipeServer: Boolean(value.components && isRecord(value.components) && value.components.namedPipeServer === true),
  }
  const statuses = ['unknown', 'checking', 'present', 'clear', 'error'] as const
  const status = isStatus(value.status, statuses) ? value.status : fallback.status
  const rawAction = isRecord(value.action) ? value.action : {}
  const actionStatuses = ['idle', 'running', 'succeeded', 'failed'] as const
  let actionStatus = isStatus(rawAction.status, actionStatuses) ? rawAction.status : 'idle'
  if (actionStatus === 'running') actionStatus = 'idle'
  return {
    status,
    components,
    action: {
      status: actionStatus,
      startedAt: cleanTime(rawAction.startedAt),
      finishedAt: cleanTime(rawAction.finishedAt),
      error: cleanText(rawAction.error),
      logPath: cleanText(rawAction.logPath),
      rebootRequired: rawAction.rebootRequired === true,
    },
    checkedAt: cleanTime(value.checkedAt),
    message: cleanText(value.message),
  }
}

/**
 * Parse persisted setup data and merge only valid fields into defaults.
 * Accepts either localStorage JSON or an already parsed object.
 */
export function parseStoredSetup(value: unknown): SetupState {
  const fallback = createDefaultSetupState()
  let parsed: unknown = value
  if (typeof value === 'string') {
    try {
      parsed = JSON.parse(value) as unknown
    } catch {
      return fallback
    }
  }
  if (!isRecord(parsed)) return fallback

  const rawSteps = isRecord(parsed.steps) ? parsed.steps : {}
  const rawDrivers = isRecord(parsed.drivers) ? parsed.drivers : {}
  const currentStep = normalizeCurrentStep(parsed.currentStep)
  const steps = Object.fromEntries(
    setupStepIds.map((id) => [
      id,
      id === 'inputDriver'
        ? normalizeDriverSetupStep(rawSteps, fallback.steps.inputDriver)
        : normalizeStep(rawSteps[id], fallback.steps[id]),
    ]),
  ) as Record<SetupStepId, SetupStepState>

  const state: SetupState = {
    version: 1,
    currentStep,
    setupSkipped: parsed.setupSkipped === true,
    steps,
    drivers: {
      input: normalizeDriver(rawDrivers.input, fallback.drivers.input),
      audio: normalizeDriver(rawDrivers.audio, fallback.drivers.audio),
    },
    legacyCleanup: normalizeLegacyCleanup(parsed.legacyCleanup, fallback.legacyCleanup),
    device: normalizeDevice(parsed.device, fallback.device),
    updatedAt: cleanTime(parsed.updatedAt) ?? defaultTimestamp,
  }

  // A previously completed/skipped step should not become active after a
  // malformed currentStep value was loaded.
  if (state.steps[state.currentStep].status === 'complete' || state.steps[state.currentStep].status === 'skipped') {
    state.currentStep = getNextSetupStep(state)
  }
  return state
}

function getStorage(storage?: Storage): Storage | undefined {
  if (storage) return storage
  if (typeof window === 'undefined') return undefined
  try {
    return window.localStorage
  } catch {
    return undefined
  }
}

export function loadSetupState(storage?: Storage): SetupState {
  const target = getStorage(storage)
  if (!target) return createDefaultSetupState()
  try {
    return parseStoredSetup(target.getItem(setupStorageKey))
  } catch {
    return createDefaultSetupState()
  }
}

export function saveSetupState(state: SetupState, storage?: Storage): SetupState {
  const normalized = parseStoredSetup(state)
  normalized.updatedAt = Date.now()
  const target = getStorage(storage)
  if (target) {
    try {
      target.setItem(setupStorageKey, JSON.stringify(normalized))
    } catch {
      // Storage can be unavailable or full; the in-memory value remains valid.
    }
  }
  return normalized
}

export function clearSetupState(storage?: Storage) {
  const target = getStorage(storage)
  try {
    target?.removeItem(setupStorageKey)
  } catch {
    // Ignore unavailable storage; callers can still reset their local state.
  }
}

function cloneState(state: SetupState): SetupState {
  return {
    ...state,
    steps: Object.fromEntries(setupStepIds.map((id) => [id, { ...state.steps[id] }])) as Record<SetupStepId, SetupStepState>,
    drivers: {
      input: { ...state.drivers.input, action: { ...state.drivers.input.action } },
      audio: { ...state.drivers.audio, action: { ...state.drivers.audio.action } },
    },
    legacyCleanup: {
      ...state.legacyCleanup,
      components: { ...state.legacyCleanup.components },
      action: { ...state.legacyCleanup.action },
    },
    device: { ...state.device },
  }
}

export function canSkipSetupStep(step: SetupStepId): step is SkippableSetupStepId {
  return (skippableSetupStepIds as readonly string[]).includes(step)
}

export function getNextSetupStep(state: SetupState): SetupStepId {
  const next = setupStepIds.find((id) => id !== 'complete' && !['complete', 'skipped'].includes(state.steps[id].status))
  return next ?? 'complete'
}

export function isSetupComplete(state: SetupState): boolean {
  if (state.setupSkipped) return true
  return setupStepIds.every((id) => id === 'complete'
    ? state.steps[id].status === 'complete'
    : ['complete', 'skipped'].includes(state.steps[id].status))
}

export function setCurrentSetupStep(state: SetupState, step: SetupStepId): SetupState {
  const next = cloneState(state)
  next.currentStep = step
  next.steps[step] = { ...next.steps[step], visited: true, status: next.steps[step].status === 'pending' ? 'active' : next.steps[step].status }
  next.updatedAt = Date.now()
  return next
}

/** Opens a step for review and clears a stale completion mark until a fresh probe confirms it. */
export function activateSetupStep(state: SetupState, step: SetupStepId): SetupState {
  const next = cloneState(state)
  next.currentStep = step
  next.steps[step] = { status: 'active', visited: true }
  next.updatedAt = Date.now()
  return next
}

export function setSetupStepStatus(state: SetupState, step: SetupStepId, status: SetupStepStatus): SetupState {
  const next = cloneState(state)
  next.steps[step] = { status, visited: true }
  next.updatedAt = Date.now()
  return next
}

export function setLegacyCleanupProbe(
  state: SetupState,
  components: Record<LegacyComponentKind, boolean>,
  options: { checking?: boolean; error?: string; checkedAt?: number } = {},
): SetupState {
  const next = cloneState(state)
  const present = Object.values(components).some(Boolean)
  next.legacyCleanup = {
    ...next.legacyCleanup,
    status: options.error ? 'error' : options.checking ? 'checking' : present ? 'present' : 'clear',
    components: { ...components },
    checkedAt: options.checkedAt ?? Date.now(),
    message: options.error,
  }
  if (present) {
    next.steps.legacyCleanup = { status: 'active', visited: true }
    // Keep the welcome page first, but insert migration before every later step.
    if (next.currentStep !== 'welcome' && next.currentStep !== 'legacyCleanup') {
      next.currentStep = 'legacyCleanup'
    }
    next.setupSkipped = false
  } else if (!options.error && !options.checking) {
    next.steps.legacyCleanup = { status: 'skipped', visited: true }
    if (next.currentStep === 'legacyCleanup') {
      next.currentStep = getNextSetupStep(next)
      next.steps[next.currentStep] = {
        ...next.steps[next.currentStep],
        visited: true,
        status: next.currentStep === 'complete' ? 'complete' : next.steps[next.currentStep].status === 'pending' ? 'active' : next.steps[next.currentStep].status,
      }
    }
  }
  next.updatedAt = Date.now()
  return next
}

export function beginLegacyCleanup(state: SetupState, now = Date.now()): SetupState {
  const next = cloneState(state)
  next.legacyCleanup.action = { status: 'running', startedAt: now }
  next.updatedAt = now
  return next
}

export function finishLegacyCleanup(
  state: SetupState,
  result: { success: boolean; error?: string; logPath?: string; rebootRequired?: boolean },
  now = Date.now(),
): SetupState {
  const next = cloneState(state)
  next.legacyCleanup.action = {
    status: result.success ? 'succeeded' : 'failed',
    startedAt: state.legacyCleanup.action.startedAt,
    finishedAt: now,
    error: result.error,
    logPath: result.logPath,
    rebootRequired: result.rebootRequired,
  }
  next.updatedAt = now
  return next
}

export function completeSetupStep(state: SetupState, step: SetupStepId): SetupState {
  const next = cloneState(state)
  next.steps[step] = { status: 'complete', visited: true }
  next.setupSkipped = false
  next.currentStep = getNextSetupStep(next)
  next.steps[next.currentStep] = { ...next.steps[next.currentStep], visited: true, status: next.currentStep === 'complete' ? 'complete' : 'active' }
  next.updatedAt = Date.now()
  return next
}

export function skipSetupStep(state: SetupState, step: SetupStepId): SetupState {
  if (!canSkipSetupStep(step)) return state
  const next = cloneState(state)
  next.steps[step] = { status: 'skipped', visited: true }
  next.currentStep = getNextSetupStep(next)
  next.steps[next.currentStep] = { ...next.steps[next.currentStep], visited: true, status: next.currentStep === 'complete' ? 'complete' : 'active' }
  next.updatedAt = Date.now()
  return next
}

/** Skip the whole first-run guide while retaining the user's driver choices. */
export function skipSetup(state: SetupState): SetupState {
  const next = cloneState(state)
  next.setupSkipped = true
  for (const id of setupStepIds) next.steps[id] = { status: id === 'complete' ? 'complete' : 'skipped', visited: true }
  next.currentStep = 'complete'
  next.updatedAt = Date.now()
  return next
}

export function resetSetup(): SetupState {
  return createDefaultSetupState()
}

export function setDriverStatus(
  state: SetupState,
  driver: DriverKind,
  status: DriverStatus,
  options: { message?: string; checkedAt?: number; restartRequired?: boolean } = {},
): SetupState {
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

export function beginDriverAction(state: SetupState, driver: DriverKind, kind: DriverActionKind, now = Date.now()): SetupState {
  const next = cloneState(state)
  next.drivers[driver] = {
    ...next.drivers[driver],
    installSkipped: kind === 'install' ? false : next.drivers[driver].installSkipped,
    uninstallSkipped: kind === 'uninstall' ? false : next.drivers[driver].uninstallSkipped,
    action: { kind, status: 'running', startedAt: now },
  }
  next.updatedAt = now
  return next
}

export function finishDriverAction(
  state: SetupState,
  driver: DriverKind,
  kind: DriverActionKind,
  result: { success: boolean; status?: DriverStatus; message?: string; restartRequired?: boolean; error?: string },
  now = Date.now(),
): SetupState {
  const next = cloneState(state)
  const current = next.drivers[driver]
  const actionStatus: DriverActionStatus = result.success ? 'succeeded' : 'failed'
  const defaultStatus: DriverStatus = kind === 'uninstall' ? 'missing' : 'installed'
  next.drivers[driver] = {
    ...current,
    installSkipped: kind === 'install' && result.success ? false : current.installSkipped,
    uninstallSkipped: kind === 'uninstall' && result.success ? false : current.uninstallSkipped,
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

export function setDeviceConnection(state: SetupState, patch: Partial<DeviceConnectionState>): SetupState {
  const next = cloneState(state)
  next.device = {
    ...next.device,
    ...patch,
    checkedAt: patch.checkedAt ?? Date.now(),
  }
  next.updatedAt = Date.now()
  return next
}
