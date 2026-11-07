import { BehaviorLibraryContext } from '../cloud/BehaviorLibraryContext'
import { LegacyCleanupFlow } from '../components/LegacyCleanupDialog'
import { DriverMigrationFlow } from '../components/DriverMigrationDialog'
import { VirtualAudioUpgradeDialog } from '../components/VirtualAudioUpgradeFlow'
import { DeviceHub } from '../devices/integration/DeviceHub'
import { useDeviceInstances } from '../devices/integration/useDeviceInstances'
import { annotateSnapshot, cloudSource, saveProfileMetadata } from '../cloud/cloudMetadata'
import { CloudSyncSettings } from '../components/CloudSyncSettings'
import { LocalDataResetSettings } from '../components/LocalDataResetSettings'
import { useCloudSync } from '../cloud/useCloudSync'
import { createCloudSnapshot, prepareCloudRestore } from '../cloud/cloudData'
import { createPortal } from 'react-dom'
import { ProfileSwitchConfirmDialog } from '../components/ProfileSwitchConfirmDialog'
import { ProfileSwitchDeleteDialog } from '../components/ProfileSwitchDeleteDialog'
import { createDataBackup, restoreBackupStorage } from '../dataBackup'
import { clearLocalData } from '../localDataReset'
import type { ParsedBackup } from '../dataBackup'
import type { LegacyBackupImport } from '../backupImport'
import { parseSavedSequences, savedSequencesStorageKey } from '../savedSequences'
import appPackage from '../../package.json'
import {
  adjacentProfileId,
  changeProfileState,
  applySharedProfileSwitch,
  profileSwitchTargets,
  removedProfileSwitchTriggers,
  removeSharedProfileSwitch,
} from '../profileNavigation'
import type { ProfileSwitchRequest, ProfileSwitchDeletion } from '../profileNavigation'
import { composeActiveProfileBehaviors, mergeDeviceBehaviors, snapshotDeviceProfiles } from '../deviceProfiles'
import { useReleaseUpdate } from '../hooks/useReleaseUpdate'
// @refresh reset
// Authorization callbacks can outlive a dev edit; remount instead of reusing
// an obsolete hook layout when Fast Refresh updates this stateful root.
import { Check, Info } from 'lucide-react'
import { RedoCircle, UndoCircle } from 'reicon-react'
import {
  createBehavior,
  createDefaultBehaviorMap,
  cloneBehaviorMap,
  createEmptyBehaviorMap,
  defaultCursorDistance,
  createMappingExport,
  serializeSequence,
  moveBehavior,
  parseMappingImport,
  updateBehaviorList,
} from '../behaviorModel'
import type {
  Behavior,
  BehaviorMap,
  ButtonId,
  ImportedMapping,
  InputId,
  TriggerBehaviors,
  TriggerType,
  SwitchProfileBehavior,
} from '../behaviorModel'
import { updateWorkflowInput } from '../components/workflowBehaviorBridge'
import { behaviorHistoryReducer, createBehaviorHistory } from '../behaviorHistory'
import {
  isRightModifierPreset,
  keyDisplayName,
  rightModifierKeys,
  behaviorFromCapturedKey,
  buttons,
  allRemoteButtons,
  detectBrowserPlatform,
  formatCapturedKey,
  getStoredProfiles,
  getStoredSettings,
  getStoredUiState,
  normalizeProfileName,
  createMappingProfile,
  profilesStorageKey,
  saveStoredUiState,
  settingsStorageKey,
  uiStateStorageKey,
  audioSettingsStorageKey,
  textAndEnterValue,
  withTimeout,
} from '../appConfig'
import type { StoredUiState } from '../appConfig'
import type {
  AdvancedBehaviorType,
  AppPage,
  AudioProbe,
  CommonBehaviorPreset,
  DraftBehaviorState,
  DriverActionResult,
  ManagedDriverAction,
  MacPermissionKind,
  MacPermissions,
  Platform,
  RemoteKeyEvent,
  SystemProbe,
  MappingProfile,
} from '../appTypes'
import { AboutPage } from '../components/AboutPage'
import { BatteryIndicator } from '../components/BatteryIndicator'
import { AudioTestDialog } from '../components/AudioTestDialog'
import { SettingsPage, type SettingsSection } from '../components/SettingsPage'
import { HomeDashboard } from '../components/HomeDashboard'
import { BehaviorEditDialog, SequencePasteDialog, TextInputPresetDialog } from '../components/BehaviorEditor'
import { writeClipboardText } from '../clipboard'
import { devices, deviceForInput } from '../devices/registry'
import { DeviceSettingsDrawer } from '../devices/shared/DeviceSettingsDrawer'
import { deviceSettingsPages } from '../devices/pages'
import type { DeviceId } from '../devices/index.ts'
import { mouseInputs } from '../components/MouseMapping'
import type { DeviceStatus } from '../components/DeviceRail'
import { ProfileManager } from '../components/ProfileManager'
import { MappingOptions } from '../components/MappingOptions'
import { ProfileImportDialog } from '../components/ProfileImportDialog'
import { MappingPage } from '../components/MappingPage'
import { MappingFlowPage } from '../components/MappingFlowPage'
import { MacPermissionHelperWindow } from '../components/MacPermissionHelperWindow'
import { useAudioControls } from '../hooks/useAudioControls'
import { useWindowsAudioDriver } from '../hooks/useWindowsAudioDriver'
import { useUserGuide } from '../hooks/useUserGuide'
import { UserGuideDialog } from '../components/UserGuideDialog'
import { WindowsAudioDriverDialog } from '../components/WindowsAudioDriverDialog'
import { ManagedDriverCleanupDialog } from '../components/ManagedDriverCleanupDialog'
import { logError, logInfo } from '../runtimeLogging'
import {
  beginDriverAction,
  finishDriverAction,
  createDefaultSystemState,
  setDeviceConnection,
  setDriverStatus,
} from '../systemState'
import type { DriverActionKind, DriverKind, SystemState } from '../systemState'
import { managedDriverInstallMessage } from '../systemState'
import { invoke } from '@tauri-apps/api/core'
import { listen } from '@tauri-apps/api/event'
import { save } from '@tauri-apps/plugin-dialog'
import { ChangeEvent, KeyboardEvent, SetStateAction, useCallback, useEffect, useReducer, useRef, useState } from 'react'
import { reportTencentEvent } from '../telemetry'
import { behaviorToCliBehavior, cliBehaviorToBehavior, cliSchema, normalizeCliSequence } from '../cliContract'
import type { CliRequest } from '../cliContract'

type PendingProfileImport = ImportedMapping & {
  deviceId: DeviceId
  fileName: string
  suggestedName: string
}

type CliParams = Record<string, unknown>

class CliOperationError extends Error {
  code: string

  constructor(code: string, message: string) {
    super(message)
    this.code = code
  }
}

async function loadCliKeymapSvg(url: string) {
  const response = await fetch(new URL(url, window.location.href))
  if (!response.ok) throw new Error(`无法读取键位图 SVG（HTTP ${response.status}）`)
  return response.text()
}

function cliParams(value: unknown): CliParams {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {}
  return value as CliParams
}

function cliPlatform(platform: Platform): 'windows' | 'macos' {
  return platform === 'macos' ? 'macos' : 'windows'
}

function cliDeviceId(value: unknown, fallback: DeviceId): DeviceId {
  if (typeof value !== 'string' || !value.trim()) return fallback
  const normalized = value.trim().toLowerCase()
  const aliases: Record<string, DeviceId> = {
    remote: 'rc003',
    rc003: 'rc003',
    xiaomi: 'rc003',
    cmiot: 'cmiotA15',
    cmiota15: 'cmiotA15',
    mouse: 'mouse',
  }
  const device = aliases[normalized]
  if (!device) throw new CliOperationError('invalid_target', '不支持的设备：' + value)
  return device
}

function cliTrigger(value: unknown): TriggerType {
  if (value === undefined || value === null || value === '') return 'click'
  if (value === 'click' || value === 'doubleClick' || value === 'longPress') return value
  if (value === 'double-click') return 'doubleClick'
  if (value === 'long-press') return 'longPress'
  throw new CliOperationError('invalid_target', '不支持的触发方式：' + String(value))
}

function cliInputId(value: unknown, deviceId: DeviceId): InputId {
  if (typeof value !== 'string' || !value.trim()) {
    throw new CliOperationError('invalid_target', '必须指定 button 或 input')
  }
  const input = value.trim() as InputId
  const device = devices.find(item => item.id === deviceId)!
  if (device.inputIds.includes(input)) return input
  const aliases: Record<string, string> = {
    voice: 'voice',
    power: 'power',
    back: 'back',
    home: 'home',
    menu: 'menu',
    enter: 'enter',
  }
  const alias = aliases[input.toLowerCase()]
  if (alias && device.inputIds.includes(alias as InputId)) return alias as InputId
  throw new CliOperationError('invalid_target', '设备 ' + deviceId + ' 没有按键：' + value)
}

function cliPublicSequence(list: Behavior[], platform: Platform) {
  return list.map(behavior => behaviorToCliBehavior(behavior, cliPlatform(platform)))
}

function AppController({
  initialBindingId = null,
  skipUserGuide = false,
  onOpenConfigMigration,
  onImportLegacyConfig,
}: {
  initialBindingId?: string | null
  skipUserGuide?: boolean
  onOpenConfigMigration: () => void
  onImportLegacyConfig: (backup: LegacyBackupImport, fileName: string) => void
}) {
  const nativeRuntime = typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window
  const deviceInstances = useDeviceInstances(nativeRuntime)
  const [initialUiState] = useState<StoredUiState>(() => {
    const stored = getStoredUiState()
    const device = devices.find(item => item.id === stored.selectedDeviceId) ?? devices[0]
    const firstInput = device.inputIds[0]
    const validInput = device.inputIds.includes(stored.selectedBehavior.buttonId)
    const validActive = device.inputKind === 'button' && device.inputIds.includes(stored.activeId)
    return {
      ...stored,
      selectedBehavior: validInput ? stored.selectedBehavior : { buttonId: firstInput, trigger: 'click' },
      activeId: validActive ? stored.activeId : device.inputKind === 'button' ? (firstInput as ButtonId) : 'power',
    }
  })
  const [platform, setPlatform] = useState<Platform>(detectBrowserPlatform)
  const [platformReady, setPlatformReady] = useState(!nativeRuntime)
  const userGuide = useUserGuide(
    platformReady && platform === 'windows',
    nativeRuntime,
    !initialBindingId,
    skipUserGuide,
  )
  const [selectedDeviceId, setSelectedDeviceId] = useState<DeviceId>(initialUiState.selectedDeviceId)
  const selectedDevice = devices.find(device => device.id === selectedDeviceId)!
  const editableButtons = selectedDevice.buttons ? [...selectedDevice.buttons] : []
  const isMouse = selectedDevice.inputKind === 'mouse'
  const [macPermissions, setMacPermissions] = useState<MacPermissions>({
    inputMonitoring: false,
    accessibility: false,
    captureActive: false,
  })
  const [permissionHelperKind, setPermissionHelperKind] = useState<MacPermissionKind | null>(null)
  const [activeId, setActiveId] = useState<ButtonId>(initialUiState.activeId)
  const [storedProfiles] = useState(getStoredProfiles)
  const [profiles, setProfiles] = useState<MappingProfile[]>(storedProfiles.profiles)
  const [activeProfileIds, setActiveProfileIds] = useState(storedProfiles.activeProfileIds)
  const activeProfileId = activeProfileIds[selectedDeviceId]
  const deviceProfiles = profiles.filter(profile => profile.deviceId === selectedDeviceId)
  const [behaviorHistory, dispatchBehaviorHistory] = useReducer(behaviorHistoryReducer, null, () =>
    createBehaviorHistory(composeActiveProfileBehaviors(storedProfiles.profiles, storedProfiles.activeProfileIds)),
  )
  const behaviors = behaviorHistory.present
  const profileStateRef = useRef({ profiles, activeProfileIds, behaviors })
  profileStateRef.current = { profiles, activeProfileIds, behaviors }
  const setBehaviors = useCallback((update: SetStateAction<BehaviorMap>) => {
    dispatchBehaviorHistory({
      type: 'change',
      update: typeof update === 'function' ? update : () => update,
    })
  }, [])
  const canUndoBehavior = behaviorHistory.past.length > 0
  const canRedoBehavior = behaviorHistory.future.length > 0
  const [enabled, setEnabled] = useState(() => getStoredSettings().enabled)
  const [cmiotA15RecordingMode, setCmiotA15RecordingMode] = useState(() => getStoredSettings().cmiotA15RecordingMode)
  const [mouseEnabled, setMouseEnabled] = useState(() => getStoredSettings().mouseEnabled)
  const [mouseIgnoreScrollAcceleration, setMouseIgnoreScrollAcceleration] = useState(
    () => getStoredSettings().mouseIgnoreScrollAcceleration,
  )
  const [mouseScrollSensitivity, setMouseScrollSensitivity] = useState(() => getStoredSettings().mouseScrollSensitivity)
  const [mouseVerticalScrollIntervalMs, setMouseVerticalScrollIntervalMs] = useState(
    () => getStoredSettings().mouseVerticalScrollIntervalMs,
  )
  const [mouseEdgeWidth, setMouseEdgeWidth] = useState(() => getStoredSettings().mouseEdgeWidth)
  const [mouseHorizontalScrollIntervalMs, setMouseHorizontalScrollIntervalMs] = useState(
    () => getStoredSettings().mouseHorizontalScrollIntervalMs,
  )
  const [mouseKeyHoldMs, setMouseKeyHoldMs] = useState(() => getStoredSettings().mouseKeyHoldMs)
  const [debugMode, setDebugMode] = useState(false)
  const [driverMigrationOpen, setDriverMigrationOpen] = useState(false)
  const [legacyCleanupOpen, setLegacyCleanupOpen] = useState(false)
  const [windowsAudioDriverOpen, setWindowsAudioDriverOpen] = useState(false)
  const [virtualAudioUpgradeOpen, setVirtualAudioUpgradeOpen] = useState(false)
  const windowsAudioDriver = useWindowsAudioDriver(nativeRuntime && platform === 'windows')
  const [audioTestOpen, setAudioTestOpen] = useState(false)
  const [audioTestInstanceId, setAudioTestInstanceId] = useState<string | null>(null)
  const [audioTestInstanceGain, setAudioTestInstanceGain] = useState(0)
  const openLegacyAudioCalibration = () => {
    setAudioTestInstanceId(null)
    setAudioTestOpen(true)
  }
  const openInstanceAudioCalibration = (instanceId: string) => {
    const instance = deviceInstances.snapshot.store.instances.find(item => item.id === instanceId)
    setAudioTestInstanceId(instanceId)
    setAudioTestInstanceGain(instance?.audioGainDb ?? 0)
    setAudioTestOpen(true)
  }
  const updateInstanceAudioGain = (gain: number) => {
    setAudioTestInstanceGain(gain)
    if (audioTestInstanceId) {
      void deviceInstances.update(audioTestInstanceId, item => ({ ...item, audioGainDb: gain })).catch(() => {})
    }
  }
  const [autoSaveState, setAutoSaveState] = useState<'saved' | 'saving' | 'error'>('saved')
  const [applyRetry, setApplyRetry] = useState(0)
  const [toast, setToast] = useState('')
  const [selectedBehavior, setSelectedBehavior] = useState<{ buttonId: InputId; trigger: TriggerType }>(
    initialUiState.selectedBehavior,
  )
  const [capturingBehaviorId, setCapturingBehaviorId] = useState<string | null>(null)
  const [editingBehaviorId, setEditingBehaviorId] = useState<string | null>(null)
  const [draftBehavior, setDraftBehavior] = useState<DraftBehaviorState | null>(null)
  const [textInputDraft, setTextInputDraft] = useState<string | null>(null)
  const [sequencePasteOpen, setSequencePasteOpen] = useState(false)
  const [pendingProfileSwitch, setPendingProfileSwitch] = useState<{
    inputId: InputId
    trigger: TriggerType
    behavior: SwitchProfileBehavior
  } | null>(null)
  const [pendingProfileSwitchDeletion, setPendingProfileSwitchDeletion] = useState<ProfileSwitchDeletion | null>(null)
  const [batteryLevel, setBatteryLevel] = useState<number | null>(null)
  const [previewBatteryLevel, setPreviewBatteryLevel] = useState<number | null>(null)
  const displayedBatteryLevel = debugMode ? (previewBatteryLevel ?? batteryLevel) : batteryLevel
  const adjustPreviewBattery = (delta: number) => {
    setPreviewBatteryLevel(current => Math.max(0, Math.min(100, (current ?? batteryLevel ?? 50) + delta)))
  }
  useEffect(() => {
    if (!debugMode) setPreviewBatteryLevel(null)
  }, [debugMode])
  const [inputAuthorizationStale, setInputAuthorizationStale] = useState(false)
  const [activePage, setActivePage] = useState<AppPage>(initialBindingId ? 'home' : initialUiState.activePage)
  const [selectedInstanceId, setSelectedInstanceId] = useState<string | null>(initialBindingId)
  const [pendingBindingId, setPendingBindingId] = useState(initialBindingId)
  const [sidebarCollapsed] = useState(initialUiState.sidebarCollapsed)
  const [mappingStyle, setMappingStyle] = useState<'flow' | 'legacy'>('flow')
  const [deviceSettingsOpen, setDeviceSettingsOpen] = useState(false)
  const navigateToPage = (page: AppPage) => {
    setDeviceSettingsOpen(false)
    setSelectedInstanceId(null)
    if (page === 'mapping') setMappingStyle('flow')
    setActivePage(page)
  }
  const [showRecordingOverlay, setShowRecordingOverlay] = useState(() => getStoredSettings().showRecordingOverlay)
  const [showRemoteKeyGrid, setShowRemoteKeyGrid] = useState(() => getStoredSettings().showRemoteKeyGrid)
  const [showMouseKeyGrid, setShowMouseKeyGrid] = useState(() => getStoredSettings().showMouseKeyGrid)
  const [settingsSection, setSettingsSection] = useState<SettingsSection>(initialUiState.settingsSection)
  const releaseUpdate = useReleaseUpdate(activePage === 'settings' && settingsSection === 'about', debugMode)
  const [systemState, setSystemState] = useState<SystemState>(createDefaultSystemState)
  const [microphoneDriverAbnormal, setMicrophoneDriverAbnormal] = useState(false)
  const [microphoneDriverWarningSuppressed, setMicrophoneDriverWarningSuppressed] = useState(false)
  const [managedDriverCleanupOpen, setManagedDriverCleanupOpen] = useState(false)
  const [managedDriverAction, setManagedDriverAction] = useState<ManagedDriverAction | null>(null)
  const [systemProbeState, setSystemProbeState] = useState<'loading' | 'ready' | 'error'>(
    nativeRuntime ? 'loading' : 'ready',
  )
  const [pressedId, setPressedId] = useState<ButtonId | null>(null)
  const behaviorEditorRef = useRef<HTMLElement>(null)
  const mappingMainRef = useRef<HTMLElement>(null)
  const mainContentRef = useRef<HTMLElement>(null)
  const pageScrollTopRef = useRef(initialUiState.scrollTop)
  const mappingFileInputRef = useRef<HTMLInputElement>(null)
  const [pendingProfileImport, setPendingProfileImport] = useState<PendingProfileImport | null>(null)
  const rowRefs = useRef<Partial<Record<InputId, HTMLElement>>>({})
  const brandClickRef = useRef({ count: 0, lastAt: 0 })
  const saveRevisionRef = useRef(0)
  const audioProbeRunningRef = useRef(false)
  const systemProbeRunningRef = useRef(false)
  const pressedClearTimerRef = useRef<number | undefined>(undefined)
  const behaviorAttentionTimerRef = useRef<number | undefined>(undefined)
  const [behaviorEditorAttention, setBehaviorEditorAttention] = useState(false)
  const uiStateRef = useRef<StoredUiState>(initialUiState)
  uiStateRef.current = {
    sidebarCollapsed,
    activePage,
    selectedDeviceId,
    activeId,
    selectedBehavior,
    settingsSection,
    scrollTop: pageScrollTopRef.current,
  }

  const persistUiState = useCallback(() => {
    saveStoredUiState(uiStateRef.current)
  }, [])

  useEffect(() => {
    persistUiState()
  }, [activePage, sidebarCollapsed, selectedDeviceId, activeId, selectedBehavior, settingsSection, persistUiState])

  useEffect(() => {
    const mainContent = mainContentRef.current
    if (!mainContent) return
    const page = activePage
    const restoreFrame = window.requestAnimationFrame(() => {
      mainContent.scrollTop = pageScrollTopRef.current[page] ?? 0
    })
    let persistFrame: number | undefined
    const handleScroll = () => {
      pageScrollTopRef.current[page] = mainContent.scrollTop
      if (persistFrame !== undefined) return
      persistFrame = window.requestAnimationFrame(() => {
        persistFrame = undefined
        persistUiState()
      })
    }
    mainContent.addEventListener('scroll', handleScroll, { passive: true })
    return () => {
      window.cancelAnimationFrame(restoreFrame)
      if (persistFrame !== undefined) window.cancelAnimationFrame(persistFrame)
      pageScrollTopRef.current[page] = mainContent.scrollTop
      persistUiState()
      mainContent.removeEventListener('scroll', handleScroll)
    }
  }, [activePage, persistUiState])

  const {
    stretchCompensation,
    stretchError,
    stretchUpdating,
    updateStretchCompensation,
    audioGain,
    gainError,
    updateAudioGain,
    audioRestarting,
    audioRestartError,
    restartAudio,
  } = useAudioControls({
    platform,
    nativeRuntime,
    onToast: setToast,
  })

  const [signalMonitorOpening, setSignalMonitorOpening] = useState(false)
  const [signalMonitorError, setSignalMonitorError] = useState('')
  const openSignalMonitor = async () => {
    if (!nativeRuntime || platform !== 'macos' || signalMonitorOpening) return
    setSignalMonitorOpening(true)
    setSignalMonitorError('')
    try {
      await invoke('open_signal_monitor')
    } catch (error) {
      setSignalMonitorError(`无法打开语音链路监测：${String(error)}`)
    } finally {
      setSignalMonitorOpening(false)
    }
  }

  const updateBehaviorState = useCallback((next: BehaviorMap) => {
    setBehaviors(next)
    setAutoSaveState('saving')
  }, [])

  const updateSelectedBehaviorList = useCallback(
    (update: (list: Behavior[]) => Behavior[]) => {
      setBehaviors(current => updateBehaviorList(current, selectedBehavior.buttonId, selectedBehavior.trigger, update))
      setAutoSaveState('saving')
    },
    [selectedBehavior],
  )

  const profileName = (base: string, existing: MappingProfile[]) => {
    const normalized = normalizeProfileName(base)
    const names = new Set(existing.map(profile => profile.name))
    if (!names.has(normalized)) return normalized
    let index = 2
    while (names.has(`${normalized} ${index}`)) index += 1
    return `${normalized} ${index}`
  }

  const switchMappingProfile = (id: string, notifyOnDesktop = false) => {
    const current = profileStateRef.current
    const next = changeProfileState(current, id)
    if (!next) return
    const target = next.profiles.find(profile => profile.id === id)!
    // Advance the ref before rendering so consecutive hardware events compose.
    profileStateRef.current = next
    setProfiles(next.profiles)
    setActiveProfileIds(next.activeProfileIds)
    if (target.deviceId === selectedDeviceId) {
      dispatchBehaviorHistory({ type: 'replace', present: next.behaviors })
      setCapturingBehaviorId(null)
      setEditingBehaviorId(null)
      setDraftBehavior(null)
      setTextInputDraft(null)
      setSequencePasteOpen(false)
    } else {
      dispatchBehaviorHistory({ type: 'rebaseDevice', deviceId: target.deviceId, behaviors: next.behaviors })
    }
    setAutoSaveState('saving')
    if (notifyOnDesktop && nativeRuntime) {
      const from = current.profiles.find(profile => profile.id === current.activeProfileIds[target.deviceId])!.name
      logInfo(`Showing profile switch notification: ${from} -> ${target.name}`)
      void invoke('show_profile_switch_overlay', {
        device: devices.find(device => device.id === target.deviceId)!.name,
        from,
        to: target.name,
      }).catch(error => logError('Failed to show profile switch notification', error))
    }
    setToast(`已切换到“${target.name}”`)
    window.setTimeout(() => setToast(''), 1800)
  }

  const profileSwitchRef = useRef<(request: ProfileSwitchRequest) => void>(() => {})
  profileSwitchRef.current = request => {
    const current = profileStateRef.current
    if (request.deviceId !== 'rc003' && request.deviceId !== 'cmiotA15' && request.deviceId !== 'mouse') return
    const id = adjacentProfileId(current.profiles, current.activeProfileIds[request.deviceId], request)
    if (id) switchMappingProfile(id, true)
  }
  useEffect(() => {
    if (!nativeRuntime) return
    let active = true
    let unlisten: (() => void) | undefined
    void listen<ProfileSwitchRequest>('axonkey-switch-profile', ({ payload }) => {
      if (active) profileSwitchRef.current(payload)
    })
      .then(cleanup => {
        if (active) unlisten = cleanup
        else cleanup()
      })
      .catch(error => logError('Failed to listen for profile switching', error))
    return () => {
      active = false
      unlisten?.()
    }
  }, [nativeRuntime])

  const activateNewProfile = (profile: MappingProfile) => {
    const current = profileStateRef.current
    const next = {
      profiles: [...snapshotDeviceProfiles(current.profiles, current.activeProfileIds, current.behaviors), profile],
      activeProfileIds: { ...current.activeProfileIds, [profile.deviceId]: profile.id },
      behaviors: mergeDeviceBehaviors(current.behaviors, profile.deviceId, profile.behaviors),
    }
    profileStateRef.current = next
    setProfiles(next.profiles)
    setActiveProfileIds(next.activeProfileIds)
    dispatchBehaviorHistory({ type: 'replace', present: next.behaviors })
    setCapturingBehaviorId(null)
    setEditingBehaviorId(null)
    setDraftBehavior(null)
    setTextInputDraft(null)
    setSequencePasteOpen(false)
  }

  const createMappingProfileFromScratch = () => {
    const next = createMappingProfile(profileName('新配置', deviceProfiles), createEmptyBehaviorMap(), selectedDeviceId)
    activateNewProfile(next)
    setAutoSaveState('saving')
    setToast(`已新增“${next.name}”`)
    window.setTimeout(() => setToast(''), 1800)
  }

  const duplicateMappingProfile = () => {
    const current = profiles.find(profile => profile.id === activeProfileId)
    if (!current) return
    const next = createMappingProfile(profileName(`${current.name} 副本`, deviceProfiles), behaviors, selectedDeviceId)
    activateNewProfile(next)
    setAutoSaveState('saving')
    setToast(`已复制为“${next.name}”`)
    window.setTimeout(() => setToast(''), 1800)
  }

  const renameMappingProfile = (name: string) => {
    const nextName = profileName(
      name,
      deviceProfiles.filter(profile => profile.id !== activeProfileId),
    )
    setProfiles(current =>
      current.map(profile => (profile.id === activeProfileId ? { ...profile, name: nextName } : profile)),
    )
    setToast(`配置文件已重命名为“${nextName}”`)
    window.setTimeout(() => setToast(''), 1800)
  }

  const saveImportedProfile = (name: string) => {
    const pending = pendingProfileImport
    if (!pending) return
    const next = createMappingProfile(
      profileName(
        name,
        profiles.filter(profile => profile.deviceId === pending.deviceId),
      ),
      pending.behaviors,
      pending.deviceId,
    )
    activateNewProfile(next)
    if (pending.enabled !== undefined) {
      if (pending.deviceId === 'mouse') setMouseEnabled(pending.enabled)
      else setEnabled(pending.enabled)
    }
    setPendingProfileImport(null)
    setEditingBehaviorId(null)
    setDraftBehavior(null)
    setTextInputDraft(null)
    setSequencePasteOpen(false)
    setAutoSaveState('saving')
    setToast(`已导入并切换到“${next.name}”`)
    window.setTimeout(() => setToast(''), 2200)
  }

  const deleteMappingProfile = () => {
    if (deviceProfiles.length <= 1) return
    const current = profiles.find(profile => profile.id === activeProfileId)
    if (!current || !window.confirm(`确定删除配置文件“${current.name}”吗？`)) return
    const remaining = snapshotDeviceProfiles(profiles, activeProfileIds, behaviors).filter(
      profile => profile.id !== activeProfileId,
    )
    const next = remaining.find(profile => profile.deviceId === selectedDeviceId)!
    const nextState = {
      profiles: remaining,
      activeProfileIds: { ...activeProfileIds, [selectedDeviceId]: next.id },
      behaviors: mergeDeviceBehaviors(behaviors, selectedDeviceId, next.behaviors),
    }
    profileStateRef.current = nextState
    setProfiles(nextState.profiles)
    setActiveProfileIds(nextState.activeProfileIds)
    dispatchBehaviorHistory({ type: 'replace', present: nextState.behaviors })
    setEditingBehaviorId(null)
    setDraftBehavior(null)
    setTextInputDraft(null)
    setAutoSaveState('saving')
    setToast(`已删除“${current.name}”`)
    window.setTimeout(() => setToast(''), 1800)
  }

  const requestProfileSwitch = useCallback(
    (inputId: InputId, trigger: TriggerType, behavior: SwitchProfileBehavior) => {
      setPendingProfileSwitch({ inputId, trigger, behavior })
    },
    [],
  )

  const updateWorkflow = useCallback((inputId: InputId, sequences: TriggerBehaviors) => {
    const current = profileStateRef.current
    const triggers = removedProfileSwitchTriggers(current.behaviors[inputId], sequences)
    if (triggers.length) {
      setPendingProfileSwitchDeletion({
        profileId: current.activeProfileIds[deviceForInput(inputId).id],
        inputId,
        triggers,
        sequences: cloneBehaviorMap({ ...current.behaviors, [inputId]: sequences })[inputId],
      })
      return false
    }
    setBehaviors(current => updateWorkflowInput(current, inputId, sequences))
    setAutoSaveState('saving')
  }, [])

  const processCliRequest = useCallback(
    async (request: CliRequest) => {
      const respond = async (response: Record<string, unknown>) => {
        await invoke('cli_write_response', {
          response: {
            protocol: cliSchema,
            id: request.id,
            ...response,
          },
        })
      }
      try {
        if (request.protocol !== cliSchema) throw new CliOperationError('invalid_arguments', '不支持的 CLI 协议版本')
        const params = cliParams(request.params)
        const state = profileStateRef.current
        const selectedDevice = selectedDeviceId
        const deviceId = cliDeviceId(params.device, selectedDevice)
        const device = devices.find(item => item.id === deviceId)!
        const platformName = cliPlatform(platform)
        const persistedProfiles = snapshotDeviceProfiles(state.profiles, state.activeProfileIds, state.behaviors)
        const profileValue = typeof params.profile === 'string' ? params.profile.trim() : ''
        const profile =
          profileValue !== '' && profileValue !== 'active'
            ? persistedProfiles.find(
                item => item.deviceId === deviceId && (item.id === profileValue || item.name === profileValue),
              )
            : persistedProfiles.find(item => item.deviceId === deviceId && item.id === state.activeProfileIds[deviceId])
        if (!profile && request.method !== 'keymap.get')
          throw new CliOperationError('invalid_target', '找不到指定配置文件')

        if (request.method === 'capabilities') {
          await respond({
            ok: true,
            result: {
              schema: cliSchema,
              platform: platformName,
              appVersion: appPackage.version,
              triggers: ['click', 'doubleClick', 'longPress'],
              sequence: {
                type: 'array',
                description: '按顺序执行的行为；空数组表示保留原始输入',
              },
              behaviors: [
                { type: 'key', fields: ['key'] },
                { type: 'shortcut', fields: ['keys'] },
                { type: 'wheel', fields: ['direction'] },
                { type: 'mouse', fields: ['button'] },
                { type: 'cursorMove', fields: ['direction', 'distance'], distance: { min: 1, max: 500 } },
                { type: 'paste', fields: ['text'] },
                { type: 'typeText', fields: ['text'] },
                { type: 'delay', fields: ['ms'], ms: { min: 0, max: 300000 } },
                { type: 'openApp', fields: ['path'] },
                { type: 'openPath', fields: ['path'] },
                { type: 'openWebsite', fields: ['url'] },
                { type: 'switchProfile', fields: ['direction', 'wrap'] },
                { type: 'disabled', fields: [] },
              ],
              devices: devices.map(item => ({
                id: item.id,
                name: item.name,
                model: item.model,
                inputKind: item.inputKind,
                keymap: item.remoteView
                  ? { method: 'keymap.get', format: 'svg' }
                  : { method: 'keymap.get', format: null, coordinateSystem: 'semantic-inputs' },
                inputs: item.inputIds.map(inputId => {
                  const button = item.buttons?.find(candidate => candidate.id === inputId)
                  return { id: inputId, label: button?.label ?? inputId }
                }),
              })),
              profiles: Object.fromEntries(
                devices.map(item => [
                  item.id,
                  persistedProfiles
                    .filter(profileItem => profileItem.deviceId === item.id)
                    .map(profileItem => ({
                      id: profileItem.id,
                      name: profileItem.name,
                      active: profileItem.id === state.activeProfileIds[item.id],
                    })),
                ]),
              ),
            },
          })
          return
        }
        if (request.method === 'status') {
          await respond({
            ok: true,
            result: {
              schema: cliSchema,
              appVersion: appPackage.version,
              platform: platformName,
              mappingEnabled: enabled,
              mouseEnabled,
            },
          })
          return
        }
        if (request.method === 'keymap.get') {
          const remoteView = device.remoteView
          const artwork = remoteView
            ? {
                format: 'svg',
                url: remoteView.artworkUrl,
                ariaLabel: remoteView.ariaLabel,
                viewBox: remoteView.viewBox,
                svg: await loadCliKeymapSvg(remoteView.artworkUrl),
              }
            : null
          const keys = device.inputIds.map(inputId => {
            const button = device.buttons?.find(candidate => candidate.id === inputId)
            const mouseInput = mouseInputs.find(candidate => candidate.id === inputId)
            const region = remoteView?.keyRegions[inputId]
            const normalized =
              remoteView && region
                ? {
                    x: region.anchor.x / remoteView.viewBox.width,
                    y: region.anchor.y / remoteView.viewBox.height,
                  }
                : null
            const verticalZone = normalized
              ? normalized.y < 1 / 3
                ? 'upper'
                : normalized.y < 2 / 3
                  ? 'middle'
                  : 'lower'
              : null
            const horizontalZone = normalized
              ? normalized.x < 1 / 3
                ? 'left'
                : normalized.x < 2 / 3
                  ? 'center'
                  : 'right'
              : null
            return {
              id: inputId,
              label: button?.label ?? mouseInput?.label ?? inputId,
              short: button?.short ?? null,
              side: button?.side ?? null,
              position:
                button && remoteView
                  ? {
                      percent: { x: button.x, y: button.y },
                      viewBox: region?.anchor ?? null,
                      normalized,
                      zone: { vertical: verticalZone, horizontal: horizontalZone },
                    }
                  : null,
              regionPath: region?.path ?? null,
              context: mouseInput?.contextLabel ?? null,
            }
          })
          await respond({
            ok: true,
            result: {
              schema: cliSchema,
              device: { id: device.id, name: device.name, model: device.model, inputKind: device.inputKind },
              artwork,
              layout: remoteView
                ? {
                    coordinateSystem: 'svg-viewBox',
                    origin: 'top-left',
                    percentRange: { x: [0, 100], y: [0, 100] },
                    verticalZones: {
                      upper: [0, 33.333],
                      middle: [33.333, 66.667],
                      lower: [66.667, 100],
                    },
                  }
                : { coordinateSystem: 'semantic-inputs' },
              keys,
            },
          })
          return
        }
        if (!profile) throw new CliOperationError('invalid_target', '找不到指定配置文件')
        if (request.method === 'profile.list') {
          await respond({
            ok: true,
            result: {
              device: deviceId,
              profiles: persistedProfiles
                .filter(item => item.deviceId === deviceId)
                .map(item => ({ id: item.id, name: item.name, active: item.id === state.activeProfileIds[deviceId] })),
            },
          })
          return
        }

        if (!['mapping', 'shortcut'].some(prefix => request.method.startsWith(prefix + '.'))) {
          throw new CliOperationError('invalid_arguments', '不支持的 CLI 操作：' + request.method)
        }
        const action = request.method.split('.')[1]
        const inputValue = params.button ?? params.input
        const inputId = action === 'list' && inputValue === undefined ? null : cliInputId(inputValue, deviceId)
        const trigger = cliTrigger(params.trigger)
        const targetSequence = inputId ? profile.behaviors[inputId][trigger] : null
        const publicTarget = inputId ? cliPublicSequence(targetSequence!, platform) : null

        if (action === 'list') {
          await respond({
            ok: true,
            result: {
              device: deviceId,
              profile: { id: profile.id, name: profile.name, active: profile.id === state.activeProfileIds[deviceId] },
              mappings: device.inputIds.flatMap(input =>
                (['click', 'doubleClick', 'longPress'] as TriggerType[]).map(triggerName => ({
                  button: input,
                  trigger: triggerName,
                  actions: cliPublicSequence(profile.behaviors[input][triggerName], platform),
                })),
              ),
            },
          })
          return
        }
        if (!inputId || !targetSequence || !publicTarget) {
          throw new CliOperationError('invalid_target', 'get、set、clear 必须指定 button 或 input')
        }
        if (action === 'get') {
          await respond({
            ok: true,
            result: {
              device: deviceId,
              profile: { id: profile.id, name: profile.name },
              button: inputId,
              trigger,
              actions: publicTarget,
            },
          })
          return
        }
        if (action !== 'set' && action !== 'clear') {
          throw new CliOperationError('invalid_arguments', '不支持的映射操作：' + action)
        }
        if (action === 'clear' && params.yes !== true) {
          throw new CliOperationError('invalid_arguments', '清除映射需要 --yes')
        }
        const rawSequence =
          action === 'clear'
            ? []
            : request.method.startsWith('shortcut.')
              ? [{ type: 'shortcut', keys: params.keys }]
              : (params.sequence ?? params.actions ?? (params.action === undefined ? undefined : [params.action]))
        const normalized = normalizeCliSequence(rawSequence, platformName)
        if (!normalized) throw new CliOperationError('invalid_behavior', '行为序列格式不正确，请参考 capabilities')
        const nextSequence = normalized.map((item, index) => {
          const behavior = cliBehaviorToBehavior(item, platformName, inputId + '-' + trigger + '-' + (index + 1))
          if (!behavior) throw new CliOperationError('invalid_behavior', '行为格式不正确，请参考 capabilities')
          return behavior
        })
        const before = publicTarget
        const after = cliPublicSequence(nextSequence, platform)
        if (params.dryRun === true) {
          await respond({
            ok: true,
            result: {
              dryRun: true,
              device: deviceId,
              profile: { id: profile.id, name: profile.name },
              button: inputId,
              trigger,
              before,
              after,
            },
          })
          return
        }
        const nextProfile = {
          ...profile,
          behaviors: updateBehaviorList(profile.behaviors, inputId, trigger, () => nextSequence),
        }
        const nextProfiles = persistedProfiles.map(item => (item.id === profile.id ? nextProfile : item))
        const isActive = profile.id === state.activeProfileIds[deviceId]
        const nextBehaviors = isActive
          ? mergeDeviceBehaviors(state.behaviors, deviceId, nextProfile.behaviors)
          : state.behaviors
        const nextState = { profiles: nextProfiles, activeProfileIds: state.activeProfileIds, behaviors: nextBehaviors }
        profileStateRef.current = nextState
        setProfiles(nextProfiles)
        if (isActive) setBehaviors(nextBehaviors)
        setAutoSaveState('saving')
        if (isActive) await new Promise<void>(resolve => window.setTimeout(resolve, 0))
        await respond({
          ok: true,
          result: {
            applied: true,
            device: deviceId,
            profile: { id: profile.id, name: profile.name },
            button: inputId,
            trigger,
            before,
            after,
          },
        })
      } catch (error) {
        const code = error instanceof CliOperationError ? error.code : 'app_error'
        const message = error instanceof Error ? error.message : String(error)
        try {
          await respond({ ok: false, error: { code, message } })
        } catch (responseError) {
          logError('Failed to write CLI response', responseError)
        }
      }
    },
    [enabled, mouseEnabled, nativeRuntime, platform, selectedDeviceId, setBehaviors],
  )

  useEffect(() => {
    if (!nativeRuntime || !platformReady) return
    let active = true
    let polling = false
    const poll = async () => {
      if (!active || polling) return
      polling = true
      try {
        const requests = await invoke<CliRequest[]>('cli_poll_requests')
        for (const request of requests) {
          if (!active) break
          await processCliRequest(request)
        }
      } catch (error) {
        logError('Failed to poll CLI requests', error)
      } finally {
        polling = false
      }
    }
    void poll()
    const timer = window.setInterval(() => void poll(), 120)
    return () => {
      active = false
      window.clearInterval(timer)
    }
  }, [nativeRuntime, platformReady, processCliRequest])

  useEffect(() => {
    // Discard legacy coordinates so shipped artwork positions always take effect.
    try {
      const storage = window.localStorage
      for (let index = storage.length - 1; index >= 0; index -= 1) {
        const key = storage.key(index)
        if (key?.startsWith('axonkey.debug-hit-positions.')) storage.removeItem(key)
      }
    } catch (error) {
      logError('Failed to remove legacy hit positions', error)
    }
  }, [])

  useEffect(() => {
    if (typeof window === 'undefined' || !('__TAURI_INTERNALS__' in window)) return
    let active = true
    void invoke<Platform>('get_platform')
      .then(detected => {
        if (active) {
          setPlatform(detected)
          setPlatformReady(true)
        }
      })
      .catch(error => logError('Failed to detect platform', error))
    return () => {
      active = false
    }
  }, [])

  useEffect(() => {
    document.documentElement.classList.toggle('macos-vibrancy', nativeRuntime && platform === 'macos')
    return () => document.documentElement.classList.remove('macos-vibrancy')
  }, [nativeRuntime, platform])

  useEffect(() => {
    window.localStorage.setItem(
      settingsStorageKey,
      JSON.stringify({
        showRecordingOverlay,
        cmiotA15RecordingMode,
        showRemoteKeyGrid,
        showMouseKeyGrid,
        behaviors,
        enabled,
        mouseEnabled,
        mouseKeyHoldMs,
        mouseScrollSensitivity,
        mouseIgnoreScrollAcceleration,
        mouseVerticalScrollIntervalMs,
        mouseHorizontalScrollIntervalMs,
        mouseEdgeWidth,
      }),
    )
    const revision = saveRevisionRef.current + 1
    saveRevisionRef.current = revision
    const syncNativeSettings = async () => {
      try {
        if ('__TAURI_INTERNALS__' in window) {
          await invoke('update_input_settings', {
            settings: {
              showRecordingOverlay,
              cmiotA15RecordingMode,
              behaviors,
              enabled,
              mouseEnabled,
              mouseKeyHoldMs,
              mouseScrollSensitivity,
              mouseIgnoreScrollAcceleration,
              mouseVerticalScrollIntervalMs,
              mouseHorizontalScrollIntervalMs,
              mouseEdgeWidth,
            },
          })
        }
        if (saveRevisionRef.current === revision) {
          setAutoSaveState('saved')
        }
      } catch (error) {
        if (saveRevisionRef.current !== revision) return
        logError('Failed to apply input mapping settings', error)
        setAutoSaveState('error')
        setToast(`映射已保存，但尚未应用：${String(error)}`)
      }
    }
    void syncNativeSettings()
  }, [
    cmiotA15RecordingMode,
    showRecordingOverlay,
    showRemoteKeyGrid,
    showMouseKeyGrid,
    behaviors,
    enabled,
    mouseEnabled,
    mouseKeyHoldMs,
    mouseScrollSensitivity,
    mouseIgnoreScrollAcceleration,
    mouseVerticalScrollIntervalMs,
    mouseHorizontalScrollIntervalMs,
    mouseEdgeWidth,
    applyRetry,
  ])

  useEffect(() => {
    const persistedProfiles = snapshotDeviceProfiles(profiles, activeProfileIds, behaviors)
    try {
      window.localStorage.setItem(
        profilesStorageKey,
        JSON.stringify({ version: 2, migrationReviewed: true, activeProfileIds, profiles: persistedProfiles }),
      )
    } catch (error) {
      logError('Failed to save mapping profiles', error)
    }
  }, [profiles, activeProfileIds, behaviors])

  useEffect(
    () => () => {
      if (behaviorAttentionTimerRef.current !== undefined) {
        window.clearTimeout(behaviorAttentionTimerRef.current)
      }
    },
    [],
  )

  useEffect(() => {
    const remotes = deviceInstances.snapshot.discovered.filter(d => d.kind === 'rc003' && d.connected)
    setBatteryLevel(remotes.length === 1 ? (remotes[0].deviceInfo?.batteryLevel ?? null) : null)
  }, [deviceInstances.snapshot.discovered])

  useEffect(() => {
    if (typeof window === 'undefined' || !('__TAURI_INTERNALS__' in window)) return
    let mounted = true
    let unlisten: (() => void) | undefined
    const clearPressed = () => {
      if (pressedClearTimerRef.current !== undefined) window.clearTimeout(pressedClearTimerRef.current)
      pressedClearTimerRef.current = undefined
      setPressedId(null)
    }
    const handleRemoteKey = (event: { payload: RemoteKeyEvent }) => {
      if (!(allRemoteButtons ?? buttons).some(button => button.id === event.payload.button)) return
      if (pressedClearTimerRef.current !== undefined) window.clearTimeout(pressedClearTimerRef.current)
      pressedClearTimerRef.current = undefined
      if (event.payload.pressed) {
        setPressedId(event.payload.button)
        return
      }
      // Keep a quick tap visible long enough for the eye to catch it.
      pressedClearTimerRef.current = window.setTimeout(() => {
        pressedClearTimerRef.current = undefined
        setPressedId(current => (current === event.payload.button ? null : current))
      }, 180)
    }
    void listen<RemoteKeyEvent>('axonkey-remote-key', handleRemoteKey).then(cleanup => {
      if (mounted) unlisten = cleanup
      else cleanup()
    })
    window.addEventListener('blur', clearPressed)
    document.addEventListener('visibilitychange', clearPressed)
    return () => {
      mounted = false
      unlisten?.()
      window.removeEventListener('blur', clearPressed)
      document.removeEventListener('visibilitychange', clearPressed)
      clearPressed()
    }
  }, [])

  useEffect(() => {
    if (!capturingBehaviorId) return
    const handleOutsideKey = (event: globalThis.KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault()
        setCapturingBehaviorId(null)
      }
    }
    window.addEventListener('keydown', handleOutsideKey)
    return () => window.removeEventListener('keydown', handleOutsideKey)
  }, [capturingBehaviorId])

  const resetMappings = () => {
    const defaults = createDefaultBehaviorMap()
    setBehaviors(current => ({
      ...current,
      ...Object.fromEntries(selectedDevice.inputIds.map(id => [id, defaults[id]])),
    }))
    setAutoSaveState('saving')
    setToast('已恢复默认映射，将自动保存')
    window.setTimeout(() => setToast(''), 2200)
  }

  const toggleEnabled = () => {
    if (!enabled && platform === 'macos' && (!macPermissions.inputMonitoring || !macPermissions.accessibility)) {
      setSettingsSection('permissions')
      navigateToPage('settings')
    }
    setEnabled(value => !value)
    setAutoSaveState('saving')
  }

  const handleBrandClick = () => {
    const now = Date.now()
    const clickState = brandClickRef.current
    if (now - clickState.lastAt > 1200) clickState.count = 0
    clickState.count += 1
    clickState.lastAt = now
    if (clickState.count < 5) return
    clickState.count = 0
    setDebugMode(current => {
      const next = !current
      setToast(next ? '调试模式已开启' : '调试模式已关闭')
      window.setTimeout(() => setToast(''), 2200)
      return next
    })
  }

  const openDevtools = () => {
    if (!nativeRuntime || !debugMode) return
    void invoke('plugin:webview|internal_toggle_devtools').catch(error => {
      logError('Failed to toggle web developer tools', error)
      setToast('打开开发者工具失败')
      window.setTimeout(() => setToast(''), 2200)
    })
  }

  const revealBehaviorEditor = () => {
    window.requestAnimationFrame(() => {
      const editor = behaviorEditorRef.current
      if (!editor) return
      const rect = editor.getBoundingClientRect()
      const topbarBottom =
        document.querySelector('.device-workspace-header, .topbar')?.getBoundingClientRect().bottom ?? 0
      const noticeBottom = document.querySelector('.mapping-disabled-notice')?.getBoundingClientRect().bottom ?? 0
      const editorFullyVisible =
        rect.top >= Math.max(topbarBottom, noticeBottom) + 8 && rect.bottom <= window.innerHeight - 8
      if (!editorFullyVisible) {
        const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches
        editor.scrollIntoView({ behavior: reduceMotion ? 'auto' : 'smooth', block: 'start' })
      }

      setBehaviorEditorAttention(false)
      window.requestAnimationFrame(() => setBehaviorEditorAttention(true))
      if (behaviorAttentionTimerRef.current !== undefined) {
        window.clearTimeout(behaviorAttentionTimerRef.current)
      }
      behaviorAttentionTimerRef.current = window.setTimeout(() => {
        behaviorAttentionTimerRef.current = undefined
        setBehaviorEditorAttention(false)
      }, 900)
    })
  }

  const returnToSelectedMapping = () => {
    const selectedRow = rowRefs.current[selectedBehavior.buttonId]
    if (!selectedRow) return
    const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches
    selectedRow.scrollIntoView({ behavior: reduceMotion ? 'auto' : 'smooth', block: 'center' })
  }

  const selectBehaviorTarget = (buttonId: InputId, trigger: TriggerType, reveal = true) => {
    const device = deviceForInput(buttonId)
    if (device.id !== selectedDeviceId) {
      // An undo stack belongs to the editor that created it. Preserve both
      // running mappings while discarding history from the previous device.
      dispatchBehaviorHistory({ type: 'replace', present: profileStateRef.current.behaviors })
    }
    setSelectedDeviceId(device.id)
    if (device.inputKind === 'button') setActiveId(buttonId as ButtonId)
    setSelectedBehavior({ buttonId, trigger })
    setCapturingBehaviorId(null)
    setEditingBehaviorId(null)
    setDraftBehavior(null)
    setTextInputDraft(null)
    setSequencePasteOpen(false)
    if (reveal) revealBehaviorEditor()
  }

  const showBehaviorToast = useCallback((message: string) => {
    setToast(message)
    window.setTimeout(() => setToast(''), 1600)
  }, [])

  const clearBehaviorEditingState = useCallback(() => {
    setCapturingBehaviorId(null)
    setEditingBehaviorId(null)
    setDraftBehavior(null)
    setTextInputDraft(null)
    setSequencePasteOpen(false)
  }, [])

  const undoBehaviorChange = useCallback(() => {
    if (!canUndoBehavior) return
    dispatchBehaviorHistory({ type: 'undo' })
    setAutoSaveState('saving')
    clearBehaviorEditingState()
    showBehaviorToast('已撤销行为更改')
  }, [canUndoBehavior, clearBehaviorEditingState, showBehaviorToast])

  const redoBehaviorChange = useCallback(() => {
    if (!canRedoBehavior) return
    dispatchBehaviorHistory({ type: 'redo' })
    setAutoSaveState('saving')
    clearBehaviorEditingState()
    showBehaviorToast('已重做行为更改')
  }, [canRedoBehavior, clearBehaviorEditingState, showBehaviorToast])

  useEffect(() => {
    const handleHistoryShortcut = (event: globalThis.KeyboardEvent) => {
      if (event.defaultPrevented || event.altKey || (!event.metaKey && !event.ctrlKey)) return
      const target = event.target
      if (
        target instanceof HTMLElement &&
        (target.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName))
      )
        return
      const key = event.key.toLowerCase()
      const undo = key === 'z' && !event.shiftKey
      const redo = (key === 'z' && event.shiftKey) || (key === 'y' && event.ctrlKey && !event.metaKey)
      if (undo && canUndoBehavior) {
        event.preventDefault()
        undoBehaviorChange()
      } else if (redo && canRedoBehavior) {
        event.preventDefault()
        redoBehaviorChange()
      }
    }
    window.addEventListener('keydown', handleHistoryShortcut)
    return () => window.removeEventListener('keydown', handleHistoryShortcut)
  }, [canRedoBehavior, canUndoBehavior, redoBehaviorChange, undoBehaviorChange])

  const mappingExportFilename = (date = new Date(), profileName?: string) => {
    const pad = (value: number) => String(value).padStart(2, '0')
    const timestamp = `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`
    const slug =
      profileName
        ?.trim()
        .replace(/[^\w\u4e00-\u9fff-]+/g, '-')
        .replace(/^-+|-+$/g, '') || 'mapping'
    return `axonkey-profile-${slug}-${timestamp}.json`
  }

  const exportMappings = async () => {
    const activeProfile = profiles.find(profile => profile.id === activeProfileId)
    const serialized = JSON.stringify(
      createMappingExport(
        behaviors,
        isMouse ? mouseEnabled : enabled,
        undefined,
        activeProfile?.name,
        selectedDeviceId,
      ),
      null,
      2,
    )
    const filename = mappingExportFilename(new Date(), activeProfile?.name)

    if (nativeRuntime) {
      try {
        const path = await save({
          defaultPath: filename,
          filters: [{ name: 'Axonkey 映射规则', extensions: ['json'] }],
        })
        if (!path) return
        await invoke('write_mapping_file', { path, content: serialized })
        showBehaviorToast(`映射规则已保存：${path.split(/[\\/]/).pop() ?? filename}`)
      } catch (error) {
        logError('Failed to export mapping file', error)
        setToast(`导出失败：${String(error)}`)
        window.setTimeout(() => setToast(''), 3200)
      }
      return
    }

    const blob = new Blob([serialized], { type: 'application/json' })
    const url = URL.createObjectURL(blob)
    const link = document.createElement('a')
    link.href = url
    link.download = filename
    document.body.appendChild(link)
    link.click()
    link.remove()
    window.setTimeout(() => URL.revokeObjectURL(url), 0)
    showBehaviorToast('映射规则已导出')
  }

  const createBackup = () =>
    createDataBackup(
      {
        ...profileStateRef.current,
        savedSequences: parseSavedSequences(window.localStorage.getItem(savedSequencesStorageKey)),
        settings: {
          showRecordingOverlay,
          cmiotA15RecordingMode,
          showRemoteKeyGrid,
          showMouseKeyGrid,
          enabled,
          mouseEnabled,
          mouseKeyHoldMs,
          mouseScrollSensitivity,
          mouseIgnoreScrollAcceleration,
          mouseVerticalScrollIntervalMs,
          mouseHorizontalScrollIntervalMs,
          mouseEdgeWidth,
        },
        audio: { gain: audioGain, stretchCompensation },
        preferences: { sidebarCollapsed },
      },
      appPackage.version,
    )

  const restoreDataBackup = (backup: ParsedBackup) => {
    restoreBackupStorage(
      window.localStorage,
      backup,
      {
        profiles: profilesStorageKey,
        settings: settingsStorageKey,
        savedSequences: savedSequencesStorageKey,
        audio: audioSettingsStorageKey,
        uiState: uiStateStorageKey,
      },
      uiStateRef.current,
    )
    // A queued scroll-save may run while the reload navigation starts.
    uiStateRef.current = {
      ...uiStateRef.current,
      sidebarCollapsed: backup.preferences.sidebarCollapsed,
      activePage: 'settings',
      settingsSection: 'backup',
    }
    window.location.reload()
  }

  const cloudMetadataInitialized = useRef(false)
  useEffect(() => {
    if (!deviceInstances.loaded || !platformReady) return
    try {
      annotateSnapshot(
        createCloudSnapshot(createBackup(), deviceInstances.snapshot.store.instances),
        cloudSource(platform === 'windows' || platform === 'macos' ? platform : 'unknown'),
        appPackage.version,
        !cloudMetadataInitialized.current,
      )
      cloudMetadataInitialized.current = true
    } catch (error) {
      logError('Failed to save cloud profile metadata', error)
    }
  }, [deviceInstances.loaded, deviceInstances.snapshot.store, platformReady, profiles, activeProfileIds, behaviors])

  const cloud = useCloudSync({
    native: nativeRuntime,
    ready: platformReady && deviceInstances.loaded && !deviceInstances.busy && !deviceInstances.snapshot.error,
    snapshot: memory => {
      const source = cloudSource(platform === 'windows' || platform === 'macos' ? platform : 'unknown')
      const localMemory = Object.fromEntries(
        Object.entries(memory).map(([key, value]) => [key.replace(`/${source.source_installation_id}:`, '/'), value]),
      )
      return annotateSnapshot(
        createCloudSnapshot(createBackup(), deviceInstances.snapshot.store.instances, localMemory),
        source,
        appPackage.version,
      )
    },
    clearLocalData: async () => {
      await clearLocalData(window.localStorage, deviceInstances)
      // A queued scroll-save may run while the reload navigation starts.
      uiStateRef.current = getStoredUiState()
      window.location.reload()
    },
    restore: async (cloudState, selection) => {
      const restored = prepareCloudRestore(
        cloudState,
        createBackup(),
        deviceInstances.snapshot.store.instances,
        selection,
      )
      saveProfileMetadata(restored.metadata)
      let restoredCount = 0
      try {
        for (const instance of restored.instances) {
          if (deviceInstances.snapshot.store.instances.some(item => item.id === instance.id))
            await deviceInstances.update(instance.id, () => instance)
          else await deviceInstances.put(instance)
          restoredCount++
        }
        if (
          selection.settings ||
          selection.savedBehaviors ||
          selection.devices.some(item => item.targetId.startsWith('legacy:'))
        )
          restoreDataBackup(restored.backup)
      } catch (error) {
        throw new Error(`恢复未完成（已恢复 ${restoredCount} 个设备）：${String(error)}。请重试。`)
      }
    },
  })

  const openMappingImport = () => {
    mappingFileInputRef.current?.click()
  }

  const importMappings = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0]
    event.target.value = ''
    if (!file) return
    try {
      const imported = parseMappingImport(await file.text(), selectedDeviceId)
      if (!imported) throw new Error('unsupported mapping file')
      const fallbackName = file.name.replace(/\.[^.]+$/, '').trim() || '导入配置'
      setPendingProfileImport({
        ...imported,
        deviceId: selectedDeviceId,
        fileName: file.name,
        suggestedName: imported.profileName || fallbackName,
      })
    } catch (error) {
      logError('Failed to import mapping file', error)
      setToast('导入失败：请选择属于当前设备的 Axonkey 映射 JSON 文件')
      window.setTimeout(() => setToast(''), 3000)
    }
  }

  const replaceWithCommonBehavior = (next: Behavior[]) => {
    setBehaviors(current =>
      updateBehaviorList(current, selectedBehavior.buttonId, selectedBehavior.trigger, () => next),
    )
    setAutoSaveState('saving')
  }

  const copySelectedSequence = async () => {
    const sequence = behaviors[selectedBehavior.buttonId][selectedBehavior.trigger]
    try {
      await writeClipboardText(serializeSequence(sequence))
      showBehaviorToast('当前序列已复制')
    } catch (error) {
      logError('Failed to copy behavior sequence', error)
      showBehaviorToast('复制失败，请重试')
    }
  }

  const replaceWithKey = (key: string) => {
    replaceWithCommonBehavior([createBehavior({ type: 'key', key })])
    showBehaviorToast(`已设置为${keyDisplayName(key, platform)}`)
  }

  const beginBehaviorDraft = (type: AdvancedBehaviorType, mode: DraftBehaviorState['mode']) => {
    const behavior =
      type === 'key'
        ? { ...createBehavior({ type: 'shortcut' }), keys: [] }
        : createBehavior(
            type === 'paste' || type === 'typeText'
              ? { type, text: '' }
              : type === 'openApp' || type === 'openPath'
                ? { type, path: '' }
                : type === 'openWebsite'
                  ? { type, url: '' }
                  : { type, ms: 300 },
          )
    setEditingBehaviorId(null)
    setDraftBehavior({ behavior, mode })
    setCapturingBehaviorId(type === 'key' ? behavior.id : null)
  }

  const applyCommonBehavior = (preset: CommonBehaviorPreset) => {
    if (isRightModifierPreset(preset)) return replaceWithKey(rightModifierKeys[preset])
    switch (preset) {
      case 'wheelUp':
      case 'wheelDown':
      case 'wheelLeft':
      case 'wheelRight':
        if (platform !== 'windows' && platform !== 'macos') return
        {
          const direction = ({ wheelUp: 'up', wheelDown: 'down', wheelLeft: 'left', wheelRight: 'right' } as const)[
            preset
          ]
          replaceWithCommonBehavior([createBehavior({ type: 'wheel', direction })])
          showBehaviorToast(
            `已设为${direction === 'up' ? '滚轮向上' : direction === 'down' ? '滚轮向下' : direction === 'left' ? '水平滚轮向左' : '水平滚轮向右'}`,
          )
        }
        return
      case 'mouseLeft':
      case 'mouseRight':
        if (platform !== 'windows' && platform !== 'macos') return
        {
          const button = ({ mouseLeft: 'left', mouseRight: 'right' } as const)[preset]
          replaceWithCommonBehavior([createBehavior({ type: 'mouse', button })])
          showBehaviorToast(button === 'left' ? '已设为鼠标左键' : '已设为鼠标右键')
        }
        return
      case 'cursorUp':
      case 'cursorDown':
      case 'cursorLeft':
      case 'cursorRight':
        if (platform !== 'windows' && platform !== 'macos') return
        {
          const direction = ({ cursorUp: 'up', cursorDown: 'down', cursorLeft: 'left', cursorRight: 'right' } as const)[
            preset
          ]
          replaceWithCommonBehavior([createBehavior({ type: 'cursorMove', direction })])
          showBehaviorToast(
            `已设为${{ up: '光标上移', down: '光标下移', left: '光标左移', right: '光标右移' }[direction]} ${defaultCursorDistance} 像素`,
          )
        }
        return
      case 'original':
        replaceWithCommonBehavior([])
        showBehaviorToast(
          selectedBehavior.trigger === 'click' ? (isMouse ? '已恢复默认输入规则' : '已保留原按键') : '已清除此触发方式',
        )
        return
      case 'disabled':
        replaceWithCommonBehavior([createBehavior({ type: 'disabled' })])
        showBehaviorToast('已禁用这个触发方式')
        return
      case 'escape':
        return replaceWithKey('Esc')
      case 'enter':
        return replaceWithKey('Enter')
      case 'space':
        return replaceWithKey('Space')
      case 'tab':
        return replaceWithKey('Tab')
      case 'previousTab':
      case 'nextTab':
        replaceWithCommonBehavior([
          createBehavior({
            type: 'shortcut',
            keys: preset === 'previousTab' ? ['Ctrl', 'Shift', 'Tab'] : ['Ctrl', 'Tab'],
          }),
        ])
        showBehaviorToast(preset === 'previousTab' ? '已设为上一标签页' : '已设为下一标签页')
        return
      case 'backspace':
        return replaceWithKey('Backspace')
      case 'delete':
        return replaceWithKey('Delete')
      case 'deleteAllText': {
        const modifier = platform === 'macos' ? 'Win' : 'Ctrl'
        replaceWithCommonBehavior([
          createBehavior({ type: 'shortcut', keys: [modifier, 'A'] }),
          createBehavior({ type: 'delay', ms: 30 }),
          createBehavior({ type: 'shortcut', keys: [modifier, 'X'] }),
        ])
        showBehaviorToast('已设为删除全部文本')
        return
      }
      case 'keyHome':
        return replaceWithKey('Home')
      case 'keyEnd':
        return replaceWithKey('End')
      case 'pageUp':
        return replaceWithKey('PageUp')
      case 'pageDown':
        return replaceWithKey('PageDown')
      case 'arrowUp':
        return replaceWithKey('Up')
      case 'arrowDown':
        return replaceWithKey('Down')
      case 'arrowLeft':
        return replaceWithKey('Left')
      case 'arrowRight':
        return replaceWithKey('Right')
      case 'volumeUp':
        return replaceWithKey('VolumeUp')
      case 'volumeDown':
        return replaceWithKey('VolumeDown')
      case 'volumeMute':
        return replaceWithKey('VolumeMute')
      case 'mediaPlayPause':
        return replaceWithKey('MediaPlayPause')
      case 'mediaPrevious':
        return replaceWithKey('MediaPrevious')
      case 'mediaNext':
        return replaceWithKey('MediaNext')
      case 'mediaStop':
        return replaceWithKey('MediaStop')
      case 'customKey':
        beginBehaviorDraft('key', 'replace')
        return
      case 'typeText':
      case 'openPath':
      case 'openApp':
      case 'openWebsite':
        beginBehaviorDraft(preset, 'replace')
        return
      case 'textAndEnter':
        setTextInputDraft(textAndEnterValue(behaviors[selectedBehavior.buttonId][selectedBehavior.trigger]) ?? '')
    }
  }

  const commitDraftBehavior = (behavior = draftBehavior?.behavior) => {
    if (!draftBehavior || !behavior) return
    if (draftBehavior.mode === 'replace') replaceWithCommonBehavior([behavior])
    else updateSelectedBehaviorList(list => [...list, behavior])
    setDraftBehavior(null)
    setCapturingBehaviorId(null)
    showBehaviorToast(draftBehavior.mode === 'replace' ? '行为已更新' : '步骤已添加')
  }

  const commitTextInputPreset = () => {
    if (textInputDraft === null || !textInputDraft.trim()) return
    replaceWithCommonBehavior([
      createBehavior({ type: 'paste', text: textInputDraft }),
      createBehavior({ type: 'delay', ms: 30 }),
      createBehavior({ type: 'key', key: 'Enter' }),
    ])
    setTextInputDraft(null)
    showBehaviorToast('已设置输入文本并回车')
  }

  const removeBehavior = (behaviorId: string) => {
    const current = profileStateRef.current.behaviors[selectedBehavior.buttonId]
    if (
      updateWorkflow(selectedBehavior.buttonId, {
        ...current,
        [selectedBehavior.trigger]: current[selectedBehavior.trigger].filter(behavior => behavior.id !== behaviorId),
      }) === false
    )
      return
    if (capturingBehaviorId === behaviorId) setCapturingBehaviorId(null)
    if (editingBehaviorId === behaviorId) setEditingBehaviorId(null)
  }

  const moveSelectedBehavior = (behaviorId: string, direction: -1 | 1) => {
    const list = behaviors[selectedBehavior.buttonId][selectedBehavior.trigger]
    const index = list.findIndex(behavior => behavior.id === behaviorId)
    if (index < 0) return
    updateBehaviorState(
      moveBehavior(behaviors, selectedBehavior.buttonId, selectedBehavior.trigger, index, index + direction),
    )
  }

  const updateBehavior = (behaviorId: string, update: (behavior: Behavior) => Behavior) => {
    updateSelectedBehaviorList(list => list.map(behavior => (behavior.id === behaviorId ? update(behavior) : behavior)))
  }

  const captureBehaviorKey = (behavior: Behavior, event: KeyboardEvent<HTMLElement>) => {
    const captured = formatCapturedKey(event)
    if (!captured) return
    event.preventDefault()
    updateBehavior(behavior.id, current =>
      current.type === 'key' || current.type === 'shortcut'
        ? { ...behaviorFromCapturedKey(captured, current.id), enabled: current.enabled }
        : current,
    )
    setCapturingBehaviorId(null)
    setEditingBehaviorId(null)
  }

  const captureDraftBehaviorKey = (behavior: Behavior, event: KeyboardEvent<HTMLElement>) => {
    const captured = formatCapturedKey(event)
    if (!captured) return
    event.preventDefault()
    commitDraftBehavior(behaviorFromCapturedKey(captured, behavior.id))
  }

  const runDriverAction = async (driver: DriverKind, action: DriverActionKind) => {
    if (driver === 'input') return
    setSystemState(current => beginDriverAction(current, driver, action))
    try {
      logInfo(`Starting driver action: ${driver}/${action}`)
      const result = await invoke<DriverActionResult>('launch_driver_action', { driver, action })
      const driverName =
        driver === 'audio' ? (platform === 'macos' ? 'MiRemoteV 2ch' : 'Quarbor Virtual Microphone') : '按键驱动'
      const restartRequired = result.rebootRequired
      const reportedStatus = action === 'install' ? (restartRequired ? 'restartRequired' : 'installed') : 'missing'
      setSystemState(current =>
        finishDriverAction(current, driver, action, {
          success: true,
          status: reportedStatus,
          restartRequired,
          message:
            platform === 'macos'
              ? `${driverName}${action === 'install' ? '安装' : '卸载'}已完成，Core Audio 已刷新。日志：${result.logPath}`
              : `${driverName}${action === 'install' ? '安装' : '卸载'}已完成，${restartRequired ? '请重启 Windows' : '无需重启 Windows'}。日志：${result.logPath}`,
        }),
      )
      if (platform === 'macos') window.setTimeout(() => void probeAudioState(), 800)
      logInfo(`Driver action completed: ${driver}/${action}`)
    } catch (error) {
      logError(`Driver action failed: ${driver}/${action}`, error)
      const browserPreview = typeof window !== 'undefined' && !('__TAURI_INTERNALS__' in window)
      setSystemState(current =>
        finishDriverAction(current, driver, action, {
          success: false,
          status: 'error',
          error: browserPreview ? '浏览器预览不会启动系统脚本，请在 Tauri 桌面版中操作。' : String(error),
        }),
      )
    }
  }

  const installManagedDriver = async (instanceId: string) => {
    if (managedDriverAction?.status === 'running') return
    setManagedDriverAction({ instanceId, status: 'running' })
    if (platform === 'windows') reportTencentEvent('windows_hid_driver_install')
    try {
      const result = await invoke<DriverActionResult>('install_device_driver', {
        instanceId,
      })
      await deviceInstances.refresh()
      await new Promise(resolve => window.setTimeout(resolve, 900))
      await deviceInstances.refresh()
      const message = managedDriverInstallMessage(result)
      setManagedDriverAction(
        result.installationState === 'restart_before_install'
          ? { instanceId, status: 'restartRequired', message }
          : null,
      )
      setToast(message)
      window.setTimeout(() => setToast(''), 3200)
    } catch (error) {
      setManagedDriverAction(current => (current ? { ...current, status: 'error', error: String(error) } : current))
    }
  }

  const unbindManagedInstance = async (instanceId: string) => {
    try {
      if (nativeRuntime) {
        await invoke('unbind_device_instance', { instanceId })
      } else {
        await deviceInstances.update(instanceId, item => ({ ...item, binding: null }))
      }
      await deviceInstances.refresh()
      setToast('物理设备已解除绑定')
      window.setTimeout(() => setToast(''), 3200)
    } catch (error) {
      setToast(String(error))
      window.setTimeout(() => setToast(''), 4200)
      throw error
    }
  }

  const removeManagedInstance = async (instanceId: string) => {
    await unbindManagedInstance(instanceId)
    try {
      await deviceInstances.remove(instanceId)
      await deviceInstances.refresh()
      setToast('设备已移除')
      window.setTimeout(() => setToast(''), 3200)
    } catch (error) {
      setToast(String(error))
      window.setTimeout(() => setToast(''), 4200)
      throw error
    }
  }

  const openSystemSettings = async (
    page: 'bluetooth' | 'deviceManager' | 'sound' | 'services' | 'inputMonitoring' | 'accessibility',
  ) => {
    try {
      await invoke('open_system_settings', { page })
      return true
    } catch (error) {
      logError(`Failed to open system settings: ${page}`, error)
      setToast(`浏览器预览无法打开${platform === 'macos' ? '系统设置' : 'Windows 设置'}`)
      window.setTimeout(() => setToast(''), 2200)
      return false
    }
  }

  const requestMacPermission = async (kind: MacPermissionKind) => {
    const permissionName = kind === 'inputMonitoring' ? '输入监控' : '辅助功能'
    setPermissionHelperKind(kind)
    if (typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window) {
      try {
        await invoke('set_permission_helper_mode', { enabled: true })
      } catch (error) {
        logError('Failed to enable permission helper mode', error)
        setToast(`无法切换授权小窗：${String(error)}`)
      }
    }

    setToast(`正在打开${permissionName}授权…`)
    let granted = false
    try {
      logInfo(`Requesting macOS permission: ${kind}`)
      granted = await invoke<boolean>('request_macos_permission', { kind })
      if (granted) {
        setToast(`${permissionName}权限已授权`)
      } else {
        const opened = await openSystemSettings(kind)
        if (opened) setToast(`已打开${permissionName}设置`)
      }
    } catch (error) {
      logError(`Failed to request macOS permission: ${kind}`, error)
      const browserPreview = typeof window !== 'undefined' && !('__TAURI_INTERNALS__' in window)
      if (browserPreview) {
        setToast('浏览器预览不会打开系统设置')
      } else {
        setToast(`无法请求系统权限：${String(error)}`)
        await openSystemSettings(kind)
      }
    }
    window.setTimeout(() => setToast(''), granted ? 1800 : 2600)
    window.setTimeout(() => void probeSystemState(false), 900)
  }

  const closePermissionHelper = async () => {
    if (typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window) {
      try {
        await invoke('set_permission_helper_mode', { enabled: false })
      } catch (error) {
        logError('Failed to restore the main window after permission helper', error)
        setToast(`无法恢复主窗口：${String(error)}`)
      }
    }
    setPermissionHelperKind(null)
    void probeSystemState(false)
  }

  const revealCurrentApp = async () => {
    try {
      logInfo('Revealing the current Axonkey app in Finder')
      await invoke('reveal_current_app')
      setToast('已在 Finder 中定位 Axonkey')
    } catch (error) {
      logError('Failed to reveal the current Axonkey app', error)
      const browserPreview = typeof window !== 'undefined' && !('__TAURI_INTERNALS__' in window)
      setToast(browserPreview ? '桌面版会在 Finder 中定位 Axonkey' : `无法定位 Axonkey：${String(error)}`)
    }
    window.setTimeout(() => setToast(''), 2400)
  }

  const openLogDirectory = async () => {
    try {
      const info = await invoke<{ directory: string; currentFile: string }>('open_log_directory')
      logInfo('User opened the runtime log directory')
      setToast(`日志目录已打开：${info.directory}`)
    } catch (error) {
      logError('Failed to open the runtime log directory', error)
      setToast(nativeRuntime ? `无法打开日志目录：${String(error)}` : '浏览器预览不会打开日志目录')
    }
    window.setTimeout(() => setToast(''), 2600)
  }

  const probeSystemState = async (showChecking = true) => {
    if (systemProbeRunningRef.current || typeof window === 'undefined' || !('__TAURI_INTERNALS__' in window))
      return false
    systemProbeRunningRef.current = true
    if (showChecking) {
      setSystemState(current => setDeviceConnection(current, { status: 'checking', message: '正在检查 RC003…' }))
    }
    try {
      const probe = await invoke<SystemProbe>('probe_system_state')
      setPlatform(probe.platform)
      setMicrophoneDriverAbnormal(probe.platform === 'windows' && probe.microphone_driver_abnormal)
      setMicrophoneDriverWarningSuppressed(probe.platform === 'windows' && probe.microphone_driver_warning_suppressed)

      setInputAuthorizationStale(probe.platform === 'macos' && probe.input_authorization_stale === true)
      const mappingRecovering =
        probe.platform === 'macos' &&
        probe.input_backend_error === 'RC003 modifier hardware mappings could not be applied'
      setMacPermissions({
        inputMonitoring: probe.input_monitoring_granted === true,
        accessibility: probe.accessibility_granted === true,
        captureActive: probe.capture_active,
      })
      setSystemState(current => {
        const connectedDevice = {
          status: 'connected' as const,
          name: '小米遥控器 RC003',
          hardwareId: probe.device_hardware_id ?? undefined,
          message:
            probe.platform === 'macos'
              ? probe.input_authorization_stale
                ? '蓝牙已连接，但当前构建没有 HID 输入权限；重新授权后电源键、返回键等映射才会生效。'
                : probe.capture_active
                  ? 'IOKit 已识别 RC003，原始按键已被拦截。'
                  : 'macOS 已识别 RC003；启用映射后会由 Axonkey 接管。'
              : probe.device_hardware_id
                ? 'Windows 已检测到 RC003；设备驱动状态请在设备工作区查看。'
                : 'Windows 已检测到 RC003；按任意键唤醒后即可接管输入。',
        }
        const disconnectedDevice = {
          status: 'disconnected' as const,
          name: undefined,
          hardwareId: undefined,
          message: '未检测到 RC003，请确认蓝牙已配对并按任意键唤醒。',
        }
        const device = probe.rc003_connected ? connectedDevice : disconnectedDevice
        const macPermissionsReady = probe.input_monitoring_granted === true && probe.accessibility_granted === true
        const inputStatus = probe.input_authorization_stale
          ? 'error'
          : !macPermissionsReady
            ? 'missing'
            : probe.input_backend_error
              ? 'error'
              : probe.input_backend_ready
                ? 'installed'
                : 'checking'
        const inputMessage = probe.input_authorization_stale
          ? '当前构建的输入监控授权已失效。请在系统设置中移除旧 Axonkey，重新添加当前 Axonkey.app 并打开开关。'
          : !macPermissionsReady
            ? '需要授予输入监控和辅助功能权限。'
            : probe.input_backend_error
              ? mappingRecovering
                ? 'RC003 硬件按键映射尚未恢复，正在自动重试。'
                : `输入服务异常：${probe.input_backend_error}`
              : probe.capture_active
                ? 'macOS 原生输入服务已接管并拦截 RC003 原始按键。'
                : 'macOS 原生输入服务已就绪。'
        let next =
          probe.platform === 'macos'
            ? setDriverStatus(current, 'input', inputStatus, { message: inputMessage })
            : current
        if (!showChecking) {
          const unchanged =
            next.device.status === device.status &&
            next.device.name === device.name &&
            next.device.hardwareId === device.hardwareId &&
            next.device.message === device.message
          return unchanged ? next : setDeviceConnection(next, device)
        }
        return setDeviceConnection(next, device)
      })
      setSystemProbeState('ready')
      return true
    } catch (error) {
      logError('System probe failed', error)
      if (showChecking) {
        setSystemState(current => {
          return setDeviceConnection(current, { status: 'error', message: String(error) })
        })
      }
      setSystemProbeState('error')
      return false
    } finally {
      systemProbeRunningRef.current = false
    }
  }

  const probeAudioState = async () => {
    if (audioProbeRunningRef.current || typeof window === 'undefined' || !('__TAURI_INTERNALS__' in window)) return
    audioProbeRunningRef.current = true
    // Keep the last result visible during subsequent probes, including polling.
    setSystemState(current =>
      current.drivers.audio.status !== 'unknown'
        ? current
        : setDriverStatus(current, 'audio', 'checking', {
            message:
              platform === 'macos'
                ? '正在检查 MiRemoteV 2ch 与 RC003 语音通道…'
                : '正在检查 Quarbor Virtual Microphone 虚拟麦克风…',
          }),
    )
    try {
      const probe = await withTimeout(invoke<AudioProbe>('probe_audio_state'), 5_000, '检测超时，请点击“重新检测”再试')
      const outputName = platform === 'macos' ? 'MiRemoteV 2ch' : 'Quarbor Virtual Microphone'
      const stateMessage = probe.forwarding
        ? `正在把 RC003 麦克风音频转发到 ${outputName}。`
        : probe.state === 'stopped' && !probe.outputReady
          ? '设备语音服务未启用，当前不会输出声音。'
          : probe.state === 'ready'
            ? `${outputName} 已就绪，RC003 语音通道已连接。`
            : probe.state === 'connecting' || probe.state === 'scanning'
              ? `${outputName} 已就绪，正在连接 RC003 语音通道。`
              : probe.error
                ? `${outputName} 已就绪；语音通道：${probe.error}`
                : `${outputName} 已就绪，按住语音键时会自动开始转发。`
      setSystemState(current =>
        setDriverStatus(current, 'audio', probe.driverInstalled ? 'installed' : 'missing', {
          message: probe.driverInstalled
            ? stateMessage
            : platform === 'macos'
              ? '未检测到 MiRemoteV 2ch 虚拟麦克风驱动。'
              : '未检测到 Quarbor Virtual Microphone 虚拟麦克风驱动。',
        }),
      )
    } catch (error) {
      logError('Audio probe failed', error)
      const detail = error instanceof Error ? error.message : String(error)
      setSystemState(current =>
        setDriverStatus(current, 'audio', 'error', {
          message: `音频检测失败：${detail}。可点击“重新检测”，不影响按键映射。`,
        }),
      )
    } finally {
      audioProbeRunningRef.current = false
    }
  }

  const dismissMicrophoneDriverWarning = async () => {
    try {
      setMicrophoneDriverWarningSuppressed(await invoke<boolean>('dismiss_microphone_driver_warning'))
    } catch (error) {
      logError('Failed to dismiss microphone driver warning', error)
      setToast(`无法关闭提醒：${String(error)}`)
      window.setTimeout(() => setToast(''), 2400)
    }
  }

  useEffect(() => {
    document.body.classList.toggle('permission-helper-mode', permissionHelperKind !== null)
    return () => document.body.classList.remove('permission-helper-mode')
  }, [permissionHelperKind])

  useEffect(() => {
    if (typeof window === 'undefined' || !('__TAURI_INTERNALS__' in window)) return
    const initialTimer = window.setTimeout(() => void probeSystemState(false), 1_200)
    const interval = window.setInterval(() => void probeSystemState(false), 3_000)
    return () => {
      window.clearTimeout(initialTimer)
      window.clearInterval(interval)
    }
  }, [])

  useEffect(() => {
    if (typeof window === 'undefined' || !('__TAURI_INTERNALS__' in window)) return
    const initialTimer = window.setTimeout(() => void probeAudioState(), 1_500)
    const interval = window.setInterval(() => void probeAudioState(), 30_000)
    return () => {
      window.clearTimeout(initialTimer)
      window.clearInterval(interval)
    }
  }, [platform])

  const editingBehavior = editingBehaviorId
    ? (behaviors[selectedBehavior.buttonId][selectedBehavior.trigger].find(
        behavior => behavior.id === editingBehaviorId,
      ) ?? null)
    : null
  const selectedButton =
    [...editableButtons, ...mouseInputs].find(button => button.id === selectedBehavior.buttonId) ?? editableButtons[0]

  const deviceStatus: DeviceStatus = isMouse
    ? {
        title: '鼠标状态',
        rows: [
          {
            label: '输入权限',
            value: !nativeRuntime
              ? '浏览器预览'
              : platform === 'macos'
                ? systemProbeState === 'loading'
                  ? '检测中'
                  : systemProbeState === 'error'
                    ? '检测失败'
                    : macPermissions.inputMonitoring && macPermissions.accessibility && !inputAuthorizationStale
                      ? '已授权'
                      : '待授权'
                : platform === 'windows'
                  ? '无需授权'
                  : '不支持',
            tone:
              nativeRuntime && platform === 'macos'
                ? systemProbeState === 'ready' &&
                  macPermissions.inputMonitoring &&
                  macPermissions.accessibility &&
                  !inputAuthorizationStale
                  ? 'ready'
                  : 'warning'
                : undefined,
          },
        ],
        toggle: { checked: mouseEnabled, onChange: () => setMouseEnabled(value => !value) },
        onOpenSettings: () => setDeviceSettingsOpen(true),
      }
    : {
        title: `${selectedDevice.name}状态`,
        rows: [
          {
            label: '连接',
            value: systemState.device.status === 'connected' ? '已连接' : '未连接',
            tone: systemState.device.status === 'connected' ? 'ready' : undefined,
          },
          { label: '电量', value: <BatteryIndicator level={displayedBatteryLevel} /> },
        ],
        action: {
          label: '查看状态',
          title: inputAuthorizationStale ? '权限失效 · 查看状态' : '查看设备状态',
          onClick: () => {
            if (inputAuthorizationStale) {
              setSettingsSection('permissions')
              navigateToPage('settings')
            } else {
              navigateToPage('home')
            }
          },
        },
      }

  if (permissionHelperKind) {
    const activePermission = !macPermissions.inputMonitoring
      ? 'inputMonitoring'
      : !macPermissions.accessibility
        ? 'accessibility'
        : permissionHelperKind
    return (
      <>
        <MacPermissionHelperWindow
          activePermission={activePermission}
          permissions={macPermissions}
          onOpenSettings={kind => void openSystemSettings(kind)}
          onRevealApp={() => void revealCurrentApp()}
          onRefresh={() => void probeSystemState(false)}
          onClose={() => void closePermissionHelper()}
        />
        {toast && (
          <div className="toast">
            <Check size={15} /> {toast}
          </div>
        )}
      </>
    )
  }

  const MappingPageComponent = mappingStyle === 'flow' ? MappingFlowPage : MappingPage
  const profileControls = (
    <ProfileManager
      profiles={deviceProfiles}
      activeProfileId={activeProfileId}
      onSwitch={switchMappingProfile}
      onCreate={createMappingProfileFromScratch}
      onDuplicate={duplicateMappingProfile}
      onRename={renameMappingProfile}
      onDelete={deleteMappingProfile}
    />
  )
  const DeviceSettingsComponent = deviceSettingsPages[selectedDevice.id]
  const openAudioDriver = () => {
    if (platform === 'windows') {
      setWindowsAudioDriverOpen(true)
      void windowsAudioDriver.probe()
    } else {
      setSettingsSection('permissions')
      navigateToPage('settings')
    }
  }
  const mappingActions = (
    <div className="mapping-context-actions">
      <span role="status" className={`auto-save-state ${autoSaveState}`}>
        {autoSaveState === 'error'
          ? '应用失败'
          : autoSaveState === 'saving'
            ? '保存中'
            : !nativeRuntime
              ? '已保存 · 预览'
              : enabled && (!isMouse || mouseEnabled)
                ? '已保存并生效'
                : '已保存 · 未开启'}
      </span>
      {autoSaveState === 'error' && (
        <button type="button" className="reset-button" onClick={() => setApplyRetry(value => value + 1)}>
          重试
        </button>
      )}
      <MappingOptions
        onImport={openMappingImport}
        onExport={exportMappings}
        onReset={resetMappings}
        audioCalibration={
          selectedDevice.inputKind === 'button'
            ? { disabled: !nativeRuntime, onOpen: openLegacyAudioCalibration }
            : undefined
        }
        flowEditor={mappingStyle === 'flow'}
        onFlowEditorChange={enabled => setMappingStyle(enabled ? 'flow' : 'legacy')}
      />
      <input
        ref={mappingFileInputRef}
        className="mapping-file-input"
        type="file"
        accept=".json,application/json"
        onChange={event => void importMappings(event)}
      />
    </div>
  )

  const appShell = (
    <div className={`app-shell ${activePage === 'mapping' ? 'mapping-active' : ''}`}>
      {nativeRuntime && platform === 'macos' && (
        <div className="native-titlebar" data-tauri-drag-region aria-hidden="true" />
      )}
      <div className="app-main">
        <main ref={mainContentRef} key={activePage} className="main-content">
          {!enabled && (
            <section className="mapping-disabled-notice" aria-labelledby="mapping-disabled-title">
              <Info size={20} aria-hidden="true" />
              <div className="mapping-disabled-copy">
                <strong id="mapping-disabled-title">自定义按键功能未开启</strong>
                <p>可以继续编辑和保存配置，开启后自定义按键才会生效。也可通过设置页左侧的总开关开启。</p>
              </div>
              <button type="button" className="mapping-enable-button" onClick={toggleEnabled}>
                立即开启
              </button>
            </section>
          )}

          {activePage === 'mapping' ? (
            <MappingPageComponent
              onBackToDevices={() => navigateToPage('home')}
              onOpenSettings={() => setDeviceSettingsOpen(true)}
              profileControls={profileControls}
              debugMode={debugMode}
              selectedDeviceId={selectedDeviceId}
              selectBehaviorTarget={selectBehaviorTarget}
              activeId={activeId}
              mappingMainRef={mappingMainRef}
              deviceStatus={deviceStatus}
              isMouse={isMouse}
              selectedBehavior={selectedBehavior}
              adjustPreviewBattery={adjustPreviewBattery}
              editableButtons={editableButtons}
              pressedId={pressedId}
              behaviors={behaviors}
              onWorkflowChange={updateWorkflow}
              onRequestProfileSwitch={requestProfileSwitch}
              platform={platform}
              showRemoteKeyGrid={showRemoteKeyGrid}
              showMouseKeyGrid={showMouseKeyGrid}
              rowRefs={rowRefs}
              toolbar={
                <div className="key-picker-actions">
                  <div className="behavior-history-actions" role="group" aria-label="行为编辑历史">
                    <button
                      type="button"
                      className="behavior-history-button"
                      title="撤销"
                      aria-label="撤销行为更改"
                      disabled={!canUndoBehavior}
                      onClick={undoBehaviorChange}
                    >
                      <UndoCircle size={15} weight="Outline" />
                    </button>
                    <button
                      type="button"
                      className="behavior-history-button"
                      title="重做"
                      aria-label="重做行为更改"
                      disabled={!canRedoBehavior}
                      onClick={redoBehaviorChange}
                    >
                      <RedoCircle size={15} weight="Outline" />
                    </button>
                  </div>
                  {mappingActions}
                </div>
              }
              behaviorEditorProps={{
                editorRef: behaviorEditorRef,
                attention: behaviorEditorAttention,
                platform,
                button: selectedButton,
                trigger: selectedBehavior.trigger,
                behaviors: behaviors[selectedBehavior.buttonId][selectedBehavior.trigger],
                onApplyCommonBehavior: applyCommonBehavior,
                onAddAdvancedBehavior: type => beginBehaviorDraft(type, 'append'),
                onRemoveBehavior: removeBehavior,
                onMoveBehavior: moveSelectedBehavior,
                onEditBehavior: setEditingBehaviorId,
                onReturnToMappings: returnToSelectedMapping,
                onCopySequence: () => void copySelectedSequence(),
                onPasteSequence: () => setSequencePasteOpen(true),
                onClearSequence: () => {
                  const current = profileStateRef.current.behaviors[selectedBehavior.buttonId]
                  if (
                    updateWorkflow(selectedBehavior.buttonId, { ...current, [selectedBehavior.trigger]: [] }) === false
                  )
                    return
                  clearBehaviorEditingState()
                  showBehaviorToast('当前序列已清除')
                },
              }}
              remoteView={selectedDevice.remoteView}
            />
          ) : activePage === 'settings' ? (
            <SettingsPage
              cloudContent={
                <CloudSyncSettings
                  cloud={cloud}
                  instances={deviceInstances.snapshot.store.instances}
                  platform={platform}
                />
              }
              localDataResetContent={<LocalDataResetSettings cloud={cloud} />}
              aboutContent={<AboutPage update={releaseUpdate} />}
              onOpenConfigMigration={onOpenConfigMigration}
              onOpenUserGuide={userGuide.show}
              onOpenDevtools={openDevtools}
              debugMode={debugMode}
              onOpenDriverMigration={() => setDriverMigrationOpen(true)}
              onOpenLegacyCleanup={() => setLegacyCleanupOpen(true)}
              onOpenWindowsAudioDriver={openAudioDriver}
              onOpenVirtualAudioUpgrade={() => setVirtualAudioUpgradeOpen(true)}
              onBack={() => navigateToPage('home')}
              enabled={enabled}
              onToggleEnabled={toggleEnabled}
              backup={{
                onCreateBackup: createBackup,
                onRestoreBackup: restoreDataBackup,
                onImportLegacyConfig,
              }}
              onOpenSignalMonitor={() => void openSignalMonitor()}
              signalMonitorOpening={signalMonitorOpening}
              signalMonitorError={signalMonitorError}
              stretchCompensation={stretchCompensation}
              stretchError={stretchError}
              stretchUpdating={stretchUpdating}
              onStretchCompensationChange={updateStretchCompensation}
              section={settingsSection}
              onSectionChange={setSettingsSection}
              showRemoteKeyGrid={showRemoteKeyGrid}
              onShowRemoteKeyGridChange={setShowRemoteKeyGrid}
              showRecordingOverlay={showRecordingOverlay}
              onShowRecordingOverlayChange={setShowRecordingOverlay}
              platform={platform}
              nativeRuntime={nativeRuntime}
              systemProbeState={systemProbeState}
              permissions={macPermissions}
              inputAuthorizationStale={inputAuthorizationStale}
              inputDriver={systemState.drivers.input}
              onRequestPermission={kind => void requestMacPermission(kind)}
              onOpenSettings={kind => void openSystemSettings(kind)}
              onRefresh={() => void probeSystemState(false)}
              audioDriver={systemState.drivers.audio}
              onAudioAction={action => void runDriverAction('audio', action)}
              audioRestarting={audioRestarting}
              audioRestartError={audioRestartError}
              onRestartAudio={() => void restartAudio().then(() => probeAudioState())}
              onProbeAudio={() => void probeAudioState()}
              onOpenSound={() => void openSystemSettings('sound')}
              onOpenManagedDriverCleanup={() => setManagedDriverCleanupOpen(true)}
            />
          ) : (
            <HomeDashboard
              microphoneDriverAbnormal={microphoneDriverAbnormal}
              microphoneDriverWarningSuppressed={microphoneDriverWarningSuppressed}
              onDismissMicrophoneDriverWarning={dismissMicrophoneDriverWarning}
              onOpenAudioDriver={openAudioDriver}
              deviceContent={
                <DeviceHub
                  selectedInstanceId={selectedInstanceId}
                  bindInstanceId={pendingBindingId}
                  onBindingOpened={() => setPendingBindingId(null)}
                  onSelectInstance={setSelectedInstanceId}
                  onOpenAudioDriver={openAudioDriver}
                  onOpenBluetoothSettings={() => void openSystemSettings('bluetooth')}
                  onOpenDeviceManager={() => void openSystemSettings('deviceManager')}
                  controller={deviceInstances}
                  onBrandClick={handleBrandClick}
                  native={nativeRuntime}
                  platform={platform}
                  permissions={macPermissions}
                  mouseProfileName={profiles.find(profile => profile.id === activeProfileIds.mouse)?.name ?? '默认配置'}
                  onPermissions={() => {
                    setSettingsSection('permissions')
                    navigateToPage('settings')
                  }}
                  onOpenAudioCalibration={openInstanceAudioCalibration}
                  driverAction={managedDriverAction}
                  onInstallDriver={instanceId => void installManagedDriver(instanceId)}
                  onUnbindDevice={unbindManagedInstance}
                  onRemoveDevice={removeManagedInstance}
                  onLegacy={deviceId => {
                    setSelectedDeviceId(deviceId)
                    const device = devices.find(d => d.id === deviceId)!
                    selectBehaviorTarget(device.inputIds[0], 'click', false)
                    navigateToPage('mapping')
                  }}
                />
              }
              nativeRuntime={nativeRuntime}
              onOpenSettings={() => navigateToPage('settings')}
              onOpenCloud={() => {
                setSettingsSection('cloud')
                navigateToPage('settings')
              }}
              onOpenLogs={() => void openLogDirectory()}
              onOpenAbout={() => {
                setSettingsSection('about')
                navigateToPage('settings')
              }}
              hasUpdate={releaseUpdate.hasUpdate}
            />
          )}
        </main>
      </div>
      {toast && (
        <div className="toast">
          <Check size={15} /> {toast}
        </div>
      )}
      {pendingProfileSwitch &&
        createPortal(
          <ProfileSwitchConfirmDialog
            key={pendingProfileSwitch.behavior.id}
            button={[...editableButtons, ...mouseInputs].find(button => button.id === pendingProfileSwitch.inputId)!}
            trigger={pendingProfileSwitch.trigger}
            behavior={pendingProfileSwitch.behavior}
            targets={profileSwitchTargets(
              { profiles, activeProfileIds, behaviors },
              pendingProfileSwitch.inputId,
              pendingProfileSwitch.trigger,
            )}
            activeProfileId={activeProfileIds[deviceForInput(pendingProfileSwitch.inputId).id]}
            platform={platform}
            onCancel={() => setPendingProfileSwitch(null)}
            onConfirm={behavior => {
              const next = applySharedProfileSwitch(
                profileStateRef.current,
                pendingProfileSwitch.inputId,
                pendingProfileSwitch.trigger,
                behavior,
              )
              profileStateRef.current = next
              setProfiles(next.profiles)
              dispatchBehaviorHistory({ type: 'replace', present: next.behaviors })
              setPendingProfileSwitch(null)
              setAutoSaveState('saving')
              setToast('已应用到此设备的所有配置文件')
              window.setTimeout(() => setToast(''), 2200)
            }}
          />,
          document.body,
        )}
      {pendingProfileSwitchDeletion &&
        createPortal(
          <ProfileSwitchDeleteDialog
            button={[...editableButtons, ...mouseInputs].find(
              button => button.id === pendingProfileSwitchDeletion.inputId,
            )!}
            targets={pendingProfileSwitchDeletion.triggers.map(trigger => ({
              trigger,
              profiles: profileSwitchTargets(
                { profiles, activeProfileIds, behaviors },
                pendingProfileSwitchDeletion.inputId,
                trigger,
              ).filter(profile => profile.behaviors.some(behavior => behavior.type === 'switchProfile')),
            }))}
            onCancel={() => setPendingProfileSwitchDeletion(null)}
            onConfirm={() => {
              const next = removeSharedProfileSwitch(profileStateRef.current, pendingProfileSwitchDeletion)
              profileStateRef.current = next
              setProfiles(next.profiles)
              dispatchBehaviorHistory({ type: 'replace', present: next.behaviors })
              setPendingProfileSwitchDeletion(null)
              setAutoSaveState('saving')
              setToast('已同步删除切换配置文件行为')
              window.setTimeout(() => setToast(''), 2200)
            }}
          />,
          document.body,
        )}
      {pendingProfileImport && (
        <ProfileImportDialog
          deviceId={pendingProfileImport.deviceId}
          fileName={pendingProfileImport.fileName}
          suggestedName={pendingProfileImport.suggestedName}
          behaviors={pendingProfileImport.behaviors}
          platform={platform}
          enabled={pendingProfileImport.enabled}
          onCancel={() => setPendingProfileImport(null)}
          onSave={saveImportedProfile}
        />
      )}
      {deviceSettingsOpen && (
        <DeviceSettingsDrawer deviceName={selectedDevice.name} onClose={() => setDeviceSettingsOpen(false)}>
          <DeviceSettingsComponent
            onOpenAudioDriver={openAudioDriver}
            cmiotA15RecordingMode={cmiotA15RecordingMode}
            onCmiotA15RecordingModeChange={setCmiotA15RecordingMode}
            showMouseKeyGrid={showMouseKeyGrid}
            onShowMouseKeyGridChange={setShowMouseKeyGrid}
            mouseIgnoreScrollAcceleration={mouseIgnoreScrollAcceleration}
            onMouseIgnoreScrollAccelerationChange={setMouseIgnoreScrollAcceleration}
            mouseScrollSensitivity={mouseScrollSensitivity}
            onMouseScrollSensitivityChange={setMouseScrollSensitivity}
            mouseVerticalScrollIntervalMs={mouseVerticalScrollIntervalMs}
            onMouseVerticalScrollIntervalMsChange={setMouseVerticalScrollIntervalMs}
            mouseHorizontalScrollIntervalMs={mouseHorizontalScrollIntervalMs}
            onMouseHorizontalScrollIntervalMsChange={setMouseHorizontalScrollIntervalMs}
            mouseEdgeWidth={mouseEdgeWidth}
            onMouseEdgeWidthChange={setMouseEdgeWidth}
            mouseKeyHoldMs={mouseKeyHoldMs}
            onMouseKeyHoldMsChange={setMouseKeyHoldMs}
          />
        </DeviceSettingsDrawer>
      )}
      {editingBehavior && (
        <BehaviorEditDialog
          platform={platform}
          button={selectedButton}
          trigger={selectedBehavior.trigger}
          behavior={editingBehavior}
          capturing={capturingBehaviorId === editingBehavior.id}
          onStartCapture={() => setCapturingBehaviorId(editingBehavior.id)}
          onCancelCapture={() => setCapturingBehaviorId(null)}
          onCaptureKey={captureBehaviorKey}
          onUpdate={update => updateBehavior(editingBehavior.id, update)}
          onClose={() => {
            setEditingBehaviorId(null)
            setCapturingBehaviorId(null)
          }}
        />
      )}
      {draftBehavior && (
        <BehaviorEditDialog
          platform={platform}
          button={selectedButton}
          trigger={selectedBehavior.trigger}
          behavior={draftBehavior.behavior}
          capturing={capturingBehaviorId === draftBehavior.behavior.id}
          draft
          onStartCapture={() => setCapturingBehaviorId(draftBehavior.behavior.id)}
          onCancelCapture={() => setCapturingBehaviorId(null)}
          onCaptureKey={captureDraftBehaviorKey}
          onUpdate={update =>
            setDraftBehavior(current => (current ? { ...current, behavior: update(current.behavior) } : null))
          }
          onClose={() => {
            setDraftBehavior(null)
            setCapturingBehaviorId(null)
          }}
          onSave={() => commitDraftBehavior()}
        />
      )}
      {sequencePasteOpen && (
        <SequencePasteDialog
          platform={platform}
          button={selectedButton}
          trigger={selectedBehavior.trigger}
          onClose={() => setSequencePasteOpen(false)}
          onApply={sequence => {
            replaceWithCommonBehavior(sequence)
            setSequencePasteOpen(false)
            showBehaviorToast('当前序列已替换')
          }}
        />
      )}
      {textInputDraft !== null && (
        <TextInputPresetDialog
          button={selectedButton}
          trigger={selectedBehavior.trigger}
          value={textInputDraft}
          onChange={setTextInputDraft}
          onClose={() => setTextInputDraft(null)}
          onSave={commitTextInputPreset}
        />
      )}
      {audioTestOpen && (
        <AudioTestDialog
          platform={platform}
          nativeRuntime={nativeRuntime}
          instanceId={audioTestInstanceId ?? undefined}
          audioGain={audioTestInstanceId ? audioTestInstanceGain : audioGain}
          gainError={gainError}
          onAudioGainChange={audioTestInstanceId ? updateInstanceAudioGain : updateAudioGain}
          onClose={() => {
            setAudioTestOpen(false)
            setAudioTestInstanceId(null)
          }}
        />
      )}
      {driverMigrationOpen && platform === 'windows' && (
        <DriverMigrationFlow onComplete={() => setDriverMigrationOpen(false)} />
      )}
      {virtualAudioUpgradeOpen && platform === 'windows' && (
        <VirtualAudioUpgradeDialog manual onContinue={() => setVirtualAudioUpgradeOpen(false)} />
      )}
      {userGuide.open && (
        <UserGuideDialog
          saving={userGuide.saving}
          error={userGuide.error}
          deviceDiscovery={{
            controller: deviceInstances,
            native: nativeRuntime,
            platform,
            permissions: macPermissions,
            onPermissions: () => {
              setSettingsSection('permissions')
              navigateToPage('settings')
            },
            onOpenBluetoothSettings: () => void openSystemSettings('bluetooth'),
            onOpenDeviceManager: () => void openSystemSettings('deviceManager'),
          }}
          windowsAudioDriver={windowsAudioDriver}
          nativeRuntime={nativeRuntime}
          onOpenSound={() => void openSystemSettings('sound')}
          onComplete={async instanceId => {
            if (await userGuide.complete()) {
              navigateToPage('home')
              setSelectedInstanceId(instanceId)
            }
          }}
        />
      )}
      {windowsAudioDriverOpen && platform === 'windows' && (
        <WindowsAudioDriverDialog
          controller={windowsAudioDriver}
          nativeRuntime={nativeRuntime}
          onOpenSound={() => void openSystemSettings('sound')}
          onClose={() => setWindowsAudioDriverOpen(false)}
        />
      )}
      {managedDriverCleanupOpen && platform === 'windows' && (
        <ManagedDriverCleanupDialog
          onClose={() => setManagedDriverCleanupOpen(false)}
          onDevicesChanged={() => void deviceInstances.refresh()}
        />
      )}
      {legacyCleanupOpen && platform === 'windows' && (
        <LegacyCleanupFlow onComplete={() => setLegacyCleanupOpen(false)} />
      )}
    </div>
  )
  return (
    <BehaviorLibraryContext.Provider
      value={{
        client: cloud.client,
        userId: cloud.user?.id ?? null,
        accountReady: cloud.accountReady,
        onLogin: () => {
          setSettingsSection('cloud')
          navigateToPage('settings')
        },
      }}
    >
      {appShell}
    </BehaviorLibraryContext.Provider>
  )
}

export default AppController
