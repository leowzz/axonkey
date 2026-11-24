import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore, type CSSProperties } from 'react'
import { createPortal } from 'react-dom'
import { invoke } from '@tauri-apps/api/core'
import { listen } from '@tauri-apps/api/event'
import { ChevronDown, Info, RefreshCw, Settings2, TriangleAlert } from 'lucide-react'
import type { QuickOverlayEditorContext } from '../../components/BehaviorEditor'
import { QuickOverlayConfigurator } from '../../components/QuickOverlayConfigurator'
import { BehaviorHistoryActions } from '../../components/BehaviorHistoryActions'
import { BehaviorSummaryPopover } from '../../components/BehaviorSummaryPopover'
import { iconFor } from '../../components/InputIcon'
import type { MacPermissions, ManagedDriverAction, MappingEditorStyle, MappingInput, Platform } from '../../appTypes'
import type {
  ButtonId,
  ClipboardOverlayAction,
  SanitizedProfileBehaviors,
  SwitchProfileBehavior,
  TriggerBehaviors,
  TriggerType,
} from '../../behaviorModel'
import { inspectBehaviorMapWarnings, sanitizeProfileBehaviors, triggerTypes } from '../../behaviorModel'
import { idleVoiceBarLevels, nextVoiceAmplitudeBars, type gainLevelTone } from '../../audioGain'
import { getStoredDeviceInput, storeDeviceInput } from '../../deviceInputSelection'
import { removedProfileSwitchTriggers } from '../../profileNavigation'
import { RemoteControl } from '../shared/RemoteControl'
import { ApplicationProfileToolbar } from '../../components/ApplicationProfileToolbar'
import { useForegroundApplications } from '../../useForegroundApplications'
import { setApplicationProfile } from './applicationProfiles'
import { buildRailOverviewItems, railKeyGlyphText, shouldOpenRailSummaryPopover } from './railOverview'
import { ProfileSwitchConfirmDialog } from '../../components/ProfileSwitchConfirmDialog'
import { ProfileSwitchDeleteDialog } from '../../components/ProfileSwitchDeleteDialog'
import { PresetProfileDialog } from '../../components/PresetProfileDialog'
import { SettingsHelp } from '../../components/SettingsHelp'
import { BatteryIndicator } from '../../components/BatteryIndicator'
import type { CatalogDeviceModel } from '../../cloud/deviceModelCatalog'
import {
  clonePresetBehaviors,
  getPresetsForDevice,
  materializePresetToProfile,
  pickDefaultPreset,
  type DevicePresetOption,
} from '../bundledPresets.ts'
import { DeviceRecordingStatus } from '../../components/DeviceRail'
import { reportTencentEvent } from '../../telemetry'
import { recordLibraryAdditions } from '../../cloud/libraryUsage'
import { defaultWorkflowSplitRatio } from '../../components/workflowSplitLayout'
import { WorkflowAxonkey } from '../../components/WorkflowAxonkey'
import { LegacyMappingEditor } from '../../components/LegacyMappingEditor'
import { MappingColumnSplitter } from '../../components/MappingColumnSplitter'
import { useMappingPanelWidths } from '../../components/mappingPanelLayout'
import { DeviceSettingsDrawer } from '../shared/DeviceSettingsDrawer'
import { DeviceWorkspaceHeader, type WorkspaceDeviceOption } from '../shared/DeviceWorkspaceHeader'
import { KivoScreenEditor } from '../kivo-k18-lite/KivoScreenEditor'
import { DeviceBindingPicker } from './IntegrationControls'
import {
  defaultRecordingMode,
  deviceMatchesKind,
  deviceScreenSelectionId,
  emptyTriggers,
  getLocalCloudDescriptorOverrides,
  getSupportPackages,
  instanceState,
  localCloudOverrideWarningText,
  packageFor,
  stateLabel,
  subscribeSupportPackages,
  supportsWindowsDriver,
  supportsDeviceInformation,
  usesHidVoice,
  usesSingleLaneWorkspace,
} from './model'
import type { DeviceInstance, DiscoveredDevice } from './model'
import type { DeviceController } from './useDeviceInstances'
import {
  addInstanceProfile,
  addQuickInstanceProfile,
  bindQuickOverlayTrigger,
  deleteInstanceProfile,
  applyInstanceProfileSwitch,
  createInstanceBehaviorHistory,
  findQuickOverlayTriggerBinding,
  hasExistingNonQuickBehavior,
  instanceBehaviorHistoryReducer,
  mergeEditedProfileBehaviors,
  removeInstanceProfileSwitch,
  replaceInstanceProfileBehaviors,
} from './instanceProfiles'
import type { InstanceBehaviorHistoryAction, InstanceProfileBehaviors } from './instanceProfiles'

function countConfiguredInputs(behaviors: InstanceProfileBehaviors, quick?: boolean): number {
  return Object.values(behaviors).filter(sequences =>
    (quick ? (['click'] as const) : triggerTypes).some(
      trigger => (sequences?.[trigger]?.filter(step => step.enabled).length ?? 0) > 0,
    ),
  ).length
}

type Props = {
  mappingStyle: MappingEditorStyle
  instance: DeviceInstance
  controller: DeviceController
  native: boolean
  platform: Platform
  permissions: MacPermissions
  onPermissions: () => void
  onBack: () => void
  onBind: () => void
  onUnbindDevice: (instanceId: string) => Promise<void>
  onRemoveDevice: (instanceId: string) => Promise<void>
  onOpenAudioCalibration: (instanceId: string) => void
  onOpenAudioDriver: () => void
  driverAction: ManagedDriverAction | null
  onInstallDriver: (instanceId: string) => void
  batteryLevel: number | null
  onToast?: (message: string) => void
  catalogModel?: CatalogDeviceModel | null
  deviceOptions?: WorkspaceDeviceOption[]
  onSelectDevice?: (id: string) => void
}
export function InstanceWorkspace({
  mappingStyle,
  instance,
  controller,
  native,
  platform,
  permissions,
  onPermissions,
  onBack,
  onBind,
  onUnbindDevice,
  onRemoveDevice,
  onOpenAudioCalibration,
  onOpenAudioDriver,
  onInstallDriver,
  driverAction,
  batteryLevel,
  onToast,
  catalogModel,
  deviceOptions,
  onSelectDevice,
}: Props) {
  useSyncExternalStore(subscribeSupportPackages, getSupportPackages, getSupportPackages)
  const pkg = packageFor(instance.kind)
  const panelLayout = useMappingPanelWidths(instance.id)
  const localCloudOverride = getLocalCloudDescriptorOverrides().find(item => item.kind === instance.kind)
  const singleLaneWorkspace = usesSingleLaneWorkspace(instance.kind)
  const voice = pkg.remoteView?.voice
  const voiceModes = voice?.triggerModes ?? []
  const analogInputs = pkg.remoteView?.buttons.filter(button => button.kind === 'trigger') ?? []
  const [splitRatio, setSplitRatio] = useState(defaultWorkflowSplitRatio)
  const MappingEditor = mappingStyle === 'legacy' ? LegacyMappingEditor : WorkflowAxonkey
  const [railMode, setRailMode] = useState<'diagram' | 'list'>('diagram')
  const [selected, setSelected] = useState<string>(() =>
    getStoredDeviceInput(instance.id, [
      ...pkg.inputs.map(input => input.id),
      ...(pkg.screenRegion ? [deviceScreenSelectionId] : []),
    ]),
  )
  const isScreenSelected = Boolean(pkg.screenRegion && selected === deviceScreenSelectionId)
  useEffect(() => {
    if (isScreenSelected) return
    if (pkg.inputs.length > 0 && !pkg.inputs.some(input => input.id === selected)) {
      setSelected(
        getStoredDeviceInput(instance.id, [
          ...pkg.inputs.map(input => input.id),
          ...(pkg.screenRegion ? [deviceScreenSelectionId] : []),
        ]),
      )
    }
  }, [instance.id, isScreenSelected, pkg.inputs, pkg.screenRegion, selected])
  const selectInput = (inputId: string) => {
    setSelected(inputId)
    storeDeviceInput(instance.id, inputId)
  }
  const [settings, setSettings] = useState(false)
  const [editingApplicationId, setEditingApplicationId] = useState('')
  const applications = useForegroundApplications(native)
  const [recordingPending, setRecordingPending] = useState(false)
  const workspaceRef = useRef<HTMLDivElement>(null)
  const [settingsSection, setSettingsSection] = useState<'overview' | 'information'>('overview')
  const [confirmRemove, setConfirmRemove] = useState(false)
  const [pendingPhysicalAction, setPendingPhysicalAction] = useState<'unbind' | 'remove' | null>(null)
  const [toolboxCategory, setToolboxCategory] = useState('all')
  const [pendingSwitch, setPendingSwitch] = useState<{
    inputId: string
    trigger: TriggerType
    behavior: SwitchProfileBehavior
    additionItemId?: string
  } | null>(null)
  const [pendingDeletion, setPendingDeletion] = useState<{
    profileId: string
    inputId: string
    triggers: TriggerType[]
    sequences: TriggerBehaviors
  } | null>(null)
  const [input, setInput] = useState<{ pressed: string[]; values: Record<string, number> }>({ pressed: [], values: {} })
  const recordingRef = useRef({ instanceId: instance.id, recording: false })
  const [editingQuickProfileId, setEditingQuickProfileId] = useState<string | null>(null)
  const [presetDialogOpen, setPresetDialogOpen] = useState(false)
  useEffect(() => {
    setEditingQuickProfileId(null)
    setPresetDialogOpen(false)
  }, [instance.id])
  const devicePresets = useMemo(
    () => getPresetsForDevice(instance.kind, catalogModel, platform),
    [catalogModel, instance.kind, platform],
  )
  const defaultPreset = useMemo(() => pickDefaultPreset(devicePresets), [devicePresets])
  useEffect(() => {
    if (editingQuickProfileId && !instance.profiles.some(item => item.id === editingQuickProfileId)) {
      setEditingQuickProfileId(null)
    }
  }, [editingQuickProfileId, instance.profiles])
  const applicationProfile = instance.applicationProfiles?.find(
    binding => binding.application.id === editingApplicationId,
  )
  const permanentProfile =
    instance.profiles.find(p => !p.quick && p.id === (applicationProfile?.profileId ?? instance.activeProfileId)) ??
    instance.profiles.find(p => !p.quick) ??
    instance.profiles[0]
  const editingProfileOverride = editingQuickProfileId
    ? (instance.profiles.find(p => p.id === editingQuickProfileId) ?? null)
    : null
  const profile = editingProfileOverride ?? permanentProfile
  const selectedInput: MappingInput<string> = pkg.inputs.find(i => i.id === selected) ??
    pkg.inputs[0] ?? {
      id: selected || 'pending',
      label: pkg.name,
      short: '—',
      icon: 'center',
    }
  const sonyMicSelected = instance.kind === 'rmfTx800c' && selectedInput.id === 'rmf-tx800c.voice'
  const status = controller.snapshot.runtime[instance.id]
  const recording = native && !!status?.recording
  const { bars: voiceAmplitudes, tone: voiceTone } = useVoiceAmplitude(
    native && Boolean(voice),
    instance.id,
    recording,
    instance.audioGainDb ?? 0,
  )
  const boundDevice = instance.binding
    ? controller.snapshot.discovered.find(device => device.id === instance.binding)
    : undefined
  const [informationRefreshRemaining, setInformationRefreshRemaining] = useState(0)
  const informationRefreshLocked = informationRefreshRemaining > 0
  const informationAvailable = !!boundDevice?.connected && boundDevice.identityQuality !== 'ambiguous'
  const refreshInformation = controller.refreshInformation
  useEffect(() => {
    if (settings && settingsSection === 'information' && native && informationAvailable && instance.binding) {
      void refreshInformation(instance.binding).catch(() => {})
    }
  }, [settings, settingsSection, native, informationAvailable, instance.binding, refreshInformation])
  useEffect(() => {
    if (!informationRefreshLocked) return
    const timer = setInterval(() => setInformationRefreshRemaining(seconds => Math.max(0, seconds - 1)), 1000)
    return () => clearInterval(timer)
  }, [informationRefreshLocked])
  useEffect(() => {
    const recording = status?.recording === true
    const previous = recordingRef.current
    if (previous.instanceId === instance.id && recording && !previous.recording)
      reportTencentEvent('voice_recording_start')
    recordingRef.current = { instanceId: instance.id, recording }
  }, [instance.id, status?.recording])
  const availableDevices = controller.snapshot.discovered.filter(
    device =>
      deviceMatchesKind(device, instance.kind) &&
      !controller.snapshot.store.instances.some(item => item.id !== instance.id && item.binding === device.id),
  )
  const update = (change: (item: DeviceInstance) => DeviceInstance) => {
    void controller.update(instance.id, change).catch(() => {})
  }
  const toggleRecording = async () => {
    setRecordingPending(true)
    try {
      await controller.toggleRecording(instance.id)
    } catch {
      // The controller exposes HID errors through the device hub banner.
    } finally {
      setRecordingPending(false)
    }
  }
  const unbindDevice = () => {
    setPendingPhysicalAction('unbind')
    void onUnbindDevice(instance.id)
      .catch(() => {})
      .finally(() => setPendingPhysicalAction(null))
  }
  const removeDevice = () => {
    setPendingPhysicalAction('remove')
    void onRemoveDevice(instance.id)
      .then(onBack)
      .catch(() => {})
      .finally(() => setPendingPhysicalAction(null))
  }
  useEffect(() => {
    if (!native) return
    let alive = true
    const listener = listen<{ instanceId: string; pressed: string[]; values: Record<string, number> }>(
      'axonkey-device-input',
      event => {
        if (alive && event.payload.instanceId === instance.id) setInput(event.payload)
      },
    )
    return () => {
      alive = false
      void listener.then(unlisten => unlisten())
    }
  }, [native, instance.id])
  useEffect(() => {
    setInput({ pressed: [], values: {} })
  }, [instance.enabled, profile.id, status?.state])
  const validProfileIds = useMemo(() => new Set(instance.profiles.map(item => item.id)), [instance.profiles])
  const sanitizedProfiles = useMemo(
    () => new Map(instance.profiles.map(item => [item.id, sanitizeProfileBehaviors(item.behaviors, validProfileIds)])),
    [instance.profiles, validProfileIds],
  )
  const currentSanitized = useMemo(
    () => sanitizedProfiles.get(profile.id) ?? sanitizeProfileBehaviors(profile.behaviors, validProfileIds),
    [profile.behaviors, profile.id, sanitizedProfiles, validProfileIds],
  )
  const [cleanedInputs, setCleanedInputs] = useState<string[]>([])
  const cleanedInputsRef = useRef<Set<string>>(new Set())
  useEffect(() => {
    cleanedInputsRef.current = new Set()
    setCleanedInputs([])
  }, [instance.id, profile.id])
  const [history, setHistory] = useState(() => createInstanceBehaviorHistory(profile.id, currentSanitized.behaviors))
  const historyRef = useRef(history)
  historyRef.current = history
  const pendingSavesRef = useRef(0)
  const applyHistoryAction = useCallback((action: InstanceBehaviorHistoryAction) => {
    const current = historyRef.current
    const next = instanceBehaviorHistoryReducer(current, action)
    if (next === current) return null
    historyRef.current = next
    setHistory(next)
    return next
  }, [])
  useEffect(() => {
    if (profile.id !== historyRef.current.profileId) {
      applyHistoryAction({ type: 'replace', profileId: profile.id, present: currentSanitized.behaviors })
      return
    }
    if (pendingSavesRef.current === 0) {
      applyHistoryAction({ type: 'sync', profileId: profile.id, present: currentSanitized.behaviors })
    }
  }, [applyHistoryAction, currentSanitized.behaviors, profile.id])
  const saveProfileBehaviors = useCallback(
    (profileId: string, behaviors: InstanceProfileBehaviors) => {
      pendingSavesRef.current += 1
      void controller
        .update(instance.id, item => {
          const target = item.profiles.find(p => p.id === profileId)
          const ids = new Set(item.profiles.map(p => p.id))
          const sanitizedTarget = sanitizeProfileBehaviors(target?.behaviors, ids)
          const merged = mergeEditedProfileBehaviors(
            target?.behaviors,
            sanitizedTarget.behaviors,
            behaviors,
            sanitizedTarget.droppedInputIds,
            cleanedInputsRef.current,
          )
          return replaceInstanceProfileBehaviors(item, profileId, merged)
        })
        .catch(() => {})
        .finally(() => {
          pendingSavesRef.current = Math.max(0, pendingSavesRef.current - 1)
        })
    },
    [controller, instance.id],
  )
  const applyPresetAsNew = (preset: DevicePresetOption) => {
    const nextProfile = materializePresetToProfile(preset, {
      existingNames: instance.profiles.map(item => item.name),
    })
    setPresetDialogOpen(false)
    pendingSavesRef.current += 1
    void controller
      .update(instance.id, item => {
        const added = { ...item, profiles: [...item.profiles, nextProfile] }
        if (nextProfile.quick) return added
        return applicationProfile
          ? setApplicationProfile(added, applicationProfile.application, nextProfile.id)
          : { ...added, activeProfileId: nextProfile.id }
      })
      .then(() => {
        if (nextProfile.quick) {
          setEditingQuickProfileId(nextProfile.id)
        } else {
          setEditingQuickProfileId(null)
        }
        onToast?.(`已复制预制配置「${nextProfile.name}」`)
      })
      .catch(() => {})
      .finally(() => {
        pendingSavesRef.current = Math.max(0, pendingSavesRef.current - 1)
      })
  }
  const applyPresetToCurrent = (preset: DevicePresetOption) => {
    const freshBehaviors = clonePresetBehaviors(preset.behaviors, true)
    setPresetDialogOpen(false)
    applyHistoryAction({ type: 'replace', profileId: profile.id, present: freshBehaviors })
    pendingSavesRef.current += 1
    void controller
      .update(instance.id, item => {
        const replaced = replaceInstanceProfileBehaviors(item, profile.id, freshBehaviors)
        if (!preset.display) return replaced
        return {
          ...replaced,
          profiles: replaced.profiles.map(entry =>
            entry.id === profile.id ? { ...entry, display: { ...preset.display! } } : entry,
          ),
        }
      })
      .then(() => {
        onToast?.(`已套用预制配置「${preset.name}」`)
      })
      .catch(() => {})
      .finally(() => {
        pendingSavesRef.current = Math.max(0, pendingSavesRef.current - 1)
      })
  }
  const activeBehaviors = history.profileId === profile.id ? history.present : currentSanitized.behaviors
  const inputWarnings = useMemo(() => {
    const cleanedSet = new Set(cleanedInputs)
    const warnings = inspectBehaviorMapWarnings(
      activeBehaviors,
      pkg.inputs.map(item => item.id),
      validProfileIds,
    )
    const appendWarning = (inputId: string, reason: string) => {
      if (!warnings[inputId]) warnings[inputId] = reason
      else if (!warnings[inputId].includes(reason)) warnings[inputId] = `${warnings[inputId]}；${reason}`
    }
    const isUnchangedFromDisk = (inputId: string) =>
      !cleanedSet.has(inputId) &&
      JSON.stringify(activeBehaviors[inputId] ?? emptyTriggers()) ===
        JSON.stringify(currentSanitized.behaviors[inputId] ?? emptyTriggers())

    for (const [inputId, reason] of Object.entries(currentSanitized.warnings)) {
      if (isUnchangedFromDisk(inputId)) appendWarning(inputId, reason)
    }
    const runtimeProfileErrors = status?.mappingErrors?.[profile.id]
    if (runtimeProfileErrors) {
      for (const [inputId, reason] of Object.entries(runtimeProfileErrors)) {
        if (isUnchangedFromDisk(inputId)) appendWarning(inputId, reason)
      }
    }
    return warnings
  }, [
    activeBehaviors,
    cleanedInputs,
    currentSanitized.behaviors,
    currentSanitized.warnings,
    pkg.inputs,
    profile.id,
    status?.mappingErrors,
    validProfileIds,
  ])
  const selectedHasDroppedItems =
    currentSanitized.droppedInputIds.has(selected) &&
    !cleanedInputs.includes(selected) &&
    JSON.stringify(activeBehaviors[selected] ?? emptyTriggers()) ===
      JSON.stringify(currentSanitized.behaviors[selected] ?? emptyTriggers())
  const canUndo = history.profileId === profile.id && history.past.length > 0
  const canRedo = history.profileId === profile.id && history.future.length > 0
  const cleanInvalidInput = useCallback(
    (inputId: string) => {
      cleanedInputsRef.current.add(inputId)
      setCleanedInputs(prev => (prev.includes(inputId) ? prev : [...prev, inputId]))
      saveProfileBehaviors(profile.id, activeBehaviors)
      onToast?.('已清理无效映射项')
    },
    [activeBehaviors, onToast, profile.id, saveProfileBehaviors],
  )
  const undoBehaviorChange = useCallback(() => {
    if (historyRef.current.profileId !== profile.id) return
    const next = applyHistoryAction({ type: 'undo' })
    if (!next) return
    saveProfileBehaviors(profile.id, next.present)
    onToast?.('已撤销行为更改')
  }, [applyHistoryAction, onToast, profile.id, saveProfileBehaviors])
  const redoBehaviorChange = useCallback(() => {
    if (historyRef.current.profileId !== profile.id) return
    const next = applyHistoryAction({ type: 'redo' })
    if (!next) return
    saveProfileBehaviors(profile.id, next.present)
    onToast?.('已重做行为更改')
  }, [applyHistoryAction, onToast, profile.id, saveProfileBehaviors])
  const changeSequence = (id: string, sequences: TriggerBehaviors) => {
    if (historyRef.current.profileId !== profile.id) {
      const replaced = createInstanceBehaviorHistory(profile.id, currentSanitized.behaviors)
      historyRef.current = replaced
      setHistory(replaced)
    }
    const triggers = profile.quick
      ? []
      : removedProfileSwitchTriggers(historyRef.current.present[id] ?? emptyTriggers(), sequences)
    if (triggers.length) {
      setPendingDeletion({ profileId: profile.id, inputId: id, triggers, sequences })
      return false
    }
    const next = applyHistoryAction({ type: 'change', inputId: id, sequences })
    if (!next) return
    saveProfileBehaviors(profile.id, next.present)
  }
  const renameProfile = (name: string) =>
    update(item => ({ ...item, profiles: item.profiles.map(p => (p.id === profile.id ? { ...p, name } : p)) }))
  const toggleQuickPromptMode = (promptMode: boolean) =>
    update(item => ({
      ...item,
      profiles: item.profiles.map(p => {
        if (p.id !== profile.id || !p.quick) return p
        if (promptMode) return { ...p, promptMode: true }
        const { promptMode: _removed, ...rest } = p
        return rest
      }),
    }))
  const deleteProfile = () => {
    if (editingQuickProfileId === profile.id) setEditingQuickProfileId(null)
    update(item => deleteInstanceProfile(item, profile.id))
  }
  const previewQuickProfile = useCallback(
    (targetProfileId: string, explicitTriggerInput?: string) => {
      const target = instance.profiles.find(item => item.id === targetProfileId)
      if (!target) return
      const behaviorsForPreview =
        target.id === profile.id ? activeBehaviors : (sanitizedProfiles.get(target.id)?.behaviors ?? {})
      const triggerInput = explicitTriggerInput ?? findQuickOverlayTriggerBinding(instance, target.id)?.inputId ?? ''
      if (!native) {
        onToast?.('桌面应用中可打开顶层快捷交互窗预览')
        return
      }
      void invoke('preview_quick_overlay', {
        sourceId: instance.id,
        deviceKind: instance.kind,
        deviceName: instance.name,
        profileId: target.id,
        profileName: target.name,
        triggerInput,
        behaviors: behaviorsForPreview,
        promptMode: Boolean(target.quick && target.promptMode),
      }).catch(() => {
        onToast?.('无法打开快捷交互窗预览')
      })
    },
    [activeBehaviors, instance, native, onToast, profile.id, sanitizedProfiles],
  )
  const previewClipboardOverlay = useCallback(
    (triggerInputId: string, action: ClipboardOverlayAction = 'paste') => {
      if (!native) {
        onToast?.('桌面应用中可打开剪贴板浮窗预览')
        return
      }
      void invoke('preview_clipboard_overlay', {
        sourceId: instance.id,
        deviceKind: instance.kind,
        deviceName: instance.name,
        triggerInput: triggerInputId,
        action,
      }).catch(() => {
        onToast?.('无法打开剪贴板浮窗预览')
      })
    },
    [instance.id, instance.kind, instance.name, native, onToast],
  )
  const createQuickProfile = useCallback(
    async (name?: string, sourceProfileId?: string) => {
      let createdId: string | null = null
      await controller.update(instance.id, item => {
        const result = addQuickInstanceProfile(item, name, sourceProfileId)
        createdId = result.profileId
        return result.instance
      })
      return createdId
    },
    [controller, instance.id],
  )
  const quickOverlayContext = useMemo<QuickOverlayEditorContext>(
    () => ({
      currentProfileId: profile.id,
      profiles: instance.profiles.map(item => ({
        id: item.id,
        name: item.name,
        quick: item.quick,
        promptMode: item.promptMode,
        configuredCount: countConfiguredInputs(
          item.id === profile.id ? activeBehaviors : (sanitizedProfiles.get(item.id)?.behaviors ?? {}),
          item.quick,
        ),
      })),
      onCreateQuickProfile: createQuickProfile,
      onEditProfile: targetId => setEditingQuickProfileId(targetId),
      onPreviewProfile: (targetId, triggerInputId) => previewQuickProfile(targetId, triggerInputId),
      onPreviewClipboard: (triggerInputId, action) => previewClipboardOverlay(triggerInputId, action),
    }),
    [
      activeBehaviors,
      createQuickProfile,
      instance.profiles,
      previewClipboardOverlay,
      previewQuickProfile,
      profile.id,
      sanitizedProfiles,
    ],
  )
  const mapped = Object.keys(activeBehaviors).filter(id =>
    Object.values(activeBehaviors[id]).some(sequence => sequence.some(b => b.enabled)),
  )
  const overviewItems = buildRailOverviewItems(
    pkg.inputs,
    activeBehaviors,
    platform,
    pkg.remoteView?.buttons,
    inputWarnings,
  )
  const diagramTabLabel = instance.kind === 'xboxBluetooth' ? '手柄' : singleLaneWorkspace ? '控制器' : '遥控器'
  const showCalibrationButton =
    !!voice &&
    (voice.transport === 'gatt' || (usesHidVoice(instance.kind) && (platform === 'windows' || platform === 'macos')))
  const standbyVoiceLabel = '语音待机'
  const voiceDeviceTitle = platform === 'macos' ? '虚拟麦克风：MiRemoteV 2ch' : '虚拟麦克风：Quarbor Virtual Microphone'
  const supportsDriver = supportsWindowsDriver(instance.kind)
  const ready = status?.state === 'exclusive'
  const connectionState = native ? instanceState(instance, controller.snapshot) : undefined
  const connectionLabel = native ? stateLabel(connectionState) : '预览模式'
  const deviceOffline =
    native && platform === 'windows' && supportsDriver && !!instance.binding && status?.driverState === 'offline'
  const driverMissing =
    native && platform === 'windows' && supportsDriver && (!instance.binding || status?.driverState === 'missing')
  const currentDriverAction = instance.binding && driverAction?.instanceId === instance.id ? driverAction : null
  const driverRunning = currentDriverAction?.status === 'running'
  const driverRestartRequired = currentDriverAction?.status === 'restartRequired'
  const driverInstalled = status?.driverInstalled === true
  const driverCommunicationError =
    native && platform === 'windows' && supportsDriver && instance.binding && driverInstalled && !deviceOffline
      ? status?.error
      : null
  const driverBusy = driverAction?.status === 'running'
  const driverErrorDetail = !deviceOffline
    ? currentDriverAction?.status === 'error'
      ? currentDriverAction.error
      : driverCommunicationError
    : null
  const showDriverBanner =
    deviceOffline || driverRestartRequired || !!driverErrorDetail || driverMissing || !!currentDriverAction
  useEffect(() => {
    if (typeof window === 'undefined' || typeof window.addEventListener !== 'function') return
    if (!profile.quick && (settings || pendingSwitch || pendingDeletion || isScreenSelected)) return
    const handleHistoryShortcut = (event: globalThis.KeyboardEvent) => {
      if (event.defaultPrevented || event.altKey || (!event.metaKey && !event.ctrlKey)) return
      const target = event.target
      if (
        target instanceof HTMLElement &&
        (target.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName))
      )
        return
      if (
        typeof document !== 'undefined' &&
        document.querySelector?.('dialog[open], [aria-modal="true"], .app-settings-panel, .record-key-button.capturing')
      )
        return
      const key = event.key.toLowerCase()
      const undo = key === 'z' && !event.shiftKey
      const redo = (key === 'z' && event.shiftKey) || (key === 'y' && event.ctrlKey && !event.metaKey)
      if (undo && canUndo) {
        event.preventDefault()
        undoBehaviorChange()
      } else if (redo && canRedo) {
        event.preventDefault()
        redoBehaviorChange()
      }
    }
    window.addEventListener('keydown', handleHistoryShortcut)
    return () => window.removeEventListener('keydown', handleHistoryShortcut)
  }, [
    canRedo,
    canUndo,
    isScreenSelected,
    pendingDeletion,
    profile.quick,
    pendingSwitch,
    redoBehaviorChange,
    settings,
    undoBehaviorChange,
  ])
  const driverNoticeMessage = driverErrorDetail
    ? '驱动错误，请重新安装。'
    : driverRestartRequired
      ? (currentDriverAction?.message ?? '需要重启 Windows 后继续安装驱动。')
      : deviceOffline
        ? '设备不在线'
        : !instance.binding
          ? '尚未绑定物理设备，请先绑定设备，再安装按键驱动。'
          : driverRunning
            ? '正在安装按键驱动，请完成 Windows 管理员授权…'
            : '按键驱动未安装，请先安装此设备的按键驱动。'
  if (profile.quick) {
    const quickTriggerBinding = findQuickOverlayTriggerBinding(instance, profile.id)
    return (
      <QuickOverlayConfigurator
        key={profile.id}
        deviceKind={instance.kind}
        deviceName={instance.name}
        profileId={profile.id}
        profileName={profile.name}
        promptMode={Boolean(profile.promptMode)}
        triggerInput={quickTriggerBinding?.inputId}
        triggerType={quickTriggerBinding?.trigger ?? 'click'}
        inputs={pkg.inputs}
        behaviors={activeBehaviors}
        platform={platform}
        onChange={changeSequence}
        onBindTrigger={(nextInputId, nextTrigger) => {
          const hadExisting =
            Boolean(nextInputId) && hasExistingNonQuickBehavior(permanentProfile, nextInputId, nextTrigger, profile.id)
          update(item =>
            bindQuickOverlayTrigger(item, profile.id, permanentProfile.id, nextInputId || null, nextTrigger),
          )
          if (!nextInputId) {
            onToast?.('已解除快捷交互窗唤起按键')
            return
          }
          const keyLabel = pkg.inputs.find(item => item.id === nextInputId)?.label ?? nextInputId
          onToast?.(hadExisting ? `已将「${keyLabel}」切换为快捷交互窗唤起键` : `已绑定「${keyLabel}」唤起快捷交互窗`)
        }}
        onTogglePromptMode={toggleQuickPromptMode}
        onRename={renameProfile}
        onDuplicate={() => {
          void createQuickProfile(undefined, profile.id)
            .then(id => {
              if (id) setEditingQuickProfileId(id)
            })
            .catch(() => {})
        }}
        onDelete={deleteProfile}
        onClose={() => setEditingQuickProfileId(null)}
        history={{ canUndo, canRedo, onUndo: undoBehaviorChange, onRedo: redoBehaviorChange }}
      />
    )
  }
  const quickProfiles = instance.profiles.filter(item => item.quick)
  return (
    <div
      ref={workspaceRef}
      className="mapping-page mapping-flow-page managed-instance-workspace"
      style={
        {
          '--device-diagram-ratio': pkg.remoteView
            ? pkg.remoteView.viewBox.width / pkg.remoteView.viewBox.height
            : undefined,
          '--mapping-diagram-width':
            panelLayout.widths.diagram === undefined ? undefined : `${panelLayout.widths.diagram}px`,
        } as CSSProperties
      }
    >
      <div className="mapping-workbench">
        <DeviceWorkspaceHeader
          deviceName={instance.name}
          activeDeviceId={instance.id}
          deviceOptions={deviceOptions}
          onSelectDevice={onSelectDevice}
          onBackToDevices={onBack}
          onOpenSettings={() => setSettings(v => !v)}
          profileControls={
            <ApplicationProfileToolbar
              instance={instance}
              applications={applications}
              native={native}
              platform={platform}
              editingApplicationId={applicationProfile?.application.id ?? ''}
              profileId={profile.id}
              onSelectApplication={id => {
                setEditingQuickProfileId(null)
                setEditingApplicationId(id)
              }}
              onUpdate={change => controller.update(instance.id, change)}
              onSwitchProfile={nextId => {
                const target = instance.profiles.find(item => item.id === nextId)
                if (target?.quick) {
                  setEditingQuickProfileId(target.id)
                  return
                }
                setEditingQuickProfileId(null)
                update(item =>
                  applicationProfile
                    ? setApplicationProfile(item, applicationProfile.application, nextId)
                    : { ...item, activeProfileId: nextId },
                )
              }}
              onCreateProfile={() => {
                setEditingQuickProfileId(null)
                update(item => addInstanceProfile(item, false, applicationProfile?.application.id))
              }}
              onCreateQuickProfile={() => {
                void createQuickProfile()
                  .then(id => {
                    if (id) setEditingQuickProfileId(id)
                  })
                  .catch(() => {})
              }}
              quickProfileCount={quickProfiles.length}
              onOpenQuickOverlay={() => {
                const existing = quickProfiles[0]
                if (existing) {
                  setEditingQuickProfileId(existing.id)
                  return
                }
                void createQuickProfile()
                  .then(id => {
                    if (id) setEditingQuickProfileId(id)
                  })
                  .catch(() => {})
              }}
              onOpenPresets={devicePresets.length > 0 ? () => setPresetDialogOpen(true) : undefined}
              onDuplicateProfile={() =>
                update(item => addInstanceProfile(item, true, applicationProfile?.application.id))
              }
              onRenameProfile={renameProfile}
              onDeleteProfile={deleteProfile}
            />
          }
        />
        {showDriverBanner && (
          <div className="managed-driver-notice" role="status" aria-live="polite">
            <div className="managed-driver-notice-copy">
              <span>{driverNoticeMessage}</span>
              {driverErrorDetail && (
                <details className="managed-driver-notice-details">
                  <summary>查看错误详情</summary>
                  <code>{driverErrorDetail}</code>
                </details>
              )}
            </div>
            {!deviceOffline && !driverRestartRequired && (
              <button
                type="button"
                className="managed-driver-notice-install"
                disabled={driverBusy}
                onClick={instance.binding ? () => onInstallDriver(instance.id) : onBind}
              >
                {!instance.binding
                  ? '绑定设备'
                  : driverRunning
                    ? '正在安装…'
                    : driverInstalled
                      ? '重新安装驱动'
                      : currentDriverAction?.error
                        ? '重试安装'
                        : '安装驱动'}
              </button>
            )}
          </div>
        )}
        <aside className="mapping-device-rail panel-surface">
          <section className="managed-instance-status" aria-label="设备状态">
            {instance.binding ? (
              <span
                className={`managed-instance-connection${connectionState === 'exclusive' ? ' ready' : status?.error ? ' warning' : ''}`}
                title={connectionLabel}
              >
                {connectionState === 'needsRebind' ? '需重新绑定' : connectionLabel}
              </span>
            ) : (
              <button type="button" className="managed-instance-bind" onClick={onBind}>
                绑定设备
              </button>
            )}
            {supportsDeviceInformation(instance.kind) && (
              <span className="managed-instance-power">
                <BatteryIndicator level={batteryLevel} compact />
              </span>
            )}
            <button
              type="button"
              role="switch"
              className={`switch ${instance.enabled ? 'on' : ''}`}
              aria-label="启用此设备"
              aria-checked={instance.enabled}
              onClick={() => update(item => ({ ...item, enabled: !item.enabled }))}
            >
              <span />
            </button>
          </section>
          <div className="rail-mode-tabs" role="tablist" aria-label="按键视图">
            <button
              type="button"
              role="tab"
              className={`rail-tab${railMode === 'diagram' ? ' active' : ''}`}
              aria-selected={railMode === 'diagram'}
              onClick={() => setRailMode('diagram')}
            >
              {diagramTabLabel}
            </button>
            <button
              type="button"
              role="tab"
              className={`rail-tab${railMode === 'list' ? ' active' : ''}`}
              aria-selected={railMode === 'list'}
              onClick={() => setRailMode('list')}
            >
              已配速览{overviewItems.length > 0 ? ` (${overviewItems.length})` : ''}
            </button>
          </div>
          {railMode === 'diagram' ? (
            <>
              <div className="remote-stage">
                <div className="remote-art">
                  <RemoteControl
                    activeId={selected}
                    pressedIds={input.pressed}
                    mappedIds={mapped}
                    warnings={inputWarnings}
                    onSelect={selectInput}
                    remoteView={pkg.remoteView}
                    screenRegion={pkg.screenRegion}
                  />
                </div>
              </div>
              {analogInputs.length > 0 && (
                <div className="managed-analog">
                  {analogInputs.map(button => (
                    <label key={button.id}>
                      {button.short} <meter min={0} max={1} value={input.values[button.id] ?? 0} />
                    </label>
                  ))}
                  <SettingsHelp id="managed-analog-help" label="摇杆与扳机映射">
                    {analogInputs.map(button => (
                      <p key={button.id}>
                        {button.short} 超过 {Math.round(button.threshold * 100)}% 时触发，低于{' '}
                        {Math.round(button.releaseThreshold * 100)}% 时释放。
                      </p>
                    ))}
                  </SettingsHelp>
                </div>
              )}
            </>
          ) : (
            <div className="rail-keymap-list" role="listbox" aria-label="已配按键速览">
              {overviewItems.length === 0 ? (
                <div className="rail-keymap-empty">
                  <p>当前配置暂无已配按键</p>
                  <button type="button" onClick={() => setRailMode('diagram')}>
                    前往选键配置
                  </button>
                </div>
              ) : (
                overviewItems.map(item => {
                  const isSelected = item.input.id === selected
                  const isPressed = input.pressed.includes(item.input.id)
                  const glyphText = railKeyGlyphText(item.input, item.short)
                  return (
                    <BehaviorSummaryPopover
                      key={item.input.id}
                      openDelay={250}
                      placement="right"
                      label={item.input.label}
                      platform={platform}
                      groups={item.groups}
                      shouldOpen={anchor => shouldOpenRailSummaryPopover(anchor, item.hasAbbreviatedDetails)}
                    >
                      <button
                        type="button"
                        role="option"
                        aria-selected={isSelected}
                        className={`rail-keymap-row${isSelected ? ' selected' : ''}${isPressed ? ' pressed' : ''}${item.warning ? ' has-warning' : ''}`}
                        onClick={() => selectInput(item.input.id)}
                      >
                        <span className="rail-keymap-head">
                          <strong>{item.input.label}</strong>
                          <span className="rail-keymap-glyph" aria-hidden="true">
                            {item.warning && <TriangleAlert size={13} className="rail-keymap-warning-icon" />}
                            {glyphText ?? iconFor(item.input.icon, 14)}
                          </span>
                        </span>
                        <span className="rail-keymap-summary">{item.summary}</span>
                      </button>
                    </BehaviorSummaryPopover>
                  )
                })
              )}
            </div>
          )}
          {voice && (
            <div className={`rail-voice-strip${recording ? ` is-recording tone-${voiceTone}` : ''}`}>
              <DeviceRecordingStatus
                recording={recording}
                onToggle={voice.engine === 'cmiot-a15.g7221' ? () => void toggleRecording() : undefined}
                disabled={!native || !instance.enabled || !informationAvailable || !ready || recordingPending}
                idleLabel={standbyVoiceLabel}
                title={voiceDeviceTitle}
                amplitudes={voiceAmplitudes}
                levelTone={voiceTone}
              />
              {showCalibrationButton && (
                <button
                  type="button"
                  className="managed-audio-calibration"
                  aria-label="校准音量"
                  disabled={!native}
                  title={!native ? '请在桌面应用中校准音量' : '校准音量'}
                  onClick={native ? () => onOpenAudioCalibration(instance.id) : undefined}
                >
                  校准
                </button>
              )}
            </div>
          )}
        </aside>
        <MappingColumnSplitter panel="diagram" onResize={width => panelLayout.resize('diagram', width)} />
        <section className="mapping-main" aria-label="设备映射工作区">
          {status?.error && !driverCommunicationError && (
            <p role="alert" className="managed-error">
              {status.error}
            </p>
          )}
          {native && platform === 'macos' && (!permissions.accessibility || !permissions.inputMonitoring) && (
            <p className="managed-notice">
              需要
              {[!permissions.inputMonitoring && '输入监控', !permissions.accessibility && '辅助功能']
                .filter(Boolean)
                .join('、')}
              权限。<button onClick={onPermissions}>前往授权</button>
            </p>
          )}
          {localCloudOverride && (
            <div className="managed-warning" role="status">
              <TriangleAlert size={15} aria-hidden="true" />
              <span>{localCloudOverrideWarningText([localCloudOverride])}</span>
              {native && (
                <button
                  type="button"
                  onClick={() => void invoke('open_local_custom_devices_dir', { highlightFile: null }).catch(() => {})}
                >
                  打开本机目录
                </button>
              )}
            </div>
          )}
          {!isScreenSelected &&
            !profile.quick &&
            countConfiguredInputs(activeBehaviors, false) === 0 &&
            defaultPreset && (
              <div className="preset-blank-banner" role="region" aria-label="预制配置建议">
                <span>当前配置为空，可直接套用开箱方案快速上手。</span>
                <div className="preset-blank-banner-actions">
                  <button
                    type="button"
                    className="preset-blank-apply"
                    onClick={() => applyPresetToCurrent(defaultPreset)}
                  >
                    一键套用「{defaultPreset.name}」
                  </button>
                  <button type="button" className="preset-blank-browse" onClick={() => setPresetDialogOpen(true)}>
                    查看全部预制
                  </button>
                </div>
              </div>
            )}
          {isScreenSelected ? (
            <KivoScreenEditor
              instance={instance}
              profile={profile}
              applicationName={applicationProfile?.application.name}
              native={native}
              onUpdate={update}
            />
          ) : (
            <MappingEditor
              header={
                <section className="key-picker">
                  <div className="key-picker-head">
                    <div className="key-picker-heading">
                      <h2>{selectedInput.label}</h2>
                      {sonyMicSelected ? (
                        <span className="key-picker-voice-guidance">此键只报告点按，语音快捷键请配在「单击」</span>
                      ) : (
                        selectedInput.icon === 'mic' && (
                          <span
                            className="key-picker-voice-guidance"
                            title="要按住说话，请将语音快捷键配在「单击」，「双击」「长按」留空。这样按下即保持、松开即释放；「长按」表示按住一段时间后触发行为。"
                          >
                            要按住说话，请将语音快捷键配在「单击」，「双击」「长按」留空
                          </span>
                        )
                      )}
                    </div>
                    <div className="key-picker-actions">
                      <BehaviorHistoryActions
                        canUndo={canUndo}
                        canRedo={canRedo}
                        onUndo={undoBehaviorChange}
                        onRedo={redoBehaviorChange}
                      />
                    </div>
                  </div>
                  {inputWarnings[selected] && (
                    <div className="key-picker-mapping-warning" role="status">
                      <TriangleAlert size={14} aria-hidden="true" />
                      <span>{inputWarnings[selected]}，已自动跳过无效项</span>
                      {selectedHasDroppedItems && (
                        <button type="button" onClick={() => cleanInvalidInput(selected)}>
                          清理无效项
                        </button>
                      )}
                    </div>
                  )}
                </section>
              }
              splitRatio={splitRatio}
              onSplitRatioChange={setSplitRatio}
              platform={platform}
              button={selectedInput}
              sequences={activeBehaviors[selected] ?? emptyTriggers()}
              libraryWidth={panelLayout.widths.library}
              onLibraryWidthChange={width => panelLayout.resize('library', width)}
              onChange={changeSequence}
              onRequestProfileSwitch={(inputId, trigger, behavior, additionItemId) =>
                setPendingSwitch({ inputId, trigger, behavior, additionItemId })
              }
              toolboxCategory={toolboxCategory}
              onToolboxCategoryChange={setToolboxCategory}
              quickOverlayContext={quickOverlayContext}
            />
          )}
        </section>
      </div>
      {settings && (
        <DeviceSettingsDrawer deviceName={instance.name} onClose={() => setSettings(false)}>
          <nav className="settings-nav device-settings-drawer-nav" aria-label={`${instance.name}设置分类`}>
            <button
              type="button"
              aria-current={settingsSection === 'overview' ? 'page' : undefined}
              onClick={() => setSettingsSection('overview')}
            >
              <Settings2 size={16} />
              <span>设备设置</span>
            </button>
            {supportsDeviceInformation(instance.kind) && (
              <button
                type="button"
                aria-current={settingsSection === 'information' ? 'page' : undefined}
                onClick={() => setSettingsSection('information')}
              >
                <Info size={16} />
                <span>设备信息</span>
              </button>
            )}
            {settingsSection === 'information' && (
              <button
                type="button"
                className="settings-refresh"
                aria-label="刷新设备信息"
                title={informationRefreshLocked ? `${informationRefreshRemaining} 秒后可再次刷新` : '刷新设备信息'}
                disabled={!native || !informationAvailable || !instance.binding || informationRefreshLocked}
                onClick={() => {
                  if (!instance.binding || informationRefreshLocked) return
                  setInformationRefreshRemaining(10)
                  void refreshInformation(instance.binding).catch(() => {})
                }}
              >
                {informationRefreshLocked ? (
                  <span className="device-information-countdown" aria-hidden="true">
                    {informationRefreshRemaining}s
                  </span>
                ) : (
                  <RefreshCw size={14} aria-hidden="true" />
                )}
              </button>
            )}
          </nav>
          <section
            className="device-settings-drawer-panel"
            aria-label={settingsSection === 'information' ? '设备信息' : '设备设置'}
          >
            {settingsSection === 'information' ? (
              <DeviceInformationPanel binding={instance.binding} device={boundDevice} native={native} />
            ) : (
              <>
                {supportsDriver && platform === 'windows' && (
                  <div className="settings-form-row managed-driver-status-row">
                    <span className="settings-form-label">按键驱动：</span>
                    <div className="settings-form-control managed-driver-status-control">
                      <strong>
                        {!native
                          ? '预览模式'
                          : driverRestartRequired
                            ? '需重启后安装'
                            : deviceOffline
                              ? '设备不在线'
                              : status?.driverState === 'installed'
                                ? '已安装'
                                : status?.driverState === 'connected'
                                  ? '已连接'
                                  : status?.driverState === 'connecting'
                                    ? '连接中'
                                    : status?.driverState === 'missing'
                                      ? '未安装'
                                      : status?.driverState === 'disconnected'
                                        ? '等待设备'
                                        : '检测中'}
                      </strong>
                      {native && !deviceOffline && !driverRestartRequired && (
                        <button
                          type="button"
                          disabled={driverBusy || !instance.binding}
                          onClick={() => onInstallDriver(instance.id)}
                        >
                          {driverRunning ? '正在安装…' : driverInstalled ? '重新安装驱动' : '安装驱动'}
                        </button>
                      )}
                    </div>
                  </div>
                )}
                <div className="settings-form-fields">
                  {voice && (platform === 'windows' || platform === 'macos') && (
                    <div className="settings-form-row">
                      <span className="settings-form-label">虚拟麦克风：</span>
                      <div className="settings-form-control">
                        <button type="button" className="dialog-secondary" onClick={onOpenAudioDriver}>
                          管理驱动
                        </button>
                      </div>
                    </div>
                  )}
                  {voiceModes.includes('hold') &&
                    voiceModes.includes('click') &&
                    (platform === 'windows' || platform === 'macos') && (
                      <label className="settings-form-row">
                        <span className="settings-form-label">语音录制：</span>
                        <span className="settings-form-control">
                          <span className="manual-key-select cmiot-recording-select">
                            <select
                              value={instance.cmiotA15RecordingMode ?? defaultRecordingMode(instance.kind)}
                              onChange={event => {
                                const cmiotA15RecordingMode = event.target.value === 'click' ? 'click' : 'hold'
                                update(item => ({ ...item, cmiotA15RecordingMode }))
                              }}
                            >
                              <option value="hold">按住录音，松开停止</option>
                              <option value="click">点击开始，再次点击停止</option>
                            </select>
                            <span className="manual-key-select-icon" aria-hidden="true">
                              <ChevronDown size={14} />
                            </span>
                          </span>
                        </span>
                      </label>
                    )}
                  <label className="settings-form-row">
                    <span className="settings-form-label">设备名称：</span>
                    <input
                      key={instance.name}
                      defaultValue={instance.name}
                      maxLength={60}
                      onBlur={e => {
                        const name = e.target.value.trim()
                        if (name && name !== instance.name) update(item => ({ ...item, name }))
                      }}
                    />
                  </label>
                  <div className="settings-form-row">
                    <span className="settings-form-label">设备型号：</span>
                    <span className="settings-form-control">{pkg.model}</span>
                  </div>
                  <div className="settings-form-row">
                    <span className="settings-form-label" id="instance-binding-label">
                      物理设备：
                    </span>
                    <div className="settings-form-control managed-instance-binding-control">
                      {instance.binding ? (
                        <BoundDeviceInfo
                          binding={instance.binding}
                          device={boundDevice}
                          onRebind={onBind}
                          onUnbind={unbindDevice}
                          disabled={pendingPhysicalAction !== null}
                        />
                      ) : (
                        <DeviceBindingPicker
                          labelledBy="instance-binding-label"
                          value=""
                          devices={availableDevices}
                          onChange={binding => {
                            if (binding) update(item => ({ ...item, binding }))
                          }}
                        />
                      )}
                    </div>
                  </div>
                </div>
                <div className="managed-remove">
                  {confirmRemove ? (
                    <>
                      <span>移除此设备及其全部配置？</span>
                      <button disabled={pendingPhysicalAction !== null} onClick={removeDevice}>
                        {pendingPhysicalAction === 'remove' ? '正在解除绑定…' : '确认移除'}
                      </button>
                      <button onClick={() => setConfirmRemove(false)}>取消</button>
                    </>
                  ) : (
                    <button onClick={() => setConfirmRemove(true)}>移除设备</button>
                  )}
                </div>
              </>
            )}
          </section>
        </DeviceSettingsDrawer>
      )}
      {pendingSwitch &&
        createPortal(
          <ProfileSwitchConfirmDialog
            button={pkg.inputs.find(i => i.id === pendingSwitch.inputId)!}
            trigger={pendingSwitch.trigger}
            behavior={pendingSwitch.behavior}
            targets={instance.profiles.map(p => ({
              id: p.id,
              name: p.name,
              behaviors:
                (p.id === profile.id ? activeBehaviors : p.behaviors)[pendingSwitch.inputId]?.[pendingSwitch.trigger] ??
                [],
            }))}
            activeProfileId={profile.id}
            platform={platform}
            onCancel={() => setPendingSwitch(null)}
            onConfirm={behavior => {
              pendingSavesRef.current += 1
              let nextProfileBehaviors: InstanceProfileBehaviors | undefined
              void controller
                .update(instance.id, item => {
                  const updated = applyInstanceProfileSwitch(
                    item,
                    pendingSwitch.inputId,
                    pendingSwitch.trigger,
                    behavior,
                  )
                  nextProfileBehaviors = updated.profiles.find(p => p.id === profile.id)?.behaviors
                  return updated
                })
                .then(() => {
                  if (nextProfileBehaviors && historyRef.current.profileId === profile.id) {
                    applyHistoryAction({ type: 'replace', profileId: profile.id, present: nextProfileBehaviors })
                  }
                  if (pendingSwitch.additionItemId && behavior.enabled)
                    recordLibraryAdditions([pendingSwitch.additionItemId])
                  onToast?.('已应用到此设备的所有配置文件')
                })
                .catch(() => {})
                .finally(() => {
                  pendingSavesRef.current = Math.max(0, pendingSavesRef.current - 1)
                })
              setPendingSwitch(null)
            }}
          />,
          document.body,
        )}
      {pendingDeletion &&
        createPortal(
          <ProfileSwitchDeleteDialog
            button={pkg.inputs.find(i => i.id === pendingDeletion.inputId)!}
            targets={pendingDeletion.triggers.map(trigger => ({
              trigger,
              profiles: instance.profiles.filter(p =>
                (p.id === profile.id ? activeBehaviors : p.behaviors)[pendingDeletion.inputId]?.[trigger].some(
                  b => b.type === 'switchProfile',
                ),
              ),
            }))}
            onCancel={() => setPendingDeletion(null)}
            onConfirm={() => {
              pendingSavesRef.current += 1
              let nextProfileBehaviors: InstanceProfileBehaviors | undefined
              void controller
                .update(instance.id, item => {
                  const updated = removeInstanceProfileSwitch(
                    item,
                    pendingDeletion.profileId,
                    pendingDeletion.inputId,
                    pendingDeletion.triggers,
                    pendingDeletion.sequences,
                  )
                  nextProfileBehaviors = updated.profiles.find(p => p.id === pendingDeletion.profileId)?.behaviors
                  return updated
                })
                .then(() => {
                  if (nextProfileBehaviors && historyRef.current.profileId === pendingDeletion.profileId) {
                    applyHistoryAction({
                      type: 'replace',
                      profileId: pendingDeletion.profileId,
                      present: nextProfileBehaviors,
                    })
                  }
                  onToast?.('已同步删除切换配置文件行为')
                })
                .catch(() => {})
                .finally(() => {
                  pendingSavesRef.current = Math.max(0, pendingSavesRef.current - 1)
                })
              setPendingDeletion(null)
            }}
          />,
          document.body,
        )}
      {presetDialogOpen &&
        createPortal(
          <PresetProfileDialog
            deviceName={instance.name}
            platform={platform}
            inputs={pkg.inputs}
            presets={devicePresets}
            activeProfileName={profile.name}
            activeProfileIsQuick={Boolean(profile.quick)}
            onCopyAsNew={applyPresetAsNew}
            onOverwriteCurrent={applyPresetToCurrent}
            onClose={() => setPresetDialogOpen(false)}
          />,
          document.body,
        )}
    </div>
  )
}

function BoundDeviceInfo({
  binding,
  device,
  onRebind,
  onUnbind,
  disabled,
}: {
  binding: string
  device?: DiscoveredDevice
  onRebind: () => void
  onUnbind: () => void
  disabled: boolean
}) {
  const transport = device?.transport === 'Bluetooth' ? '蓝牙' : device?.transport
  const status = device?.identityQuality === 'ambiguous' ? '标识冲突' : device?.connected ? '已连接' : '未连接'
  return (
    <div className="managed-bound-device">
      <div className="device-binding-copy">
        <strong>{device?.name ?? '原绑定设备'}</strong>
        <small>{device ? `${transport} · ${device.id.slice(-6)}` : binding}</small>
        <span
          className={`device-binding-status${device?.identityQuality === 'ambiguous' ? ' is-unavailable' : !device?.connected ? ' is-offline' : ''}`}
        >
          <i />
          {status}
        </span>
      </div>
      <div className="managed-bound-device-actions">
        <button type="button" className="dialog-secondary" onClick={onRebind} disabled={disabled}>
          重新绑定
        </button>
        <button type="button" className="dialog-secondary" onClick={onUnbind} disabled={disabled}>
          {disabled ? '正在解除绑定…' : '解除绑定，保留配置'}
        </button>
      </div>
    </div>
  )
}

function DeviceInformationPanel({
  binding,
  device,
  native,
}: {
  binding: string | null
  device?: DiscoveredDevice
  native: boolean
}) {
  const info = device?.deviceInfo
  const unavailable = !binding
    ? '未绑定设备'
    : !native
      ? '预览模式'
      : !device?.connected
        ? '设备未连接'
        : device.identityQuality === 'ambiguous'
          ? '设备身份冲突'
          : info?.status === 'ready'
            ? '设备未提供'
            : info?.status === 'error'
              ? '读取失败'
              : info?.status === 'retrying'
                ? '正在重试…'
                : '读取中…'
  const value = (text?: string | number | null) => (!binding ? '未绑定设备' : (text ?? unavailable))
  const fields = [
    ['设备蓝牙名称', value(info?.bluetoothName)],
    ['设备蓝牙地址', value(device?.bluetoothAddress)],
    [
      '电量',
      !binding ? (
        '未绑定设备'
      ) : device?.connected && info?.batteryLevel != null ? (
        <BatteryIndicator level={info.batteryLevel} />
      ) : (
        unavailable
      ),
    ],
    ['制造商', value(info?.manufacturer)],
    ['型号', value(info?.modelNumber)],
    ['序列号', value(info?.serialNumber)],
    ['硬件版本', value(info?.hardwareRevision)],
    ['固件版本', value(info?.firmwareRevision)],
    ['软件版本', value(info?.softwareRevision)],
  ] as const
  return (
    <div className="settings-form-fields managed-device-information">
      {fields.map(([label, value]) => (
        <div className="settings-form-row" key={label}>
          <span className="settings-form-label">{label}：</span>
          <span className="settings-form-control">{value}</span>
        </div>
      ))}
      {binding && info?.error && (
        <p role="status" className="managed-error">
          {info.status === 'retrying' ? '读取失败，正在重试。' : '读取失败，稍后自动刷新。'}
          {info.error}
        </p>
      )}
    </div>
  )
}

type VoiceAmplitudeState = {
  bars: number[]
  tone: ReturnType<typeof gainLevelTone>
}

const initialRecordingBars = () => idleVoiceBarLevels.map(() => 0)

function useVoiceAmplitude(enabled: boolean, instanceId: string, recording: boolean, audioGainDb: number) {
  const [live, setLive] = useState<VoiceAmplitudeState>(() => ({ bars: initialRecordingBars(), tone: 'silent' }))
  const gainRef = useRef(audioGainDb)
  gainRef.current = audioGainDb

  useEffect(() => {
    if (!enabled || !recording) return
    let active = true
    let timer: number | undefined
    setLive({ bars: initialRecordingBars(), tone: 'silent' })
    const poll = async () => {
      try {
        const level = await invoke<{ peak: number; rms: number }>('get_audio_level', { instanceId })
        if (!active) return
        setLive(current => nextVoiceAmplitudeBars(current.bars, level?.rms ?? 0, level?.peak ?? 0, gainRef.current))
        timer = setTimeout(() => void poll(), 80)
      } catch {
        // Non-Tauri browser previews and unit tests omit the native audio level command.
      }
    }
    void poll()
    return () => {
      active = false
      if (timer !== undefined) clearTimeout(timer)
    }
  }, [enabled, instanceId, recording])

  return enabled && recording ? live : { bars: idleVoiceBarLevels, tone: 'silent' as const }
}
