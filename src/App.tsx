import {
  BatteryMedium,
  Bluetooth,
  Check,
  CheckCircle2,
  Copy,
  Info,
  RotateCcw,
  Target,
  X,
} from 'lucide-react'
import {
  createBehavior,
  createDefaultBehaviorMap,
  moveBehavior,
  updateBehaviorList,
} from './behaviorModel'
import type { Behavior, BehaviorMap, ButtonId, TriggerType } from './behaviorModel'
import {
  behaviorFromCapturedKey,
  buttons,
  cloneBehaviorList,
  detectBrowserPlatform,
  formatCapturedKey,
  getStoredHitPositions,
  getStoredSettings,
  hitPositionsStorageKey,
  iconFor,
  initialHitPositions,
  macOSOnlyButtonIds,
  settingsStorageKey,
  textAndEnterValue,
  withTimeout,
} from './appConfig'
import type {
  AdvancedBehaviorType,
  AppPage,
  AudioProbe,
  CommonBehaviorPreset,
  CommonBehaviorUndo,
  DraftBehaviorState,
  DriverActionResult,
  HitPosition,
  MacPermissionKind,
  MacPermissions,
  Platform,
  RemoteButton,
  RemoteKeyEvent,
  SystemProbe,
} from './appTypes'
import { AppHeader } from './components/AppHeader'
import { HomeDashboard } from './components/HomeDashboard'
import { BehaviorEditDialog, BehaviorEditor, TextInputPresetDialog } from './components/BehaviorEditor'
import { MappingKeyGrid, MappingTriggerSelector } from './components/MappingComponents'
import { MacPermissionHelperWindow, SetupDialog } from './components/SetupDialog'
import { useAudioControls } from './hooks/useAudioControls'
import {
  beginDriverAction,
  completeSetupStep,
  driverDefinitions,
  finishDriverAction,
  isSetupComplete,
  loadSetupState,
  resetSetup,
  saveSetupState,
  setCurrentSetupStep,
  setDeviceConnection,
  setDriverStatus,
  skipDriverAction,
  skipSetup,
  skipSetupStep,
} from './setupModel'
import type { DriverActionKind, DriverKind, SetupState, SetupStepId } from './setupModel'
import { invoke } from '@tauri-apps/api/core'
import { listen } from '@tauri-apps/api/event'
import {
  KeyboardEvent,
  PointerEvent as ReactPointerEvent,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react'

function App() {
  const nativeRuntime = typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window
  const [platform, setPlatform] = useState<Platform>(detectBrowserPlatform)
  const editableButtons = useMemo(
    () => buttons.filter((button) => platform === 'macos' || !macOSOnlyButtonIds.has(button.id)),
    [platform],
  )
  const [macPermissions, setMacPermissions] = useState<MacPermissions>({
    inputMonitoring: false,
    accessibility: false,
    captureActive: false,
  })
  const [permissionHelperKind, setPermissionHelperKind] = useState<MacPermissionKind | null>(null)
  const [activeId, setActiveId] = useState<ButtonId>('voice')
  const [behaviors, setBehaviors] = useState<BehaviorMap>(() => getStoredSettings().behaviors)
  const [enabled, setEnabled] = useState(() => getStoredSettings().enabled)
  const [debugMode, setDebugMode] = useState(false)
  const [hitPositions, setHitPositions] = useState<Record<ButtonId, HitPosition>>(getStoredHitPositions)
  const [draggingId, setDraggingId] = useState<ButtonId | null>(null)
  const [coordinateSnippet, setCoordinateSnippet] = useState('')
  const [autoSaveState, setAutoSaveState] = useState<'saved' | 'saving'>('saved')
  const [toast, setToast] = useState('')
  const [selectedBehavior, setSelectedBehavior] = useState<{ buttonId: ButtonId; trigger: TriggerType }>({ buttonId: 'voice', trigger: 'click' })
  const [capturingBehaviorId, setCapturingBehaviorId] = useState<string | null>(null)
  const [editingBehaviorId, setEditingBehaviorId] = useState<string | null>(null)
  const [draftBehavior, setDraftBehavior] = useState<DraftBehaviorState | null>(null)
  const [textInputDraft, setTextInputDraft] = useState<string | null>(null)
  const [commonBehaviorUndo, setCommonBehaviorUndo] = useState<CommonBehaviorUndo | null>(null)
  const [batteryLevel, setBatteryLevel] = useState<number | null>(null)
  const [inputAuthorizationStale, setInputAuthorizationStale] = useState(false)
  const [activePage, setActivePage] = useState<AppPage>('home')
  const [setupState, setSetupState] = useState<SetupState>(loadSetupState)
  const [setupOpen, setSetupOpen] = useState(() => !isSetupComplete(loadSetupState()))
  const [systemProbeState, setSystemProbeState] = useState<'loading' | 'ready' | 'error'>(nativeRuntime ? 'loading' : 'ready')
  const [pressedId, setPressedId] = useState<ButtonId | null>(null)
  const behaviorEditorRef = useRef<HTMLElement>(null)
  const remoteArtRef = useRef<HTMLDivElement>(null)
  const coordinateTextRef = useRef<HTMLTextAreaElement>(null)
  const markerRefs = useRef<Partial<Record<ButtonId, HTMLButtonElement>>>({})
  const rowRefs = useRef<Partial<Record<ButtonId, HTMLElement>>>({})
  const brandClickRef = useRef({ count: 0, lastAt: 0 })
  const saveRevisionRef = useRef(0)
  const audioProbeRunningRef = useRef(false)
  const systemProbeRunningRef = useRef(false)
  const deviceProbeRunningRef = useRef(false)
  const batteryProbeRunningRef = useRef(false)
  const pressedClearTimerRef = useRef<number | undefined>(undefined)
  const behaviorAttentionTimerRef = useRef<number | undefined>(undefined)
  const [behaviorEditorAttention, setBehaviorEditorAttention] = useState(false)
  const { audioGain, updateAudioGain } = useAudioControls({
    platform,
    nativeRuntime,
    onToast: setToast,
  })

  const updateBehaviorState = useCallback((next: BehaviorMap) => {
    setBehaviors(next)
    setAutoSaveState('saving')
    setCommonBehaviorUndo(null)
  }, [])

  const updateSelectedBehaviorList = useCallback((update: (list: Behavior[]) => Behavior[]) => {
    setBehaviors((current) => updateBehaviorList(current, selectedBehavior.buttonId, selectedBehavior.trigger, update))
    setAutoSaveState('saving')
    setCommonBehaviorUndo(null)
  }, [selectedBehavior])

  useEffect(() => {
    window.localStorage.setItem(hitPositionsStorageKey, JSON.stringify(hitPositions))
  }, [hitPositions])

  useEffect(() => {
    if (typeof window === 'undefined' || !('__TAURI_INTERNALS__' in window)) return
    let active = true
    void invoke<Platform>('get_platform').then((detected) => {
      if (active) setPlatform(detected)
    }).catch(() => undefined)
    return () => { active = false }
  }, [])

  useEffect(() => {
    window.localStorage.setItem(settingsStorageKey, JSON.stringify({ behaviors, enabled }))
    const revision = saveRevisionRef.current + 1
    saveRevisionRef.current = revision
    const syncNativeSettings = async () => {
      try {
        if ('__TAURI_INTERNALS__' in window) {
          await invoke('update_input_settings', { settings: { behaviors, enabled } })
        }
        if (saveRevisionRef.current === revision) setAutoSaveState('saved')
      } catch (error) {
        if (saveRevisionRef.current !== revision) return
        setAutoSaveState('saved')
        setToast(`映射未生效：${String(error)}`)
        window.setTimeout(() => setToast(''), 4200)
      }
    }
    void syncNativeSettings()
  }, [behaviors, enabled])

  useEffect(() => {
    saveSetupState(setupState)
  }, [setupState])

  useEffect(() => () => {
    if (behaviorAttentionTimerRef.current !== undefined) {
      window.clearTimeout(behaviorAttentionTimerRef.current)
    }
  }, [])

  useEffect(() => {
    if (typeof window === 'undefined' || !('__TAURI_INTERNALS__' in window)) return
    let active = true
    const refreshBattery = async () => {
      if (batteryProbeRunningRef.current) return
      batteryProbeRunningRef.current = true
      try {
        const level = await invoke<number | null>('probe_rc003_battery_level')
        if (active) setBatteryLevel(typeof level === 'number' && level >= 0 && level <= 100 ? Math.round(level) : null)
      } catch {
        if (active) setBatteryLevel(null)
      } finally {
        batteryProbeRunningRef.current = false
      }
    }
    const initialTimer = window.setTimeout(refreshBattery, 10_000)
    const interval = window.setInterval(refreshBattery, 60_000)
    return () => {
      active = false
      window.clearTimeout(initialTimer)
      window.clearInterval(interval)
    }
  }, [])

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
      if (!buttons.some((button) => button.id === event.payload.button)) return
      if (pressedClearTimerRef.current !== undefined) window.clearTimeout(pressedClearTimerRef.current)
      pressedClearTimerRef.current = undefined
      if (event.payload.pressed) {
        setPressedId(event.payload.button)
        return
      }
      // Keep a quick tap visible long enough for the eye to catch it.
      pressedClearTimerRef.current = window.setTimeout(() => {
        pressedClearTimerRef.current = undefined
        setPressedId((current) => current === event.payload.button ? null : current)
      }, 180)
    }
    void listen<RemoteKeyEvent>('axonkey-remote-key', handleRemoteKey).then((cleanup) => {
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
    if (!coordinateSnippet || !coordinateTextRef.current) return
    coordinateTextRef.current.focus()
    coordinateTextRef.current.select()
  }, [coordinateSnippet])

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
    setBehaviors(createDefaultBehaviorMap())
    setAutoSaveState('saving')
    setCommonBehaviorUndo(null)
    setToast('已恢复默认映射，将自动保存')
    window.setTimeout(() => setToast(''), 2200)
  }

  const toggleEnabled = () => {
    if (!enabled && platform === 'macos' && (!macPermissions.inputMonitoring || !macPermissions.accessibility)) {
      updateSetup((current) => setCurrentSetupStep(current, 'inputDriver'))
      setSetupOpen(true)
    }
    setEnabled((value) => !value)
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
    setDebugMode((current) => {
      const next = !current
      setToast(next ? '调试模式已开启' : '调试模式已关闭')
      window.setTimeout(() => setToast(''), 2200)
      return next
    })
  }

  const revealBehaviorEditor = () => {
    window.requestAnimationFrame(() => {
      const editor = behaviorEditorRef.current
      if (!editor) return
      const rect = editor.getBoundingClientRect()
      const editorFullyVisible = rect.top >= 8 && rect.bottom <= window.innerHeight - 8
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

  const selectBehaviorTarget = (buttonId: ButtonId, trigger: TriggerType) => {
    setActiveId(buttonId)
    setSelectedBehavior({ buttonId, trigger })
    setCapturingBehaviorId(null)
    setEditingBehaviorId(null)
    setDraftBehavior(null)
    setTextInputDraft(null)
    revealBehaviorEditor()
  }

  const showBehaviorToast = (message: string) => {
    setToast(message)
    window.setTimeout(() => setToast(''), 1600)
  }

  const replaceWithCommonBehavior = (next: Behavior[]) => {
    const target = { ...selectedBehavior }
    const original = cloneBehaviorList(behaviors[target.buttonId][target.trigger])
    setCommonBehaviorUndo((current) => current?.buttonId === target.buttonId && current.trigger === target.trigger
      ? current
      : { ...target, behaviors: original })
    setBehaviors((current) => updateBehaviorList(current, target.buttonId, target.trigger, () => next))
    setAutoSaveState('saving')
  }

  const undoCommonBehavior = () => {
    if (!commonBehaviorUndo) return
    const snapshot = commonBehaviorUndo
    setBehaviors((current) => updateBehaviorList(current, snapshot.buttonId, snapshot.trigger, () => cloneBehaviorList(snapshot.behaviors)))
    setAutoSaveState('saving')
    setCommonBehaviorUndo(null)
    showBehaviorToast('已恢复原始行为')
  }

  const replaceWithKey = (key: string, label: string) => {
    replaceWithCommonBehavior([createBehavior({ type: 'key', key })])
    showBehaviorToast(`已设置为${label}`)
  }

  const beginBehaviorDraft = (type: AdvancedBehaviorType, mode: DraftBehaviorState['mode']) => {
    const behavior = type === 'key'
      ? { ...createBehavior({ type: 'shortcut' }), keys: [] }
      : createBehavior(type === 'paste' ? { type, text: '' } : { type, ms: 300 })
    setEditingBehaviorId(null)
    setDraftBehavior({ behavior, mode })
    setCapturingBehaviorId(type === 'key' ? behavior.id : null)
  }

  const applyCommonBehavior = (preset: CommonBehaviorPreset) => {
    switch (preset) {
      case 'original':
        replaceWithCommonBehavior([])
        showBehaviorToast(selectedBehavior.trigger === 'click' ? '已保留原按键' : '已清除此触发方式')
        return
      case 'disabled':
        replaceWithCommonBehavior([createBehavior({ type: 'disabled' })])
        showBehaviorToast('已禁用这个触发方式')
        return
      case 'escape': return replaceWithKey('Esc', 'Esc')
      case 'enter': return replaceWithKey('Enter', 'Enter')
      case 'space': return replaceWithKey('Space', 'Space')
      case 'tab': return replaceWithKey('Tab', 'Tab')
      case 'backspace': return replaceWithKey('Backspace', 'Backspace')
      case 'delete': return replaceWithKey('Delete', 'Delete')
      case 'keyHome': return replaceWithKey('Home', 'Home')
      case 'keyEnd': return replaceWithKey('End', 'End')
      case 'pageUp': return replaceWithKey('PageUp', 'Page Up')
      case 'pageDown': return replaceWithKey('PageDown', 'Page Down')
      case 'arrowUp': return replaceWithKey('Up', '方向上')
      case 'arrowDown': return replaceWithKey('Down', '方向下')
      case 'arrowLeft': return replaceWithKey('Left', '方向左')
      case 'arrowRight': return replaceWithKey('Right', '方向右')
      case 'volumeUp': return replaceWithKey('VolumeUp', '增大音量')
      case 'volumeDown': return replaceWithKey('VolumeDown', '减小音量')
      case 'volumeMute': return replaceWithKey('VolumeMute', '静音')
      case 'mediaPlayPause': return replaceWithKey('MediaPlayPause', '播放 / 暂停')
      case 'customKey':
        beginBehaviorDraft('key', 'replace')
        return
      case 'textAndEnter':
        setTextInputDraft(textAndEnterValue(behaviors[selectedBehavior.buttonId][selectedBehavior.trigger]) ?? '')
    }
  }

  const commitDraftBehavior = (behavior = draftBehavior?.behavior) => {
    if (!draftBehavior || !behavior) return
    if (draftBehavior.mode === 'replace') replaceWithCommonBehavior([behavior])
    else updateSelectedBehaviorList((list) => [...list, behavior])
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
    updateSelectedBehaviorList((list) => list.filter((behavior) => behavior.id !== behaviorId))
    if (capturingBehaviorId === behaviorId) setCapturingBehaviorId(null)
    if (editingBehaviorId === behaviorId) setEditingBehaviorId(null)
  }

  const moveSelectedBehavior = (behaviorId: string, direction: -1 | 1) => {
    const list = behaviors[selectedBehavior.buttonId][selectedBehavior.trigger]
    const index = list.findIndex((behavior) => behavior.id === behaviorId)
    if (index < 0) return
    updateBehaviorState(moveBehavior(behaviors, selectedBehavior.buttonId, selectedBehavior.trigger, index, index + direction))
  }

  const updateBehavior = (behaviorId: string, update: (behavior: Behavior) => Behavior) => {
    updateSelectedBehaviorList((list) => list.map((behavior) => behavior.id === behaviorId ? update(behavior) : behavior))
  }

  const captureBehaviorKey = (behavior: Behavior, event: KeyboardEvent<HTMLElement>) => {
    const captured = formatCapturedKey(event)
    if (!captured) return
    event.preventDefault()
    updateBehavior(behavior.id, (current) => current.type === 'key' || current.type === 'shortcut'
      ? { ...behaviorFromCapturedKey(captured, current.id), enabled: current.enabled }
      : current)
    setCapturingBehaviorId(null)
    setEditingBehaviorId(null)
  }

  const captureDraftBehaviorKey = (behavior: Behavior, event: KeyboardEvent<HTMLElement>) => {
    const captured = formatCapturedKey(event)
    if (!captured) return
    event.preventDefault()
    commitDraftBehavior(behaviorFromCapturedKey(captured, behavior.id))
  }

  const updateSetup = (update: (current: SetupState) => SetupState) => {
    setSetupState((current) => update(current))
  }

  const openSetupStep = (step: SetupStepId) => {
    updateSetup((current) => setCurrentSetupStep(current, step))
    setSetupOpen(true)
  }

  const completeCurrentSetupStep = () => {
    updateSetup((current) => completeSetupStep(current, current.currentStep))
  }

  const skipCurrentSetupStep = () => {
    updateSetup((current) => skipSetupStep(current, current.currentStep))
  }

  const runDriverAction = async (driver: DriverKind, action: DriverActionKind) => {
    updateSetup((current) => beginDriverAction(current, driver, action))
    try {
      const result = await invoke<DriverActionResult>('launch_driver_action', { driver, action })
      const driverName = driver === 'audio'
        ? platform === 'macos' ? 'MiRemoteV 2ch' : 'VB-CABLE'
        : '按键驱动'
      const restartRequired = platform === 'windows'
      updateSetup((current) => finishDriverAction(current, driver, action, {
        success: true,
        status: action === 'install' ? restartRequired ? 'restartRequired' : 'installed' : 'missing',
        restartRequired,
        message: platform === 'macos'
          ? `${driverName}${action === 'install' ? '安装' : '卸载'}已完成，Core Audio 已刷新。日志：${result.logPath}`
          : `${driverName}${action === 'install' ? '安装' : '卸载'}已完成，请重启 Windows。日志：${result.logPath}`,
      }))
      if (platform === 'macos') window.setTimeout(() => void probeAudioState(), 800)
    } catch (error) {
      const browserPreview = typeof window !== 'undefined' && !('__TAURI_INTERNALS__' in window)
      updateSetup((current) => finishDriverAction(current, driver, action, {
        success: false,
        status: 'error',
        error: browserPreview ? '浏览器预览不会启动系统脚本，请在 Tauri 桌面版中操作。' : String(error),
      }))
    }
  }

  const openSystemSettings = async (page: 'bluetooth' | 'sound' | 'inputMonitoring' | 'accessibility') => {
    try {
      await invoke('open_system_settings', { page })
      return true
    } catch {
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
        setToast(`无法切换授权小窗：${String(error)}`)
      }
    }

    setToast(`正在打开${permissionName}授权…`)
    let granted = false
    try {
      granted = await invoke<boolean>('request_macos_permission', { kind })
      if (granted) {
        setToast(`${permissionName}权限已授权`)
      } else {
        const opened = await openSystemSettings(kind)
        if (opened) setToast(`已打开${permissionName}设置`)
      }
    } catch (error) {
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

  const closePermissionHelper = async (continueSetup = false) => {
    if (typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window) {
      try {
        await invoke('set_permission_helper_mode', { enabled: false })
      } catch (error) {
        setToast(`无法恢复主窗口：${String(error)}`)
      }
    }
    setPermissionHelperKind(null)
    void probeSystemState(false)
    if (continueSetup) {
      updateSetup((current) => current.currentStep === 'inputDriver'
        ? completeSetupStep(current, 'inputDriver')
        : current)
    }
  }

  const revealCurrentApp = async () => {
    try {
      await invoke('reveal_current_app')
      setToast('已在 Finder 中定位 Axonkey')
    } catch (error) {
      const browserPreview = typeof window !== 'undefined' && !('__TAURI_INTERNALS__' in window)
      setToast(browserPreview ? '桌面版会在 Finder 中定位 Axonkey' : `无法定位 Axonkey：${String(error)}`)
    }
    window.setTimeout(() => setToast(''), 2400)
  }

  const openExternalPage = async (page: 'vbcable') => {
    try {
      await invoke('open_external_page', { page })
    } catch {
      setToast('无法打开 VB-Audio 官方页面')
      window.setTimeout(() => setToast(''), 2200)
    }
  }

  const probeSystemState = async (showChecking = true) => {
    if (systemProbeRunningRef.current || typeof window === 'undefined' || !('__TAURI_INTERNALS__' in window)) return false
    systemProbeRunningRef.current = true
    if (showChecking) {
      updateSetup((current) => {
        const next = setDriverStatus(current, 'input', 'checking', { message: '正在检查按键拦截驱动…' })
        return setDeviceConnection(next, { status: 'checking', message: '正在检查 RC003…' })
      })
    }
    try {
      const probe = await invoke<SystemProbe>('probe_system_state')
      setPlatform(probe.platform)
      setInputAuthorizationStale(probe.platform === 'macos' && probe.input_authorization_stale === true)
      setMacPermissions({
        inputMonitoring: probe.input_monitoring_granted === true,
        accessibility: probe.accessibility_granted === true,
        captureActive: probe.capture_active,
      })
      updateSetup((current) => {
        const connectedDevice = {
          status: 'connected' as const,
          name: '小米遥控器 RC003',
          hardwareId: probe.device_hardware_id ?? undefined,
          message: probe.platform === 'macos'
            ? probe.input_authorization_stale
              ? '蓝牙已连接，但当前构建没有 HID 输入权限；重新授权后电源键、返回键等映射才会生效。'
              : probe.capture_active
              ? 'IOKit 已识别 RC003，原始按键已被拦截。'
              : 'macOS 已识别 RC003；启用映射后会由 Axonkey 接管。'
            : probe.device_hardware_id
              ? 'OpenInputBridge 输入服务已识别并接管 RC003。'
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
        const inputStatus = probe.platform === 'macos'
          ? probe.input_authorization_stale
            ? 'error'
            : !macPermissionsReady
            ? 'missing'
            : probe.input_backend_error
              ? 'error'
              : probe.input_backend_ready ? 'installed' : 'checking'
          : !probe.input_driver_installed ? 'missing' : probe.input_backend_error ? 'error' : 'installed'
        const inputMessage = probe.platform === 'macos'
          ? probe.input_authorization_stale
            ? '当前构建的输入监控授权已失效。请在系统设置中移除旧 Axonkey，重新添加当前 Axonkey.app 并打开开关。'
            : !macPermissionsReady
            ? '需要授予输入监控和辅助功能权限。'
            : probe.input_backend_error
              ? `原生输入服务启动失败：${probe.input_backend_error}`
              : probe.capture_active
                ? 'macOS 原生输入服务已接管并拦截 RC003 原始按键。'
                : 'macOS 原生输入服务已就绪。'
          : !probe.input_driver_installed
            ? '未检测到完整的 OpenInputBridge 按键驱动。'
            : probe.input_backend_error
              ? `驱动已安装，但输入服务启动失败：${probe.input_backend_error}`
              : probe.input_backend_ready
                ? 'OpenInputBridge 按键服务工作正常。'
                : '已检测到 OpenInputBridge 按键驱动，输入服务正在启动。'
        const next = setDriverStatus(current, 'input', inputStatus, { message: inputMessage })
        if (!showChecking) {
          const unchanged = next.device.status === device.status
            && next.device.name === device.name
            && next.device.hardwareId === device.hardwareId
            && next.device.message === device.message
          return unchanged ? next : setDeviceConnection(next, device)
        }
        return setDeviceConnection(next, device)
      })
      setSystemProbeState('ready')
      return true
    } catch (error) {
      if (showChecking) {
        updateSetup((current) => {
          const next = setDriverStatus(current, 'input', 'error', { message: `按键驱动检测失败：${String(error)}` })
          return setDeviceConnection(next, { status: 'error', message: String(error) })
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
    updateSetup((current) => setDriverStatus(current, 'audio', 'checking', {
      message: platform === 'macos' ? '正在检查 MiRemoteV 2ch 与 RC003 语音通道…' : '正在检查 VB-CABLE 虚拟麦克风…',
    }))
    try {
      if (platform === 'macos') {
        const probe = await withTimeout(
          invoke<AudioProbe>('probe_audio_state'),
          5_000,
          '检测超时，请点击“重新检测”再试',
        )
        const stateMessage = probe.forwarding
          ? '正在把 RC003 麦克风音频转发到 MiRemoteV 2ch。'
          : probe.state === 'ready'
            ? 'MiRemoteV 2ch 已安装，RC003 语音通道已连接。'
            : probe.state === 'connecting' || probe.state === 'scanning'
              ? 'MiRemoteV 2ch 已安装，正在连接 RC003 语音通道。'
              : probe.error
                ? `MiRemoteV 2ch 已安装；语音通道：${probe.error}`
                : 'MiRemoteV 2ch 已安装，按住语音键时会自动开始转发。'
        updateSetup((current) => setDriverStatus(current, 'audio', probe.driverInstalled ? 'installed' : 'missing', {
          message: probe.driverInstalled ? stateMessage : '未检测到 MiRemoteV 2ch 虚拟麦克风驱动。',
        }))
      } else {
        const available = await withTimeout(
          invoke<boolean>('probe_audio_available'),
          5_000,
          '检测超时，请点击“重新检测”再试',
        )
        updateSetup((current) => setDriverStatus(current, 'audio', available ? 'installed' : 'missing', {
          message: available ? '已检测到 VB-Audio Virtual Cable（CABLE Output）。' : '未检测到 VB-CABLE 虚拟麦克风驱动。',
        }))
      }
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error)
      updateSetup((current) => setDriverStatus(current, 'audio', 'error', {
        message: `音频检测失败：${detail}。可点击“重新检测”，不影响按键映射。`,
      }))
    } finally {
      audioProbeRunningRef.current = false
    }
  }

  const probeDeviceConnection = async () => {
    if (deviceProbeRunningRef.current || typeof window === 'undefined' || !('__TAURI_INTERNALS__' in window)) return
    deviceProbeRunningRef.current = true
    updateSetup((current) => setDeviceConnection(current, { status: 'checking', message: '正在后台检查 RC003…' }))
    try {
      const connected = await invoke<boolean>('probe_rc003_connected')
      updateSetup((current) => setDeviceConnection(current, connected
        ? {
          status: 'connected',
          name: '小米遥控器 RC003',
          hardwareId: current.device.hardwareId,
          message: platform === 'macos'
            ? macPermissions.captureActive
              ? 'IOKit 已识别 RC003，原始按键已被拦截。'
              : 'macOS 已识别 RC003；启用映射后会由 Axonkey 接管。'
            : current.device.hardwareId
              ? 'OpenInputBridge 输入服务已识别并接管 RC003。'
              : 'Windows 已检测到 RC003；按任意键唤醒后即可接管输入。',
        }
        : { status: 'disconnected', message: '未检测到 RC003，请确认蓝牙已配对并按任意键唤醒。' }))
    } catch (error) {
      updateSetup((current) => setDeviceConnection(current, { status: 'error', message: `设备检测失败：${String(error)}` }))
    } finally {
      deviceProbeRunningRef.current = false
    }
  }

  const checkDeviceConnection = () => {
    if (typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window) {
      void probeDeviceConnection()
      return
    }
    updateSetup((current) => setDeviceConnection(current, { status: 'checking', message: '正在检查 RC003…' }))
    window.setTimeout(() => {
      updateSetup((current) => current.device.status === 'checking'
        ? setDeviceConnection(current, { status: 'disconnected', message: '未自动检测到 RC003，请确认蓝牙已配对并按任意键唤醒。' })
        : current)
    }, 900)
  }

  useEffect(() => {
    if (setupOpen) void probeSystemState()
  }, [setupOpen])

  useEffect(() => {
    if (!setupOpen || platform !== 'macos' || setupState.currentStep !== 'welcome') return
    updateSetup((current) => current.currentStep === 'welcome'
      ? completeSetupStep(current, 'welcome')
      : current)
  }, [platform, setupOpen, setupState.currentStep])

  useEffect(() => {
    document.body.classList.toggle('permission-helper-mode', permissionHelperKind !== null)
    return () => document.body.classList.remove('permission-helper-mode')
  }, [permissionHelperKind])

  useEffect(() => {
    if (!setupOpen || platform !== 'macos') return
    const refreshPermissions = () => void probeSystemState()
    const refreshVisiblePermissions = () => {
      if (document.visibilityState === 'visible') refreshPermissions()
    }
    window.addEventListener('focus', refreshPermissions)
    document.addEventListener('visibilitychange', refreshVisiblePermissions)
    return () => {
      window.removeEventListener('focus', refreshPermissions)
      document.removeEventListener('visibilitychange', refreshVisiblePermissions)
    }
  }, [setupOpen, platform])

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
    if (setupOpen && setupState.currentStep === 'inputDriver') void probeAudioState()
  }, [setupOpen, setupState.currentStep, platform])

  useEffect(() => {
    if (typeof window === 'undefined' || !('__TAURI_INTERNALS__' in window)) return
    const initialTimer = window.setTimeout(() => void probeAudioState(), 1_500)
    const interval = window.setInterval(() => void probeAudioState(), 30_000)
    return () => {
      window.clearTimeout(initialTimer)
      window.clearInterval(interval)
    }
  }, [platform])

  useEffect(() => {
    if (setupOpen && setupState.currentStep === 'deviceConnection') void probeDeviceConnection()
  }, [setupOpen, setupState.currentStep])

  const handleHotspotPointerDown = (button: RemoteButton, event: ReactPointerEvent<HTMLButtonElement>) => {
    if (!debugMode || !remoteArtRef.current) return
    event.preventDefault()
    event.stopPropagation()
    event.currentTarget.setPointerCapture(event.pointerId)
    setActiveId(button.id)
    setDraggingId(button.id)
  }

  const handleHotspotPointerMove = (button: RemoteButton, event: ReactPointerEvent<HTMLButtonElement>) => {
    if (!debugMode || draggingId !== button.id || !remoteArtRef.current) return
    const rect = remoteArtRef.current.getBoundingClientRect()
    const x = Math.max(2, Math.min(98, ((event.clientX - rect.left) / rect.width) * 100))
    const y = Math.max(2, Math.min(98, ((event.clientY - rect.top) / rect.height) * 100))
    setHitPositions((current) => ({ ...current, [button.id]: { x, y } }))
  }

  const finishHotspotDrag = (event: ReactPointerEvent<HTMLButtonElement>) => {
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId)
    setDraggingId(null)
  }

  const copyHitPositions = async () => {
    const lines = editableButtons.map((button) => `  ${button.id}: { x: ${hitPositions[button.id].x.toFixed(2)}, y: ${hitPositions[button.id].y.toFixed(2)} },`)
    const snippet = `const initialHitPositions: Record<ButtonId, HitPosition> = {\n${lines.join('\n')}\n}`
    setCoordinateSnippet(snippet)
    let copied = false
    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(snippet)
        copied = true
      }
    } catch {
      copied = false
    }
    if (!copied) {
      const fallback = document.createElement('textarea')
      fallback.value = snippet
      fallback.setAttribute('readonly', '')
      fallback.style.position = 'fixed'
      fallback.style.opacity = '0'
      document.body.appendChild(fallback)
      fallback.select()
      copied = document.execCommand('copy')
      fallback.remove()
    }
    setToast(copied ? '坐标已复制，也可以从弹窗中手动复制' : `请在弹窗文本框中按 ${platform === 'macos' ? 'Command' : 'Ctrl'}+C 复制坐标`)
    window.setTimeout(() => setToast(''), 2600)
  }

  const resetHitPositions = () => {
    setHitPositions(initialHitPositions)
    window.localStorage.removeItem(hitPositionsStorageKey)
    setToast('已恢复默认点位')
    window.setTimeout(() => setToast(''), 2200)
  }

  const editingBehavior = editingBehaviorId
    ? behaviors[selectedBehavior.buttonId][selectedBehavior.trigger].find((behavior) => behavior.id === editingBehaviorId) ?? null
    : null
  const canUndoCommonBehavior = commonBehaviorUndo?.buttonId === selectedBehavior.buttonId
    && commonBehaviorUndo.trigger === selectedBehavior.trigger
  const selectedButton = editableButtons.find((button) => button.id === selectedBehavior.buttonId) ?? editableButtons[0]

  if (permissionHelperKind) {
    const permissionsReady = macPermissions.inputMonitoring && macPermissions.accessibility
    const activePermission = !macPermissions.inputMonitoring
      ? 'inputMonitoring'
      : !macPermissions.accessibility ? 'accessibility' : permissionHelperKind
    return <>
      <MacPermissionHelperWindow
        activePermission={activePermission}
        permissions={macPermissions}
        onOpenSettings={(kind) => void openSystemSettings(kind)}
        onRevealApp={() => void revealCurrentApp()}
        onRefresh={() => void probeSystemState(false)}
        onClose={() => void closePermissionHelper(permissionsReady)}
      />
      {toast && <div className="toast"><Check size={15} /> {toast}</div>}
    </>
  }

  return (
    <div className={`app-shell ${activePage === 'mapping' ? 'mapping-active' : ''}`}>
      <main className="main-content">
        <AppHeader
          activePage={activePage}
          enabled={enabled}
          onBrandClick={handleBrandClick}
          onNavigate={setActivePage}
          onToggleEnabled={toggleEnabled}
        />

        {activePage === 'mapping' ? <div className="mapping-page">
          <div className={`mapping-workbench ${debugMode ? 'debug-mode' : ''}`}>
            <aside className="mapping-device-rail panel-surface">
              <button type="button" className="device-card remote-device-card" onClick={() => openSetupStep(inputAuthorizationStale ? 'inputDriver' : 'deviceConnection')}><div className="device-card-head"><strong>小米遥控器</strong>{inputAuthorizationStale ? <Info className="device-icon warning" size={16} /> : setupState.device.status === 'connected' ? <CheckCircle2 className="device-icon" size={16} /> : <Bluetooth className="device-icon" size={16} />}</div><div className="device-card-meta"><span className={`device-state-dot ${setupState.device.status === 'connected' ? 'connected' : ''}`} /> <span>{setupState.device.status === 'connected' ? '已连接' : '未连接'}</span><BatteryMedium size={14} /><span className={`battery-level ${batteryLevel !== null && batteryLevel <= 20 ? 'low' : ''}`}>{batteryLevel === null ? '电量未知' : `${batteryLevel}%`}</span><span className="device-meta-separator" /><span>{inputAuthorizationStale ? '权限失效' : platform === 'macos' ? '设备与权限' : '设备与驱动'}</span></div></button>
              <div className="remote-stage">
                <div className="remote-art" ref={remoteArtRef}>
                  <img src="/rc003-remote-keymap.png" alt="小米 RC003 遥控器" />
                  {editableButtons.map((button) => (
                    <button
                      key={button.id}
                      ref={(node) => { if (node) markerRefs.current[button.id] = node }}
                      type="button"
                      aria-label={button.label}
                      className={`hotspot hotspot-${button.icon} ${activeId === button.id ? 'active' : ''} ${pressedId === button.id ? 'pressed' : ''} ${Object.values(behaviors[button.id]).some((list) => list.length > 0) ? 'mapped' : ''} ${draggingId === button.id ? 'dragging' : ''}`}
                      style={{ left: `${hitPositions[button.id].x}%`, top: `${hitPositions[button.id].y}%` }}
                      onClick={() => selectBehaviorTarget(button.id, 'click')}
                      onPointerDown={(event) => handleHotspotPointerDown(button, event)}
                      onPointerMove={(event) => handleHotspotPointerMove(button, event)}
                      onPointerUp={finishHotspotDrag}
                      onPointerCancel={finishHotspotDrag}
                    >{button.icon === 'center' ? <span className="center-dot" /> : iconFor(button.icon, 13)}</button>
                  ))}
                </div>
              </div>
            </aside>

            <section className="mapping-main" aria-label="按键映射工作区">
              <section className="key-picker" aria-labelledby="key-picker-title">
                <div className="key-picker-head">
                  <h2 id="key-picker-title">按键</h2>
                  <div className="key-picker-actions"><span className={`auto-save-state ${autoSaveState}`}><Check size={13} /> {autoSaveState === 'saving' ? '保存中' : '已保存'}</span>{debugMode && <><span className="toolbar-divider" /><span className="debug-status"><Target size={13} /> 调试模式</span><button type="button" className="reset-button" onClick={() => void copyHitPositions()}><Copy size={13} /> 复制坐标</button><button type="button" className="reset-button" onClick={resetHitPositions}><RotateCcw size={13} /> 恢复点位</button></>}<button type="button" className="reset-button" onClick={resetMappings}><RotateCcw size={14} /> 恢复默认</button></div>
                </div>
                <MappingKeyGrid
                  buttons={editableButtons}
                  behaviors={behaviors}
                  activeId={activeId}
                  pressedId={pressedId}
                  rowRefs={rowRefs}
                  onSelect={(buttonId) => selectBehaviorTarget(buttonId, 'click')}
                />
              </section>
              <MappingTriggerSelector
                button={selectedButton}
                behaviors={behaviors[selectedBehavior.buttonId]}
                trigger={selectedBehavior.trigger}
                onSelect={(trigger) => selectBehaviorTarget(selectedBehavior.buttonId, trigger)}
              />
              <BehaviorEditor
                editorRef={behaviorEditorRef}
                attention={behaviorEditorAttention}
                platform={platform}
                button={selectedButton}
                trigger={selectedBehavior.trigger}
                behaviors={behaviors[selectedBehavior.buttonId][selectedBehavior.trigger]}
                canUndoCommonBehavior={canUndoCommonBehavior}
                onApplyCommonBehavior={applyCommonBehavior}
                onUndoCommonBehavior={undoCommonBehavior}
                onAddAdvancedBehavior={(type) => beginBehaviorDraft(type, 'append')}
                onRemoveBehavior={removeBehavior}
                onMoveBehavior={moveSelectedBehavior}
                onEditBehavior={setEditingBehaviorId}
                onReturnToMappings={returnToSelectedMapping}
              />
            </section>
          </div>
          {platform !== 'macos' && <div className="mapping-limit-note" role="note">
            <Info size={12} aria-hidden="true" />
            <span>返回键和独立音量 + / - 键暂不可配置：Windows 无法可靠区分这些按键来自哪台设备，强制映射可能影响其他键盘或遥控器。</span>
          </div>}
        </div> : <HomeDashboard
          platform={platform}
          nativeRuntime={nativeRuntime}
          systemProbeState={systemProbeState}
          permissions={macPermissions}
          inputAuthorizationStale={inputAuthorizationStale}
          inputDriver={setupState.drivers.input}
          audioDriver={setupState.drivers.audio}
          device={setupState.device}
          batteryLevel={batteryLevel}
          audioGain={audioGain}
          enabled={enabled}
          onRequestPermission={(kind) => void requestMacPermission(kind)}
          onRefresh={() => { void probeSystemState(false); void probeAudioState() }}
          onAudioGainChange={updateAudioGain}
          onOpenStep={openSetupStep}
          onOpenMapping={() => setActivePage('mapping')}
        />}
      </main>
      {toast && <div className="toast"><Check size={15} /> {toast}</div>}
      {coordinateSnippet && <div className="coordinate-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) setCoordinateSnippet('') }}>
        <section className="coordinate-dialog" role="dialog" aria-modal="true" aria-labelledby="coordinate-title">
          <div className="coordinate-dialog-head"><div><span className="section-kicker">DEBUG POSITION</span><h2 id="coordinate-title">坐标已生成</h2></div><button type="button" className="dialog-close" aria-label="关闭" onClick={() => setCoordinateSnippet('')}><X size={16} /></button></div>
          <p>文本框已经自动选中，按 {platform === 'macos' ? 'Command' : 'Ctrl'}+C 后粘贴发给我，或替换 App.tsx 中的 initialHitPositions。</p>
          <textarea ref={coordinateTextRef} value={coordinateSnippet} readOnly aria-label="定位坐标代码" />
          <div className="coordinate-dialog-actions"><button type="button" className="dialog-secondary" onClick={() => coordinateTextRef.current?.select()}><Copy size={14} /> 全选坐标</button><button type="button" className="button primary" onClick={() => setCoordinateSnippet('')}>完成</button></div>
        </section>
      </div>}
      {editingBehavior && <BehaviorEditDialog
        platform={platform}
        button={editableButtons.find((button) => button.id === selectedBehavior.buttonId) ?? editableButtons[0]}
        trigger={selectedBehavior.trigger}
        behavior={editingBehavior}
        capturing={capturingBehaviorId === editingBehavior.id}
        onStartCapture={() => setCapturingBehaviorId(editingBehavior.id)}
        onCancelCapture={() => setCapturingBehaviorId(null)}
        onCaptureKey={captureBehaviorKey}
        onUpdate={(update) => updateBehavior(editingBehavior.id, update)}
        onClose={() => { setEditingBehaviorId(null); setCapturingBehaviorId(null) }}
      />}
      {draftBehavior && <BehaviorEditDialog
        platform={platform}
        button={editableButtons.find((button) => button.id === selectedBehavior.buttonId) ?? editableButtons[0]}
        trigger={selectedBehavior.trigger}
        behavior={draftBehavior.behavior}
        capturing={capturingBehaviorId === draftBehavior.behavior.id}
        draft
        onStartCapture={() => setCapturingBehaviorId(draftBehavior.behavior.id)}
        onCancelCapture={() => setCapturingBehaviorId(null)}
        onCaptureKey={captureDraftBehaviorKey}
        onUpdate={(update) => setDraftBehavior((current) => current ? { ...current, behavior: update(current.behavior) } : null)}
        onClose={() => { setDraftBehavior(null); setCapturingBehaviorId(null) }}
        onSave={() => commitDraftBehavior()}
      />}
      {textInputDraft !== null && <TextInputPresetDialog
        button={editableButtons.find((button) => button.id === selectedBehavior.buttonId) ?? editableButtons[0]}
        trigger={selectedBehavior.trigger}
        value={textInputDraft}
        onChange={setTextInputDraft}
        onClose={() => setTextInputDraft(null)}
        onSave={commitTextInputPreset}
      />}
      {setupOpen && <SetupDialog
        platform={platform}
        macPermissions={macPermissions}
        state={setupState}
        onClose={() => setSetupOpen(false)}
        onOpenStep={openSetupStep}
        onCompleteStep={completeCurrentSetupStep}
        onSkipStep={skipCurrentSetupStep}
        onSkipAll={() => { setSetupState((current) => skipSetup(current)); setSetupOpen(false) }}
        onReset={() => setSetupState(resetSetup())}
        onDriverAction={(driver, action) => void runDriverAction(driver, action)}
        onSkipDriverAction={(driver, action) => updateSetup((current) => skipDriverAction(current, driver, action))}
        onMarkDriverInstalled={(driver) => updateSetup((current) => setDriverStatus(current, driver, 'restartRequired', { restartRequired: true, message: '已确认安装，重启 Windows 后驱动生效。' }))}
        onProbeAudio={() => void probeAudioState()}
        onOpenSystemSettings={(page) => void openSystemSettings(page)}
        onRequestMacPermission={(kind) => void requestMacPermission(kind)}
        onOpenExternalPage={(page) => void openExternalPage(page)}
        onCheckDevice={checkDeviceConnection}
        onMarkDeviceConnected={() => updateSetup((current) => setDeviceConnection(current, { status: 'connected', name: '小米遥控器 RC003', message: '设备已由用户确认连接。' }))}
        onFinish={() => {
          updateSetup((current) => {
            const next = current.currentStep === 'complete'
              ? current
              : completeSetupStep(current, current.currentStep)
            return completeSetupStep(next, 'complete')
          })
          setSetupOpen(false)
        }}
      />}
    </div>
  )
}

export default App
