import {
  ArrowDown,
  ArrowUp,
  AudioLines,
  Ban,
  BatteryMedium,
  Bluetooth,
  Check,
  CheckCircle2,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  ChevronUp,
  Command,
  Copy,
  Download,
  ExternalLink,
  FolderOpen,
  GripVertical,
  Home,
  Info,
  Keyboard,
  Menu,
  Mic,
  Pencil,
  Power,
  RotateCcw,
  Settings2,
  ShieldCheck,
  Target,
  Trash2,
  Undo2,
  Clock3,
  ClipboardPaste,
  Play,
  Volume1,
  Volume2,
  VolumeX,
  X,
} from 'lucide-react'
import {
  createBehavior,
  createDefaultBehaviorMap,
  moveBehavior,
  parseStoredBehaviors,
  updateBehaviorList,
} from './behaviorModel'
import type { Behavior, BehaviorMap, BehaviorType, ButtonId, TriggerType } from './behaviorModel'
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
import appPackage from '../package.json'
import {
  KeyboardEvent,
  PointerEvent as ReactPointerEvent,
  ReactNode,
  RefObject,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react'

type RemoteButton = {
  id: ButtonId
  label: string
  short: string
  side: 'left' | 'right'
  x: number
  y: number
  icon: 'power' | 'mic' | 'up' | 'left' | 'center' | 'right' | 'down' | 'back' | 'volumeUp' | 'volumeDown' | 'home' | 'menu' | 'tv'
}

type SystemProbe = {
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

type Platform = 'windows' | 'macos' | 'unsupported'

type MacPermissions = {
  inputMonitoring: boolean
  accessibility: boolean
  captureActive: boolean
}

type MacPermissionKind = 'inputMonitoring' | 'accessibility'
type AppPage = 'home' | 'mapping'

const detectBrowserPlatform = (): Platform => {
  if (typeof navigator === 'undefined') return 'windows'
  return /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent) ? 'macos' : 'windows'
}

type RemoteKeyEvent = {
  button: ButtonId
  pressed: boolean
}

type DriverActionResult = {
  logPath: string
}

type AudioProbe = {
  driverInstalled: boolean
  state: 'stopped' | 'driverMissing' | 'bluetoothUnavailable' | 'scanning' | 'connecting' | 'ready' | 'forwarding' | 'error' | 'unknown' | 'unsupported'
  bluetoothConnected: boolean
  forwarding: boolean
  error?: string | null
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  let timer: number | undefined
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_, reject) => {
        timer = window.setTimeout(() => reject(new Error(message)), timeoutMs)
      }),
    ])
  } finally {
    if (timer !== undefined) window.clearTimeout(timer)
  }
}

const buttons: RemoteButton[] = [
  { id: 'power', label: '电源键', short: '电源', side: 'left', x: 18.27, y: 12.06, icon: 'power' },
  { id: 'voice', label: '语音键', short: '语音', side: 'right', x: 66.19, y: 11.50, icon: 'mic' },
  { id: 'up', label: '方向上', short: '上', side: 'left', x: 40.61, y: 24.79, icon: 'up' },
  { id: 'left', label: '方向左', short: '左', side: 'left', x: 12.76, y: 37.30, icon: 'left' },
  { id: 'confirm', label: '确认键', short: '确认', side: 'right', x: 42.23, y: 37.07, icon: 'center' },
  { id: 'right', label: '方向右', short: '右', side: 'right', x: 71.70, y: 36.07, icon: 'right' },
  { id: 'down', label: '方向下', short: '下', side: 'right', x: 40.61, y: 49.02, icon: 'down' },
  { id: 'back', label: '返回键', short: '返回', side: 'left', x: 20.42, y: 61.09, icon: 'back' },
  { id: 'volumeUp', label: '音量加', short: '音量 +', side: 'right', x: 60.42, y: 61.09, icon: 'volumeUp' },
  { id: 'home', label: '主页键', short: '主页', side: 'left', x: 22.80, y: 75.72, icon: 'home' },
  { id: 'volumeDown', label: '音量减', short: '音量 -', side: 'right', x: 60.42, y: 76.85, icon: 'volumeDown' },
  { id: 'menu', label: '功能键', short: '功能', side: 'left', x: 21.18, y: 90.79, icon: 'menu' },
  { id: 'tv', label: '电视键', short: '电视', side: 'right', x: 60.69, y: 91.91, icon: 'tv' },
]

const macOSOnlyButtonIds = new Set<ButtonId>(['back', 'volumeUp', 'volumeDown'])

const settingsStorageKey = 'axonkey.settings.v1'

type StoredSettings = {
  behaviors: BehaviorMap
  enabled: boolean
}

function getStoredSettings(): StoredSettings {
  const fallback = { behaviors: createDefaultBehaviorMap(), enabled: false }
  if (typeof window === 'undefined') return fallback
  try {
    const stored = window.localStorage.getItem(settingsStorageKey)
    if (!stored) return fallback
    const parsed = JSON.parse(stored) as Record<string, unknown>
    return {
      behaviors: parseStoredBehaviors(parsed),
      enabled: parsed.enabled === true,
    }
  } catch {
    return fallback
  }
}

const iconFor = (kind: RemoteButton['icon'], size = 16) => {
  const props = { size, strokeWidth: 1.8 }
  switch (kind) {
    case 'power': return <Power {...props} />
    case 'mic': return <Mic {...props} />
    case 'up': return <ChevronUp {...props} />
    case 'left': return <ChevronLeft {...props} />
    case 'right': return <ChevronRight {...props} />
    case 'down': return <ChevronDown {...props} />
    case 'back': return <Undo2 {...props} />
    case 'volumeUp': return <Volume2 {...props} />
    case 'volumeDown': return <Volume1 {...props} />
    case 'home': return <Home {...props} />
    case 'menu': return <Menu {...props} />
    case 'tv': return <span className="tv-button-glyph" aria-hidden="true">TV</span>
    default: return <Command {...props} />
  }
}

const triggerLabels: Record<TriggerType, string> = {
  click: '单击',
  doubleClick: '双击',
  longPress: '长按',
}

const behaviorTypeLabels: Record<BehaviorType, string> = {
  key: '按键 / 组合键',
  shortcut: '按键 / 组合键',
  paste: '粘贴文本',
  delay: '等待',
  disabled: '禁用按键',
}

type CommonBehaviorPreset =
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

type AdvancedBehaviorType = 'key' | 'paste' | 'delay'

type DraftBehaviorState = {
  behavior: Behavior
  mode: 'replace' | 'append'
}

type CommonBehaviorUndo = {
  buttonId: ButtonId
  trigger: TriggerType
  behaviors: Behavior[]
}

type ManualKeyOption = { value: string; label: string }

const manualKeyGroups: { label: string; options: ManualKeyOption[] }[] = [
  {
    label: '常用按键',
    options: [
      { value: 'Esc', label: 'Esc' }, { value: 'Enter', label: 'Enter' }, { value: 'Space', label: 'Space' },
      { value: 'Tab', label: 'Tab' }, { value: 'Backspace', label: 'Backspace' }, { value: 'Delete', label: 'Delete' },
      { value: 'Insert', label: 'Insert' }, { value: 'Home', label: 'Home' }, { value: 'End', label: 'End' },
      { value: 'PageUp', label: 'Page Up' }, { value: 'PageDown', label: 'Page Down' },
      { value: 'Up', label: '方向上' }, { value: 'Down', label: '方向下' },
      { value: 'Left', label: '方向左' }, { value: 'Right', label: '方向右' },
    ],
  },
  {
    label: '单独修饰键',
    options: [
      { value: 'Ctrl', label: 'Ctrl' }, { value: 'RCtrl', label: '右 Ctrl' },
      { value: 'Shift', label: 'Shift' }, { value: 'RShift', label: '右 Shift' }, { value: 'Alt', label: 'Alt' },
      { value: 'LAlt', label: '左 Alt' }, { value: 'RAlt', label: '右 Alt' },
      { value: 'Win', label: 'Windows' }, { value: 'RWin', label: '右 Windows' },
    ],
  },
  {
    label: '标点符号',
    options: [
      { value: '[', label: '[  左方括号' }, { value: ']', label: ']  右方括号' },
      { value: '\\', label: '\\  反斜杠' }, { value: ';', label: ';  分号' },
      { value: "'", label: "'  单引号" }, { value: ',', label: ',  逗号' },
      { value: '.', label: '.  句点' }, { value: '/', label: '/  斜杠' },
      { value: '-', label: '-  减号' }, { value: '=', label: '=  等号' },
      { value: '`', label: '`  反引号' },
    ],
  },
  {
    label: '媒体按键',
    options: [
      { value: 'VolumeUp', label: '增大音量' }, { value: 'VolumeDown', label: '减小音量' },
      { value: 'VolumeMute', label: '静音' }, { value: 'MediaPlayPause', label: '播放 / 暂停' },
    ],
  },
  {
    label: '字母与数字',
    options: [
      ...[...'ABCDEFGHIJKLMNOPQRSTUVWXYZ'].map((value) => ({ value, label: value })),
      ...[...'0123456789'].map((value) => ({ value, label: value })),
    ],
  },
  {
    label: '功能键',
    options: Array.from({ length: 24 }, (_, index) => ({ value: `F${index + 1}`, label: `F${index + 1}` })),
  },
]

function keyDisplayName(key: string, platform: Platform) {
  if (platform !== 'macos') return key
  const labels: Record<string, string> = {
    Ctrl: 'Control',
    RCtrl: '右 Control',
    RShift: '右 Shift',
    Alt: 'Option',
    LAlt: '左 Option',
    RAlt: '右 Option',
    Win: 'Command',
    RWin: '右 Command',
  }
  return labels[key] ?? key
}

function keyGroupsForPlatform(platform: Platform) {
  if (platform !== 'macos') return manualKeyGroups
  return manualKeyGroups.map((group) => group.label !== '单独修饰键'
    ? group
    : {
      ...group,
      options: group.options.map((option) => ({ ...option, label: keyDisplayName(option.value, platform) })),
    })
}

const shortcutModifiers = ['Ctrl', 'Shift', 'Alt', 'Win']
const standaloneModifierKeys = ['Ctrl', 'RCtrl', 'Shift', 'RShift', 'Alt', 'LAlt', 'RAlt', 'Win', 'RWin']

function isStandaloneModifierKey(key: string) {
  return standaloneModifierKeys.includes(key)
}

function behaviorSummary(behavior: Behavior, platform: Platform) {
  switch (behavior.type) {
    case 'key': return behavior.key ? keyDisplayName(behavior.key, platform) : '未录入'
    case 'shortcut': return behavior.keys.length > 0 ? behavior.keys.map((key) => keyDisplayName(key, platform)).join(' + ') : '未录入'
    case 'paste': return behavior.text ? `粘贴：${behavior.text.slice(0, 12)}` : '粘贴文本'
    case 'delay': return `等待 ${behavior.ms} ms`
    case 'disabled': return '不发送任何按键'
  }
}

function textAndEnterValue(list: Behavior[]) {
  if (list.length !== 3) return null
  const [paste, delay, enter] = list
  if (paste.type !== 'paste' || delay.type !== 'delay' || delay.ms !== 30 || enter.type !== 'key' || enter.key !== 'Enter') return null
  return paste.text
}

function cloneBehaviorList(list: Behavior[]) {
  return list.map((behavior) => behavior.type === 'shortcut'
    ? { ...behavior, keys: [...behavior.keys] }
    : { ...behavior })
}

function triggerSummary(list: Behavior[], trigger: TriggerType, platform: Platform) {
  if (list.length === 0) return trigger === 'click' ? '保留原按键' : '未设置'
  const summary = behaviorSummary(list[0], platform)
  return list.length > 1 ? `${summary} +${list.length - 1}` : summary
}

function formatCapturedKey(event: KeyboardEvent<HTMLElement>) {
  const keyMap: Record<string, string> = {
    ' ': 'Space', Escape: 'Esc', Enter: 'Enter', Tab: 'Tab', Backspace: 'Backspace', Delete: 'Delete',
    ArrowUp: 'Up', ArrowDown: 'Down', ArrowLeft: 'Left', ArrowRight: 'Right', Meta: 'Win', Control: 'Ctrl',
    Shift: 'Shift', Alt: 'Alt', PageUp: 'PageUp', PageDown: 'PageDown', Home: 'Home', End: 'End',
  }
  let key = keyMap[event.key] ?? (event.key.length === 1 ? event.key.toUpperCase() : event.key)
  if (['Ctrl', 'Shift', 'Alt', 'Win'].includes(key)) return ''
  const modifiers = [event.ctrlKey ? 'Ctrl' : '', event.shiftKey ? 'Shift' : '', event.altKey ? 'Alt' : '', event.metaKey ? 'Win' : ''].filter(Boolean)
  return [...modifiers, key].join('+')
}

function behaviorFromCapturedKey(captured: string, id?: string) {
  const keys = captured.split('+')
  return keys.length > 1
    ? createBehavior({ type: 'shortcut', keys, id })
    : createBehavior({ type: 'key', key: captured, id })
}

type Connector = { id: ButtonId; side: 'left' | 'right'; x1: number; y1: number; x2: number; y2: number }
type HitPosition = { x: number; y: number }

const initialHitPositions: Record<ButtonId, HitPosition> = {
  power: { x: 18.27, y: 12.06 },
  voice: { x: 66.19, y: 11.50 },
  up: { x: 40.61, y: 24.79 },
  left: { x: 12.76, y: 37.30 },
  confirm: { x: 42.23, y: 37.07 },
  right: { x: 71.70, y: 36.07 },
  down: { x: 40.61, y: 49.02 },
  back: { x: 20.42, y: 61.09 },
  volumeUp: { x: 60.42, y: 61.09 },
  home: { x: 22.80, y: 75.72 },
  volumeDown: { x: 60.42, y: 76.85 },
  menu: { x: 21.18, y: 90.79 },
  tv: { x: 60.69, y: 91.91 },
}

const hitPositionsStorageKey = 'axonkey.debug-hit-positions.v2'

function getStoredHitPositions() {
  if (typeof window === 'undefined') return initialHitPositions
  try {
    const stored = window.localStorage.getItem(hitPositionsStorageKey)
    if (!stored) return initialHitPositions
    return { ...initialHitPositions, ...JSON.parse(stored) } as Record<ButtonId, HitPosition>
  } catch {
    return initialHitPositions
  }
}

function App() {
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
  const [pressedId, setPressedId] = useState<ButtonId | null>(null)
  const workspaceRef = useRef<HTMLDivElement>(null)
  const behaviorEditorRef = useRef<HTMLElement>(null)
  const remoteArtRef = useRef<HTMLDivElement>(null)
  const coordinateTextRef = useRef<HTMLTextAreaElement>(null)
  const markerRefs = useRef<Partial<Record<ButtonId, HTMLButtonElement>>>({})
  const rowRefs = useRef<Partial<Record<ButtonId, HTMLDivElement>>>({})
  const brandClickRef = useRef({ count: 0, lastAt: 0 })
  const saveRevisionRef = useRef(0)
  const audioProbeRunningRef = useRef(false)
  const systemProbeRunningRef = useRef(false)
  const deviceProbeRunningRef = useRef(false)
  const batteryProbeRunningRef = useRef(false)
  const pressedClearTimerRef = useRef<number | undefined>(undefined)
  const behaviorAttentionTimerRef = useRef<number | undefined>(undefined)
  const [connectors, setConnectors] = useState<Connector[]>([])
  const [behaviorEditorAttention, setBehaviorEditorAttention] = useState(false)

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

  const measureConnectors = useCallback(() => {
    if (!workspaceRef.current) return
    const workspace = workspaceRef.current.getBoundingClientRect()
    const next = editableButtons.flatMap((button) => {
      const marker = markerRefs.current[button.id]
      const row = rowRefs.current[button.id]
      if (!marker || !row) return []
      const markerRect = marker.getBoundingClientRect()
      const rowRect = row.getBoundingClientRect()
      return [{
        id: button.id,
        side: button.side,
        x1: markerRect.left + markerRect.width / 2 - workspace.left,
        y1: markerRect.top + markerRect.height / 2 - workspace.top,
        x2: button.side === 'left'
          ? rowRect.right - workspace.left + 10
          : rowRect.left - workspace.left - 10,
        y2: rowRect.top + rowRect.height / 2 - workspace.top,
      }]
    })
    setConnectors(next)
  }, [editableButtons])

  useLayoutEffect(() => {
    measureConnectors()
    const observer = new ResizeObserver(measureConnectors)
    if (workspaceRef.current) observer.observe(workspaceRef.current)
    window.addEventListener('resize', measureConnectors)
    return () => {
      observer.disconnect()
      window.removeEventListener('resize', measureConnectors)
    }
  }, [measureConnectors, activeId, behaviors, debugMode])

  useLayoutEffect(() => {
    measureConnectors()
  }, [hitPositions, measureConnectors])

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
      if (!document.hasFocus() || !buttons.some((button) => button.id === event.payload.button)) return
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

  const connectedCount = editableButtons.reduce((count, button) => count + Object.values(behaviors[button.id]).reduce((total, list) => total + list.length, 0), 0)

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
      return true
    } catch (error) {
      if (showChecking) {
        updateSetup((current) => {
          const next = setDriverStatus(current, 'input', 'error', { message: `按键驱动检测失败：${String(error)}` })
          return setDeviceConnection(next, { status: 'error', message: String(error) })
        })
      }
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
    <div className="app-shell">
      <main className="main-content">
        <header className="topbar">
          <div className="topbar-left">
            <button className="brand-lockup compact brand-trigger" type="button" aria-label="Axonkey" title="Axonkey" onClick={handleBrandClick}>
              <span className="brand-mark">A</span>
              <span>
                <span className="brand-name">axonkey</span>
                <span className="brand-version">RC003 控制台 <span>{appPackage.version}</span></span>
              </span>
            </button>
            <div className="title-row"><h1>{activePage === 'home' ? '主页' : '按键映射'}</h1><span className="title-divider" /><span className="title-hint">RC003</span></div>
          </div>
          <nav className="app-nav" aria-label="主导航">
            <button type="button" className={activePage === 'home' ? 'active' : ''} onClick={() => setActivePage('home')}><Home size={15} /> 主页</button>
            <button type="button" className={activePage === 'mapping' ? 'active' : ''} onClick={() => setActivePage('mapping')}><Keyboard size={15} /> 按键映射</button>
          </nav>
          <div className="header-actions">
            <label className="enable-control"><span>启用自定义按键功能</span><button className={`switch ${enabled ? 'on' : ''}`} type="button" aria-pressed={enabled} onClick={toggleEnabled}><span /></button></label>
          </div>
        </header>

        {activePage === 'mapping' ? <>
        <div className="toolbar-row">
          <div className="toolbar-context"><span className="toolbar-context-mark" /> 选择按键，设置不同的触发行为</div>
          <div className="toolbar-meta"><span>{connectedCount} 个自定义行为</span><span className="toolbar-divider" /><span className={`auto-save-state ${autoSaveState}`}><Check size={13} /> {autoSaveState === 'saving' ? '保存中' : '已自动保存'}</span>{debugMode && <><span className="toolbar-divider" /><span className="debug-status"><Target size={13} /> 调试模式</span><span className="debug-hint">拖动图上的点调整连线起点</span><button type="button" className="reset-button" onClick={() => void copyHitPositions()}><Copy size={13} /> 复制坐标</button><button type="button" className="reset-button" onClick={resetHitPositions}><RotateCcw size={13} /> 恢复点位</button></>}<button type="button" className="reset-button" onClick={resetMappings}><RotateCcw size={14} /> 恢复默认</button></div>
        </div>

        <div className={`workspace ${debugMode ? 'debug-mode' : ''}`} ref={workspaceRef}>
          <MappingSide
            platform={platform}
            side="left"
            buttons={editableButtons.filter((button) => button.side === 'left')}
            behaviors={behaviors}
            activeId={activeId}
            pressedId={pressedId}
            selectedBehavior={selectedBehavior}
            rowRefs={rowRefs}
            selectBehaviorTarget={selectBehaviorTarget}
          />

          <section className="remote-panel panel-surface">
            <button type="button" className="device-card remote-device-card" onClick={() => openSetupStep(inputAuthorizationStale ? 'inputDriver' : 'deviceConnection')}><div className="device-card-head"><strong>小米遥控器</strong>{inputAuthorizationStale ? <Info className="device-icon warning" size={16} /> : setupState.device.status === 'connected' ? <CheckCircle2 className="device-icon" size={16} /> : <Bluetooth className="device-icon" size={16} />}</div><div className="device-card-meta"><span className={`device-state-dot ${setupState.device.status === 'connected' ? 'connected' : ''}`} /> <span>{setupState.device.status === 'connected' ? '已连接' : '未连接'}</span><BatteryMedium size={14} /><span className={`battery-level ${batteryLevel !== null && batteryLevel <= 20 ? 'low' : ''}`}>{batteryLevel === null ? '电量未知' : `${batteryLevel}%`}</span><span className="device-meta-separator" /><span>{inputAuthorizationStale ? '按键权限需重新授权' : platform === 'macos' ? '设备与权限' : '设备与驱动'}</span></div></button>
            <div className="remote-stage">
              <div className="remote-art" ref={remoteArtRef}>
                <img src="/rc003-remote-cutout.png" alt="小米 RC003 遥控器" />
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
            <div className="remote-caption"><span className="caption-line" /> 点击按键查看对应行为</div>
          </section>

          <MappingSide
            platform={platform}
            side="right"
            buttons={editableButtons.filter((button) => button.side === 'right')}
            behaviors={behaviors}
            activeId={activeId}
            pressedId={pressedId}
            selectedBehavior={selectedBehavior}
            rowRefs={rowRefs}
            selectBehaviorTarget={selectBehaviorTarget}
          />

          <svg className="connector-layer" aria-hidden="true">
            {connectors.map((line) => {
              const selected = line.id === activeId
              const pressed = line.id === pressedId
              const elbow = line.side === 'left'
                ? Math.min(line.x1 - 34, line.x2 + 32)
                : Math.max(line.x1 + 34, line.x2 - 32)
              return <g key={line.id} className={`connector ${selected ? 'selected' : ''} ${pressed ? 'pressed' : ''}`}>
                <path d={`M ${line.x1} ${line.y1} C ${elbow} ${line.y1}, ${elbow} ${line.y2}, ${line.x2} ${line.y2}`} />
                <circle cx={line.x1} cy={line.y1} r={selected ? 4 : 2.5} />
                <circle cx={line.x2} cy={line.y2} r={selected ? 3.5 : 2} />
              </g>
            })}
          </svg>
        </div>
        {platform !== 'macos' && <div className="mapping-limit-note" role="note">
          <Info size={12} aria-hidden="true" />
          <span>返回键和独立音量 + / - 键暂不可配置：Windows 无法可靠区分这些按键来自哪台设备，强制映射可能影响其他键盘或遥控器。</span>
        </div>}
        <BehaviorEditor
          editorRef={behaviorEditorRef}
          attention={behaviorEditorAttention}
          platform={platform}
          button={editableButtons.find((button) => button.id === selectedBehavior.buttonId) ?? editableButtons[0]}
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
        <footer className="main-footer"><span>Axonkey 仅修改 RC003 遥控器输入，不影响普通键盘。</span><span className="footer-key"><Command size={12} /> 本地配置</span></footer>
        </> : <HomeDashboard
          platform={platform}
          permissions={macPermissions}
          inputAuthorizationStale={inputAuthorizationStale}
          inputDriver={setupState.drivers.input}
          audioDriver={setupState.drivers.audio}
          device={setupState.device}
          batteryLevel={batteryLevel}
          enabled={enabled}
          onRequestPermission={(kind) => void requestMacPermission(kind)}
          onRefresh={() => { void probeSystemState(false); void probeAudioState() }}
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

type HomeDashboardProps = {
  platform: Platform
  permissions: MacPermissions
  inputAuthorizationStale: boolean
  inputDriver: SetupState['drivers']['input']
  audioDriver: SetupState['drivers']['audio']
  device: SetupState['device']
  batteryLevel: number | null
  enabled: boolean
  onRequestPermission: (kind: MacPermissionKind) => void
  onRefresh: () => void
  onOpenStep: (step: SetupStepId) => void
  onOpenMapping: () => void
}

type HomeStatusTone = 'ready' | 'warning' | 'error' | 'checking' | 'muted'

type HomeStatusCardProps = {
  icon: ReactNode
  title: string
  status: string
  detail: string
  tone: HomeStatusTone
  action?: ReactNode
}

function HomeStatusCard({ icon, title, status, detail, tone, action }: HomeStatusCardProps) {
  return <article className={`home-status-card ${tone}`}>
    <div className="home-status-card-head">
      <span className="home-status-icon">{icon}</span>
      <div><h3>{title}</h3><span className="home-status-label"><span className="home-status-dot" />{status}</span></div>
    </div>
    <p>{detail}</p>
    {action && <div className="home-status-action">{action}</div>}
  </article>
}

function driverStatusPresentation(status: SetupState['drivers']['audio']['status']): { label: string; tone: HomeStatusTone } {
  switch (status) {
    case 'installed': return { label: '已安装', tone: 'ready' }
    case 'restartRequired': return { label: '需要重启', tone: 'warning' }
    case 'checking': return { label: '检测中', tone: 'checking' }
    case 'error': return { label: '检测失败', tone: 'error' }
    case 'missing': return { label: '未安装', tone: 'warning' }
    default: return { label: '未检测', tone: 'muted' }
  }
}

function HomeDashboard({
  platform,
  permissions,
  inputAuthorizationStale,
  inputDriver,
  audioDriver,
  device,
  batteryLevel,
  enabled,
  onRequestPermission,
  onRefresh,
  onOpenStep,
  onOpenMapping,
}: HomeDashboardProps) {
  const macOS = platform === 'macos'
  const inputReady = macOS && permissions.inputMonitoring && !inputAuthorizationStale
  const inputTone: HomeStatusTone = inputAuthorizationStale || inputDriver.status === 'error'
    ? 'error'
    : inputReady || (!macOS && inputDriver.status === 'installed')
      ? 'ready'
      : inputDriver.status === 'checking' ? 'checking' : 'warning'
  const inputStatus = inputAuthorizationStale
    ? '需要重新授权'
    : inputReady || (!macOS && inputDriver.status === 'installed')
      ? '已授权'
      : macOS ? '未授权' : inputDriver.status === 'checking' ? '检测中' : '需要检查'
  const inputDetail = inputAuthorizationStale
    ? '当前构建的输入监控授权已失效，电源键、返回键等映射不会收到按键。'
    : inputDriver.message ?? (macOS ? '允许 Axonkey 读取 RC003 原始 HID 按键报告。' : '检查 OpenInputBridge 按键服务。')
  const audioPresentation = driverStatusPresentation(audioDriver.status)
  const deviceConnected = device.status === 'connected'
  const deviceTone: HomeStatusTone = deviceConnected ? 'ready' : device.status === 'checking' ? 'checking' : 'warning'
  const deviceStatus = deviceConnected ? '已连接' : device.status === 'checking' ? '检测中' : '未连接'
  const deviceDetail = deviceConnected
    ? `${device.message ?? 'RC003 已被系统识别。'}${batteryLevel === null ? '' : ` 当前电量 ${batteryLevel}%。`}`
    : device.message ?? '请在系统蓝牙设置中配对并唤醒 RC003。'
  const accessibilityReady = !macOS || permissions.accessibility
  const allReady = inputTone === 'ready' && accessibilityReady && audioPresentation.tone === 'ready' && deviceTone === 'ready'

  return <div className="home-page">
    <section className={`home-summary ${allReady ? 'ready' : 'attention'}`}>
      <div className="home-summary-icon">{allReady ? <CheckCircle2 size={24} /> : <ShieldCheck size={24} />}</div>
      <div className="home-summary-copy"><span className="section-kicker">SYSTEM STATUS</span><h2>{allReady ? '运行环境已就绪' : '有项目需要处理'}</h2><p>{allReady ? '权限、设备和音频通道均已检查，可以直接使用 RC003。' : inputAuthorizationStale ? '请重新授权当前 Axonkey 构建，按键映射才能恢复。' : '从下方状态卡处理缺失的权限、驱动或设备连接。'}</p></div>
      <button type="button" className="button home-refresh-button" onClick={onRefresh}><RotateCcw size={15} /> 重新检测</button>
    </section>

    <div className="home-status-grid">
      <HomeStatusCard
        icon={<Keyboard size={19} />}
        title="输入监控"
        status={inputStatus}
        tone={inputTone}
        detail={inputDetail}
        action={macOS
          ? <button type="button" className="dialog-secondary" onClick={() => onRequestPermission('inputMonitoring')}><ShieldCheck size={14} /> {inputAuthorizationStale ? '重新授权' : permissions.inputMonitoring ? '重新打开设置' : '开始授权'}</button>
          : <button type="button" className="dialog-secondary" onClick={() => onOpenStep('inputDriver')}><Settings2 size={14} /> 检查驱动</button>}
      />
      <HomeStatusCard
        icon={<Command size={19} />}
        title="辅助功能"
        status={macOS ? permissions.accessibility ? '已授权' : '未授权' : '系统不需要'}
        tone={macOS ? permissions.accessibility ? 'ready' : 'warning' : 'muted'}
        detail={macOS ? '允许 Axonkey 发送映射后的按键、快捷键和文本。' : 'Windows 通过输入服务发送映射结果。'}
        action={macOS && <button type="button" className="dialog-secondary" onClick={() => onRequestPermission('accessibility')}><ShieldCheck size={14} /> {permissions.accessibility ? '重新打开设置' : '开始授权'}</button>}
      />
      <HomeStatusCard
        icon={<AudioLines size={19} />}
        title={macOS ? 'MiRemoteV 2ch' : 'VB-CABLE 虚拟麦克风'}
        status={audioPresentation.label}
        tone={audioPresentation.tone}
        detail={audioDriver.message ?? (macOS ? '用于把 RC003 语音转发到系统音频输入。' : '用于提供 CABLE Output 虚拟录音设备。')}
        action={<button type="button" className="dialog-secondary" onClick={onRefresh}><RotateCcw size={14} /> 重新检测</button>}
      />
      <HomeStatusCard
        icon={<Bluetooth size={19} />}
        title="小米遥控器 RC003"
        status={deviceStatus}
        tone={deviceTone}
        detail={deviceDetail}
        action={<button type="button" className="dialog-secondary" onClick={() => onOpenStep('deviceConnection')}><Bluetooth size={14} /> 连接设置</button>}
      />
    </div>

    <section className="home-tools">
      <div><span className="section-kicker">QUICK ACCESS</span><h2>常用入口</h2></div>
      <div className="home-tool-actions">
        <button type="button" className="home-tool-button" onClick={onOpenMapping}><Keyboard size={17} /><span><strong>按键映射</strong><small>{enabled ? '自定义功能已启用' : '自定义功能未启用'}</small></span><ChevronRight size={16} /></button>
        <button type="button" className="home-tool-button" onClick={() => onOpenStep('inputDriver')}><Settings2 size={17} /><span><strong>完整设置</strong><small>权限、驱动与设备检测</small></span><ChevronRight size={16} /></button>
      </div>
    </section>
  </div>
}

type MappingSideProps = {
  platform: Platform
  side: 'left' | 'right'
  buttons: RemoteButton[]
  behaviors: BehaviorMap
  activeId: ButtonId
  pressedId: ButtonId | null
  selectedBehavior: { buttonId: ButtonId; trigger: TriggerType }
  rowRefs: { current: Partial<Record<ButtonId, HTMLDivElement>> }
  selectBehaviorTarget: (buttonId: ButtonId, trigger: TriggerType) => void
}

function MappingSide({ platform, side, buttons: sideButtons, behaviors, activeId, pressedId, selectedBehavior, rowRefs, selectBehaviorTarget }: MappingSideProps) {
  return <section className={`mapping-side panel-surface ${side}`}>
    <div className="mapping-list">
      {sideButtons.map((button) => (
        <MappingRow
          key={button.id}
          platform={platform}
          button={button}
          behaviors={behaviors[button.id]}
          active={activeId === button.id}
          pressed={pressedId === button.id}
          selectedTrigger={selectedBehavior.buttonId === button.id ? selectedBehavior.trigger : null}
          rowRef={(node) => { if (node) rowRefs.current[button.id] = node }}
          onSelect={() => selectBehaviorTarget(button.id, 'click')}
          onSelectTrigger={(trigger) => selectBehaviorTarget(button.id, trigger)}
        />
      ))}
    </div>
  </section>
}

type MappingRowProps = {
  platform: Platform
  button: RemoteButton
  behaviors: Record<TriggerType, Behavior[]>
  active: boolean
  pressed: boolean
  selectedTrigger: TriggerType | null
  rowRef: (node: HTMLDivElement | null) => void
  onSelect: () => void
  onSelectTrigger: (trigger: TriggerType) => void
}

function MappingRow({ platform, button, behaviors, active, pressed, selectedTrigger, rowRef, onSelect, onSelectTrigger }: MappingRowProps) {
  const triggerOrder: TriggerType[] = ['click', 'doubleClick', 'longPress']
  const hasBehavior = triggerOrder.some((trigger) => behaviors[trigger].length > 0)
  return <article ref={rowRef} className={`mapping-card ${active ? 'active' : ''} ${pressed ? 'pressed' : ''}`} onClick={onSelect}>
    <div className="mapping-card-title"><span className={`row-icon icon-${button.icon}`}>{iconFor(button.icon, 17)}</span><strong>{button.label}</strong><span className="card-status">{hasBehavior ? '已设置' : '默认'}</span></div>
    <div className="action-slots">
      {triggerOrder.map((trigger) => {
        const selected = selectedTrigger === trigger
        const list = behaviors[trigger]
        return <button
          key={trigger}
          type="button"
          className={`action-slot ${list.length === 0 ? 'muted' : 'configured'} ${selected ? 'selected' : ''}`}
          aria-label={`${button.label}${triggerLabels[trigger]}行为`}
          onClick={(event) => { event.stopPropagation(); onSelectTrigger(trigger) }}
        >
          <span className="slot-label">{triggerLabels[trigger]}</span>
          <Keyboard size={14} className="slot-icon" />
          <strong>{triggerSummary(list, trigger, platform)}</strong>
        </button>
      })}
    </div>
  </article>
}

type BehaviorEditorProps = {
  editorRef: RefObject<HTMLElement>
  attention: boolean
  platform: Platform
  button: RemoteButton
  trigger: TriggerType
  behaviors: Behavior[]
  canUndoCommonBehavior: boolean
  onApplyCommonBehavior: (preset: CommonBehaviorPreset) => void
  onUndoCommonBehavior: () => void
  onAddAdvancedBehavior: (type: AdvancedBehaviorType) => void
  onRemoveBehavior: (behaviorId: string) => void
  onMoveBehavior: (behaviorId: string, direction: -1 | 1) => void
  onEditBehavior: (behaviorId: string) => void
  onReturnToMappings: () => void
}

type BehaviorEditorTab = 'common' | 'navigation' | 'media' | 'advanced'

type BehaviorActionButtonProps = {
  icon: ReactNode
  label: string
  detail: string
  onClick: () => void
}

function BehaviorActionButton({ icon, label, detail, onClick }: BehaviorActionButtonProps) {
  return <button type="button" className="behavior-action-button" onClick={onClick}>
    <span className="behavior-action-icon">{icon}</span>
    <span className="behavior-action-copy"><strong>{label}</strong><small>{detail}</small></span>
  </button>
}

function BehaviorEditor({ editorRef, attention, platform, button, trigger, behaviors, canUndoCommonBehavior, onApplyCommonBehavior, onUndoCommonBehavior, onAddAdvancedBehavior, onRemoveBehavior, onMoveBehavior, onEditBehavior, onReturnToMappings }: BehaviorEditorProps) {
  const [activeTab, setActiveTab] = useState<BehaviorEditorTab>('common')
  const tabId = `behavior-${button.id}-${trigger}`
  return <section ref={editorRef} className={`behavior-editor ${attention ? 'attention' : ''}`} aria-label={`${button.label}${triggerLabels[trigger]}行为配置`}>
    <div className="behavior-editor-head">
      <div className="behavior-editor-title">
        <span className={`row-icon icon-${button.icon}`}>{iconFor(button.icon, 17)}</span>
        <div><h2>{button.label} · {triggerLabels[trigger]}</h2><p>按顺序执行下面的行为，支持连续组合</p></div>
        <span className="behavior-trigger-pill"><GripVertical size={13} /> {behaviors.length ? `${behaviors.length} 个行为` : '尚未配置'}</span>
      </div>
      <div className="behavior-editor-head-actions">
        <div className="behavior-tabs" role="tablist" aria-label="行为分类">
          {([
            ['common', '常用'],
            ['navigation', '导航编辑'],
            ['media', '媒体控制'],
            ['advanced', '追加步骤'],
          ] as const).map(([id, label]) => <button
            key={id}
            id={`${tabId}-${id}-tab`}
            type="button"
            role="tab"
            aria-selected={activeTab === id}
            aria-controls={`${tabId}-${id}-panel`}
            className={activeTab === id ? 'active' : ''}
            onClick={() => setActiveTab(id)}
          >{label}</button>)}
        </div>
        <button type="button" className="icon-button behavior-return-button" title="返回按键总览" aria-label="返回按键总览" onClick={onReturnToMappings}><ArrowUp size={15} /></button>
      </div>
    </div>
    <div className="behavior-editor-body">
      <section className="behavior-current-panel" aria-labelledby={`${tabId}-current-title`}>
        <div className="behavior-column-heading">
          <h3 id={`${tabId}-current-title`}>现有行为</h3>
        </div>
        <div className="behavior-list">
          {behaviors.length === 0 && <div className="behavior-empty">{trigger === 'click' ? '当前保留原按键，可从右侧直接更改行为' : '这个触发方式尚未设置，可从右侧直接选择行为'}</div>}
          {behaviors.map((behavior, index) => <BehaviorItem
            platform={platform}
            key={behavior.id}
            behavior={behavior}
            index={index}
            total={behaviors.length}
            onRemove={onRemoveBehavior}
            onMove={onMoveBehavior}
            onEdit={onEditBehavior}
          />)}
        </div>
      </section>
      <section className="behavior-actions" aria-label="选择行为">
        <div className="behavior-column-heading">
          <h3>推荐行为</h3>
          {canUndoCommonBehavior && <button type="button" className="behavior-undo-button" onClick={onUndoCommonBehavior}><RotateCcw size={12} /> 取消</button>}
        </div>
        <div
          id={`${tabId}-${activeTab}-panel`}
          role="tabpanel"
          aria-labelledby={`${tabId}-${activeTab}-tab`}
          className="behavior-action-grid"
        >
          {activeTab === 'common' && <>
            <BehaviorActionButton icon={<RotateCcw size={17} />} label={trigger === 'click' ? '保留原按键' : '清除触发方式'} detail={trigger === 'click' ? '使用遥控器原始输入' : '移除当前触发行为'} onClick={() => onApplyCommonBehavior('original')} />
            <BehaviorActionButton icon={<Ban size={17} />} label="禁用按键" detail="不发送任何输入" onClick={() => onApplyCommonBehavior('disabled')} />
            <BehaviorActionButton icon={<kbd>Esc</kbd>} label="Escape" detail="返回或关闭" onClick={() => onApplyCommonBehavior('escape')} />
            <BehaviorActionButton icon={<kbd>Enter</kbd>} label="Enter" detail="确认或提交" onClick={() => onApplyCommonBehavior('enter')} />
            <BehaviorActionButton icon={<kbd>Space</kbd>} label="空格" detail="空格键" onClick={() => onApplyCommonBehavior('space')} />
            <BehaviorActionButton icon={<ClipboardPaste size={17} />} label="输入文本并回车" detail="粘贴 · 30 ms · Enter" onClick={() => onApplyCommonBehavior('textAndEnter')} />
            <BehaviorActionButton icon={<Keyboard size={17} />} label="其他按键 / 组合键" detail="直接录入目标按键" onClick={() => onApplyCommonBehavior('customKey')} />
          </>}
          {activeTab === 'navigation' && <>
            <BehaviorActionButton icon={<kbd>↑</kbd>} label="方向上" detail="Up" onClick={() => onApplyCommonBehavior('arrowUp')} />
            <BehaviorActionButton icon={<kbd>↓</kbd>} label="方向下" detail="Down" onClick={() => onApplyCommonBehavior('arrowDown')} />
            <BehaviorActionButton icon={<kbd>←</kbd>} label="方向左" detail="Left" onClick={() => onApplyCommonBehavior('arrowLeft')} />
            <BehaviorActionButton icon={<kbd>→</kbd>} label="方向右" detail="Right" onClick={() => onApplyCommonBehavior('arrowRight')} />
            <BehaviorActionButton icon={<kbd>Tab</kbd>} label="Tab" detail="切换焦点" onClick={() => onApplyCommonBehavior('tab')} />
            <BehaviorActionButton icon={<kbd>Back</kbd>} label="Backspace" detail="向前删除" onClick={() => onApplyCommonBehavior('backspace')} />
            <BehaviorActionButton icon={<kbd>Del</kbd>} label="Delete" detail="向后删除" onClick={() => onApplyCommonBehavior('delete')} />
            <BehaviorActionButton icon={<kbd>Home</kbd>} label="Home" detail="跳到开头" onClick={() => onApplyCommonBehavior('keyHome')} />
            <BehaviorActionButton icon={<kbd>End</kbd>} label="End" detail="跳到结尾" onClick={() => onApplyCommonBehavior('keyEnd')} />
            <BehaviorActionButton icon={<kbd>PgUp</kbd>} label="Page Up" detail="向上翻页" onClick={() => onApplyCommonBehavior('pageUp')} />
            <BehaviorActionButton icon={<kbd>PgDn</kbd>} label="Page Down" detail="向下翻页" onClick={() => onApplyCommonBehavior('pageDown')} />
          </>}
          {activeTab === 'media' && <>
            <BehaviorActionButton icon={<Play size={17} />} label="播放 / 暂停" detail="媒体播放控制" onClick={() => onApplyCommonBehavior('mediaPlayPause')} />
            <BehaviorActionButton icon={<Volume2 size={17} />} label="增大音量" detail="系统音量 +" onClick={() => onApplyCommonBehavior('volumeUp')} />
            <BehaviorActionButton icon={<Volume1 size={17} />} label="减小音量" detail="系统音量 -" onClick={() => onApplyCommonBehavior('volumeDown')} />
            <BehaviorActionButton icon={<VolumeX size={17} />} label="静音" detail="切换系统静音" onClick={() => onApplyCommonBehavior('volumeMute')} />
          </>}
          {activeTab === 'advanced' && <>
            <BehaviorActionButton icon={<Keyboard size={17} />} label="按键 / 组合键" detail="追加到行为序列" onClick={() => onAddAdvancedBehavior('key')} />
            <BehaviorActionButton icon={<ClipboardPaste size={17} />} label="粘贴文本" detail="追加到行为序列" onClick={() => onAddAdvancedBehavior('paste')} />
            <BehaviorActionButton icon={<Clock3 size={17} />} label="等待" detail="追加到行为序列" onClick={() => onAddAdvancedBehavior('delay')} />
          </>}
        </div>
      </section>
    </div>
  </section>
}

type BehaviorItemProps = {
  platform: Platform
  behavior: Behavior
  index: number
  total: number
  onRemove: (behaviorId: string) => void
  onMove: (behaviorId: string, direction: -1 | 1) => void
  onEdit: (behaviorId: string) => void
}

function BehaviorItem({ platform, behavior, index, total, onRemove, onMove, onEdit }: BehaviorItemProps) {
  const editable = behavior.type !== 'disabled'
  return <div className="behavior-item">
    <span className="behavior-item-index">{String(index + 1).padStart(2, '0')}</span>
    <button type="button" className="behavior-item-summary" disabled={!editable} onClick={() => onEdit(behavior.id)}>
      <span className="behavior-type-label">{behaviorTypeLabels[behavior.type]}</span>
      <strong>{behaviorSummary(behavior, platform)}</strong>
      <span className="behavior-type-note">{editable ? '点击编辑' : '不发送输入'}</span>
    </button>
    <div className="behavior-item-actions">
      {editable && <button type="button" className="icon-button" title="编辑" aria-label="编辑行为" onClick={() => onEdit(behavior.id)}><Pencil size={14} /></button>}
      <button type="button" className="icon-button" title="上移" aria-label="上移行为" disabled={index === 0} onClick={() => onMove(behavior.id, -1)}><ArrowUp size={14} /></button>
      <button type="button" className="icon-button" title="下移" aria-label="下移行为" disabled={index === total - 1} onClick={() => onMove(behavior.id, 1)}><ArrowDown size={14} /></button>
      <button type="button" className="icon-button" title="删除" aria-label="删除行为" onClick={() => onRemove(behavior.id)}><Trash2 size={14} /></button>
    </div>
  </div>
}

type BehaviorEditDialogProps = {
  platform: Platform
  button: RemoteButton
  trigger: TriggerType
  behavior: Behavior
  capturing: boolean
  draft?: boolean
  onStartCapture: () => void
  onCancelCapture: () => void
  onCaptureKey: (behavior: Behavior, event: KeyboardEvent<HTMLElement>) => void
  onUpdate: (update: (behavior: Behavior) => Behavior) => void
  onClose: () => void
  onSave?: () => void
}

function ManualKeySelect({ platform, value, onChange, label, includeModifiers = true }: { platform: Platform; value: string; onChange: (value: string) => void; label: string; includeModifiers?: boolean }) {
  const platformGroups = keyGroupsForPlatform(platform)
  const groups = includeModifiers ? platformGroups : platformGroups.filter((group) => group.label !== '单独修饰键')
  const knownValue = groups.some((group) => group.options.some((option) => option.value === value)) ? value : ''
  return <select value={knownValue} aria-label={label} onChange={(event) => onChange(event.target.value)}>
    <option value="" disabled>{value && !knownValue ? `当前：${value}` : '选择按键'}</option>
    {groups.map((group) => <optgroup key={group.label} label={group.label}>
      {group.options.map((option) => <option key={`${group.label}-${option.value}`} value={option.value}>{option.label}</option>)}
    </optgroup>)}
  </select>
}

function BehaviorEditDialog({ platform, button, trigger, behavior, capturing, draft = false, onStartCapture, onCancelCapture, onCaptureKey, onUpdate, onClose, onSave }: BehaviorEditDialogProps) {
  const captureValue = behavior.type === 'shortcut'
    ? behavior.keys.map((key) => keyDisplayName(key, platform)).join(' + ')
    : behavior.type === 'key' ? keyDisplayName(behavior.key, platform) : ''
  const shortcutKeys = behavior.type === 'shortcut' ? behavior.keys : []
  const selectedShortcutModifiers = shortcutModifiers.filter((modifier) => shortcutKeys.includes(modifier))
  const shortcutBase = behavior.type === 'key'
    ? behavior.key
    : shortcutKeys.find((key) => !shortcutModifiers.includes(key))
      ?? (shortcutKeys.length === 1 && isStandaloneModifierKey(shortcutKeys[0]) ? shortcutKeys[0] : 'C')
  const standaloneBase = isStandaloneModifierKey(shortcutBase)
  const setShortcut = (modifiers: string[], base: string) => {
    const selectedModifiers = isStandaloneModifierKey(base) ? [] : modifiers.filter((modifier) => modifier !== base)
    onUpdate((current) => current.type === 'key' || current.type === 'shortcut'
      ? selectedModifiers.length > 0
        ? { id: current.id, enabled: current.enabled, type: 'shortcut', keys: [...selectedModifiers, base] }
        : { id: current.id, enabled: current.enabled, type: 'key', key: base }
      : current)
  }
  const canSave = behavior.type === 'key'
    ? Boolean(behavior.key)
    : behavior.type === 'shortcut'
      ? behavior.keys.length > 0
      : behavior.type === 'paste'
        ? Boolean(behavior.text.trim())
        : true
  return <div className="behavior-dialog-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose() }}>
    <section
      className="behavior-dialog"
      role="dialog"
      aria-modal="true"
      aria-labelledby="behavior-dialog-title"
      onKeyDown={(event) => { if (capturing) onCaptureKey(behavior, event) }}
    >
      <header className="behavior-dialog-head">
        <div><span className="section-kicker">{button.label} · {triggerLabels[trigger]}</span><h2 id="behavior-dialog-title">{draft ? '添加' : '编辑'}{behaviorTypeLabels[behavior.type]}行为</h2></div>
        <button type="button" className="dialog-close" aria-label="关闭编辑" onClick={onClose}><X size={17} /></button>
      </header>
      <div className="behavior-dialog-body">
        {behavior.type === 'key' || behavior.type === 'shortcut' ? <>
          <div className="behavior-current-value"><span>当前按键</span><strong>{captureValue || '未设置'}</strong></div>
          <div className="behavior-record-row">
            <button type="button" autoFocus={draft && capturing} className={`record-key-button ${capturing ? 'capturing' : ''}`} onClick={capturing ? onCancelCapture : onStartCapture}>
              <Keyboard size={17} />
              <span><strong>{capturing ? '等待按键输入…' : '开始录入'}</strong><small>{capturing ? '现在按下目标按键或组合键' : '仅在点击后监听下一次按键'}</small></span>
            </button>
          </div>
          <div className="behavior-manual-section">
            <div className="behavior-field-title"><strong>手动选择</strong><span>{standaloneBase ? '当前仅发送这个按键' : '录入不到时直接从列表设置'}</span></div>
            <div className={`shortcut-manual-builder ${standaloneBase ? 'standalone' : ''}`}>
              <div className="shortcut-modifiers">
                {shortcutModifiers.map((modifier) => {
                  const selected = selectedShortcutModifiers.includes(modifier)
                  return <button key={modifier} type="button" disabled={standaloneBase} className={selected ? 'selected' : ''} aria-pressed={selected} onClick={() => {
                    onCancelCapture()
                    const modifiers = shortcutModifiers.filter((item) => item === modifier ? !selected : selectedShortcutModifiers.includes(item))
                    setShortcut(modifiers, shortcutBase)
                  }}>{keyDisplayName(modifier, platform)}</button>
                })}
              </div>
              <span className="shortcut-plus">+</span>
              <ManualKeySelect
                platform={platform}
                value={shortcutBase}
                label="选择主按键或单独修饰键"
                onChange={(base) => { onCancelCapture(); setShortcut(isStandaloneModifierKey(base) ? [] : selectedShortcutModifiers, base) }}
              />
            </div>
          </div>
        </> : behavior.type === 'paste' ? <div className="behavior-dialog-field"><label htmlFor="behavior-paste-text">粘贴内容</label><textarea
          id="behavior-paste-text"
          className="behavior-paste-input"
          autoFocus={draft}
          value={behavior.text}
          placeholder="输入要粘贴的文本"
          onChange={(event) => onUpdate((current) => current.type === 'paste' ? { ...current, text: event.target.value } : current)}
        /></div> : behavior.type === 'delay' ? <div className="behavior-dialog-field"><label htmlFor="behavior-delay-ms">等待时间</label><div className="behavior-delay-row"><Clock3 size={16} /><input id="behavior-delay-ms" className="behavior-delay-input" autoFocus={draft} type="number" min="0" max="300000" step="10" value={behavior.ms} onChange={(event) => onUpdate((current) => current.type === 'delay' ? { ...current, ms: Math.max(0, Math.min(300000, Number(event.target.value) || 0)) } : current)} /><span>毫秒</span></div></div> : <div className="behavior-dialog-field">这个行为不需要编辑。</div>}
      </div>
      <footer className="behavior-dialog-actions">
        <span><Check size={13} /> {draft ? '保存后立即生效' : '更改会自动保存'}</span>
        {draft ? <div className="behavior-dialog-buttons"><button type="button" className="dialog-secondary" onClick={onClose}>取消</button><button type="button" className="button primary" disabled={!canSave} onClick={onSave}>保存</button></div> : <button type="button" className="button primary" onClick={onClose}>关闭</button>}
      </footer>
    </section>
  </div>
}

type TextInputPresetDialogProps = {
  button: RemoteButton
  trigger: TriggerType
  value: string
  onChange: (value: string) => void
  onClose: () => void
  onSave: () => void
}

function TextInputPresetDialog({ button, trigger, value, onChange, onClose, onSave }: TextInputPresetDialogProps) {
  return <div className="behavior-dialog-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose() }}>
    <section className="behavior-dialog text-input-dialog" role="dialog" aria-modal="true" aria-labelledby="text-input-dialog-title">
      <header className="behavior-dialog-head">
        <div><span className="section-kicker">{button.label} · {triggerLabels[trigger]}</span><h2 id="text-input-dialog-title">输入文本并回车</h2></div>
        <button type="button" className="dialog-close" aria-label="关闭输入文本" onClick={onClose}><X size={17} /></button>
      </header>
      <div className="behavior-dialog-body">
        <div className="text-input-sequence" aria-label="粘贴文本，等待 30 毫秒，然后按下 Enter">
          <span>粘贴文本</span><ChevronRight size={14} /><span>等待 30 ms</span><ChevronRight size={14} /><span>Enter</span>
        </div>
        <div className="behavior-dialog-field text-input-field">
          <label htmlFor="text-input-preset-value">文本内容</label>
          <textarea id="text-input-preset-value" className="behavior-paste-input" autoFocus value={value} placeholder="输入要发送的文本" onChange={(event) => onChange(event.target.value)} />
        </div>
      </div>
      <footer className="behavior-dialog-actions">
        <span><Check size={13} /> 三个步骤会一起保存</span>
        <div className="behavior-dialog-buttons"><button type="button" className="dialog-secondary" onClick={onClose}>取消</button><button type="button" className="button primary" disabled={!value.trim()} onClick={onSave}>应用行为</button></div>
      </footer>
    </section>
  </div>
}

type SetupDialogProps = {
  platform: Platform
  macPermissions: MacPermissions
  state: SetupState
  onClose: () => void
  onOpenStep: (step: SetupStepId) => void
  onCompleteStep: () => void
  onSkipStep: () => void
  onSkipAll: () => void
  onReset: () => void
  onDriverAction: (driver: DriverKind, action: DriverActionKind) => void
  onSkipDriverAction: (driver: DriverKind, action: DriverActionKind) => void
  onMarkDriverInstalled: (driver: DriverKind) => void
  onProbeAudio: () => void
  onOpenSystemSettings: (page: 'bluetooth' | 'sound' | MacPermissionKind) => void
  onRequestMacPermission: (kind: MacPermissionKind) => void
  onOpenExternalPage: (page: 'vbcable') => void
  onCheckDevice: () => void
  onMarkDeviceConnected: () => void
  onFinish: () => void
}

const windowsSetupStepLabels: Record<SetupStepId, string> = {
  welcome: '开始',
  inputDriver: '驱动安装',
  deviceConnection: '连接设备',
  complete: '完成',
}

const macSetupStepLabels: Record<SetupStepId, string> = {
  ...windowsSetupStepLabels,
  inputDriver: '权限与音频',
}

const windowsSetupSteps: SetupStepId[] = ['welcome', 'inputDriver', 'deviceConnection', 'complete']
const macSetupSteps: SetupStepId[] = ['inputDriver', 'deviceConnection']

function SetupDialog({ platform, macPermissions, state, onClose, onOpenStep, onCompleteStep, onSkipStep, onSkipAll, onReset, onDriverAction, onSkipDriverAction, onMarkDriverInstalled, onProbeAudio, onOpenSystemSettings, onRequestMacPermission, onOpenExternalPage, onCheckDevice, onMarkDeviceConnected, onFinish }: SetupDialogProps) {
  const step = state.currentStep
  const setupStepLabels = platform === 'macos' ? macSetupStepLabels : windowsSetupStepLabels
  const visibleSteps = platform === 'macos' ? macSetupSteps : windowsSetupSteps
  return <div className="setup-backdrop" role="presentation">
    <section className="setup-dialog" role="dialog" aria-modal="true" aria-labelledby="setup-title">
      <aside className="setup-progress">
        <div className="setup-brand"><span className="brand-mark">A</span><div><strong>Axonkey</strong><span>{platform === 'macos' ? '2 步完成设置' : '首次使用设置'}</span></div></div>
        <div className="setup-step-list">
          {visibleSteps.map((stepId, index) => {
            const status = state.steps[stepId].status
            const statusClass = status === 'complete' || status === 'skipped' ? status : ''
            return <button type="button" key={stepId} className={`setup-step ${step === stepId ? 'active' : ''} ${statusClass}`} onClick={() => onOpenStep(stepId)}>
              <span className="setup-step-index">{status === 'complete' ? <Check size={12} /> : index + 1}</span>
              <span>{setupStepLabels[stepId]}</span>
              {status === 'skipped' && <small>已跳过</small>}
            </button>
          })}
        </div>
        <button type="button" className="setup-skip-all" onClick={state.setupSkipped || isSetupComplete(state) ? onReset : onSkipAll}>{state.setupSkipped || isSetupComplete(state) ? '重新运行引导' : '跳过整个引导'}</button>
      </aside>
      <div className="setup-content">
        <button type="button" className="dialog-close setup-close" aria-label="关闭引导" onClick={onClose}><X size={17} /></button>
        {step === 'welcome' && <div className="setup-screen">
          <span className="setup-hero-icon"><Settings2 size={24} /></span>
          <span className="section-kicker">FIRST RUN</span>
          <h2 id="setup-title">{platform === 'macos' ? '准备好权限与遥控器' : '准备好驱动与遥控器'}</h2>
          <p className="setup-lead">{platform === 'macos'
            ? '整个过程只在本机完成。Axonkey 需要读取 RC003 输入并向当前应用发送映射后的按键。'
            : '整个过程只在本机完成。两个驱动将在同一页依次安装，全部完成后只需重启 Windows 一次。'}</p>
          <div className="setup-summary-grid">
            {platform === 'macos' ? <>
              <div><Keyboard size={18} /><strong>输入监控</strong><span>仅监听目标 RC003 的 HID 报告</span></div>
              <div><Command size={18} /><strong>辅助功能</strong><span>发送映射后的按键与文本</span></div>
              <div><Bluetooth size={18} /><strong>连接 RC003</strong><span>通过 macOS 蓝牙配对并唤醒</span></div>
            </> : <>
              <div><Keyboard size={18} /><strong>按键拦截</strong><span>安装经过校验的 OpenInputBridge 驱动</span></div>
              <div><AudioLines size={18} /><strong>CABLE 虚拟麦克风</strong><span>安装经过校验的 VB-Audio 官方驱动</span></div>
              <div><Bluetooth size={18} /><strong>连接 RC003</strong><span>通过 Windows 蓝牙配对并唤醒</span></div>
            </>}
          </div>
          <div className="setup-actions"><button type="button" className="button primary setup-primary" onClick={onCompleteStep}>开始设置 <ChevronRight size={15} /></button></div>
        </div>}
        {step === 'inputDriver' && (platform === 'macos'
          ? <MacPermissionsSetupScreen
            permissions={macPermissions}
            state={state}
            onRequest={onRequestMacPermission}
            onAudioAction={onDriverAction}
            onProbeAudio={onProbeAudio}
            onOpenSound={() => onOpenSystemSettings('sound')}
            onContinue={onCompleteStep}
            onSkip={onSkipStep}
          />
          : <DriversSetupScreen
            state={state}
            onAction={onDriverAction}
            onSkipAction={onSkipDriverAction}
            onMarkInstalled={onMarkDriverInstalled}
            onProbeAudio={onProbeAudio}
            onContinue={onCompleteStep}
            onSkip={onSkipStep}
            onOpenSettings={() => onOpenSystemSettings('sound')}
            onOpenVendorPage={() => onOpenExternalPage('vbcable')}
          />)}
        {step === 'deviceConnection' && <div className="setup-screen">
          <span className="setup-hero-icon"><Bluetooth size={24} /></span>
          <span className="section-kicker">DEVICE</span>
          <h2 id="setup-title">连接小米遥控器 RC003</h2>
          <p className="setup-lead">先在{platform === 'macos' ? '系统' : ' Windows'}蓝牙设置中完成配对，再按遥控器任意按键将它唤醒。Axonkey 只处理 VID 2717 / PID 32B8 的目标设备。</p>
          <div className={`setup-status-panel ${state.device.status}`}><span className="setup-status-dot" /><div><strong>{state.device.status === 'connected' ? 'RC003 已连接' : state.device.status === 'checking' ? '正在检查设备' : '尚未确认连接'}</strong><span>{state.device.message ?? '打开系统设置完成蓝牙配对，然后返回这里检查。'}</span></div></div>
          <div className="setup-inline-actions"><button type="button" className="dialog-secondary" onClick={() => onOpenSystemSettings('bluetooth')}><Bluetooth size={14} /> 打开蓝牙设置</button><button type="button" className="dialog-secondary" onClick={onCheckDevice}><RotateCcw size={14} /> 重新检测</button><button type="button" className="dialog-secondary" onClick={onMarkDeviceConnected}><Check size={14} /> 我已连接</button></div>
          <div className="setup-actions"><button type="button" className="setup-text-button" onClick={platform === 'macos' ? () => { onSkipStep(); onFinish() } : onSkipStep}>稍后连接</button><button type="button" className="button primary setup-primary" disabled={state.device.status !== 'connected'} onClick={platform === 'macos' ? onFinish : onCompleteStep}>{platform === 'macos' ? '完成设置' : '继续'} <ChevronRight size={15} /></button></div>
        </div>}
        {step === 'complete' && <div className="setup-screen setup-complete">
          <span className="setup-hero-icon success"><Check size={26} /></span>
          <span className="section-kicker">READY</span>
          <h2 id="setup-title">基本设置已完成</h2>
          <p className="setup-lead">映射配置会自动保存。以后点击顶部的设备状态卡，可以重新打开这里检查{platform === 'macos' ? '系统权限' : '驱动'}或 RC003 连接。</p>
          <div className="setup-result-list">
            {platform === 'macos' ? <>
              <span><Keyboard size={15} /> 输入监控：{macPermissions.inputMonitoring ? '已授权' : '稍后授权'}</span>
              <span><Command size={15} /> 辅助功能：{macPermissions.accessibility ? '已授权' : '稍后授权'}</span>
              <span><AudioLines size={15} /> MiRemoteV 2ch：{driverStatusLabel(state.drivers.audio.status)}</span>
            </> : <>
              <span><Keyboard size={15} /> 按键驱动：{driverStatusLabel(state.drivers.input.status)}</span>
              <span><AudioLines size={15} /> CABLE 麦克风：{driverStatusLabel(state.drivers.audio.status)}</span>
            </>}
            <span><Bluetooth size={15} /> RC003：{state.device.status === 'connected' ? '已连接' : '稍后连接'}</span>
          </div>
          <div className="setup-actions"><button type="button" className="button primary setup-primary" onClick={onFinish}>进入按键映射</button></div>
        </div>}
      </div>
    </section>
  </div>
}

type MacPermissionsSetupScreenProps = {
  permissions: MacPermissions
  state: SetupState
  onRequest: (kind: MacPermissionKind) => void
  onAudioAction: (driver: DriverKind, action: DriverActionKind) => void
  onProbeAudio: () => void
  onOpenSound: () => void
  onContinue: () => void
  onSkip: () => void
}

function MacPermissionsSetupScreen({ permissions, state, onRequest, onAudioAction, onProbeAudio, onOpenSound, onContinue, onSkip }: MacPermissionsSetupScreenProps) {
  const ready = permissions.inputMonitoring && permissions.accessibility
  const grantedCount = Number(permissions.inputMonitoring) + Number(permissions.accessibility)
  const activeKind: MacPermissionKind | null = !permissions.inputMonitoring
    ? 'inputMonitoring'
    : !permissions.accessibility ? 'accessibility' : null
  const items = [
    {
      kind: 'inputMonitoring' as const,
      title: '输入监控',
      description: '允许 IOKit 读取目标 RC003 的原始 HID 按键报告。',
      granted: permissions.inputMonitoring,
      icon: <Keyboard size={18} />,
    },
    {
      kind: 'accessibility' as const,
      title: '辅助功能',
      description: '允许 CoreGraphics 发送映射后的按键、快捷键和文本。',
      granted: permissions.accessibility,
      icon: <Command size={18} />,
    },
  ]
  const audio = state.drivers.audio
  const inputAuthorizationError = state.drivers.input.status === 'error'
    ? state.drivers.input.message
    : null
  const audioInstalled = isDriverInstalled(state, 'audio')
  const audioRunning = audio.action.status === 'running'
  return <div className="setup-screen mac-permission-screen">
    <span className="section-kicker">SYSTEM ACCESS</span>
    <h2 id="setup-title">先完成两项必要授权</h2>
    <p className="setup-lead">按顺序操作即可。每次授权都会打开对应的系统设置，并保留一个置顶小窗协助完成添加。</p>

    <div className={`permission-progress-summary ${ready ? 'ready' : ''}`} aria-live="polite">
      <span className="permission-progress-icon"><ShieldCheck size={24} /></span>
      <div><strong>{ready ? '系统权限已就绪' : `已完成 ${grantedCount} / 2`}</strong><span>{ready ? 'Axonkey 可以拦截原始按键并执行你的映射。' : '只突出当前需要完成的一项，授权后会自动刷新。'}</span></div>
      <span className="permission-progress-count">{grantedCount}/2</span>
    </div>

    <div className="mac-permission-list">
      {items.map((item, index) => {
        const current = activeKind === item.kind
        const waiting = !item.granted && !current
        return <section key={item.kind} className={`mac-permission-step ${item.granted ? 'granted' : current ? 'current' : 'waiting'}`}>
          <div className="permission-step-number">{item.granted ? <Check size={16} /> : index + 1}</div>
          <span className="permission-step-icon">{item.icon}</span>
          <div className="permission-step-copy"><div><h3>{item.title}</h3><span className="permission-status-label">{item.granted ? '已授权' : current ? '现在完成' : '下一步'}</span></div><p>{item.description}</p></div>
          {current && <button type="button" className="button primary permission-request-button" onClick={() => onRequest(item.kind)}>开始授权 <ExternalLink size={15} /></button>}
          {item.granted && <CheckCircle2 className="permission-complete-icon" size={21} />}
          {waiting && <span className="permission-waiting-label">完成上一步后继续</span>}
        </section>
      })}
    </div>

    <section className={`mac-audio-setup ${audio.status}`}>
      <span className="permission-step-icon"><AudioLines size={18} /></span>
      <div className="mac-audio-copy">
        <div><h3>MiRemoteV 2ch 虚拟麦克风</h3><span className="permission-status-label">{driverStatusLabel(audio.status)}</span></div>
        <p>{audio.action.error ?? audio.message ?? '安装后，Axonkey 会把 RC003 语音直接转发给豆包输入法等应用。'}</p>
      </div>
      <div className="mac-audio-actions">
        {!audioInstalled && <button type="button" className="dialog-secondary" disabled={audioRunning} onClick={() => onAudioAction('audio', 'install')}><Download size={14} /> {audioRunning ? '等待授权…' : '安装驱动'}</button>}
        {audioInstalled && <button type="button" className="dialog-secondary danger" disabled={audioRunning} onClick={() => onAudioAction('audio', 'uninstall')}><Trash2 size={14} /> {audioRunning ? '等待授权…' : '卸载'}</button>}
        <button type="button" className="dialog-secondary" disabled={audioRunning || audio.status === 'checking'} onClick={onProbeAudio}><RotateCcw size={14} /> {audio.status === 'checking' ? '检测中' : '重新检测'}</button>
        <button type="button" className="dialog-secondary" disabled={audioRunning} onClick={onOpenSound}><Settings2 size={14} /> 声音设置</button>
      </div>
    </section>

    {inputAuthorizationError
      ? <div className="permission-drag-note"><Info size={17} /><div><strong>需要重新授权当前构建</strong><span>{inputAuthorizationError}</span></div></div>
      : !ready && <div className="permission-drag-note"><Info size={17} /><div><strong>系统列表中没有 Axonkey？</strong><span>授权小窗可以在 Finder 中定位当前应用，再将 Axonkey.app 拖入系统设置列表。</span></div></div>}
    <div className="setup-actions"><button type="button" className="setup-text-button" onClick={onSkip}>稍后授权</button><button type="button" className="button primary setup-primary" disabled={!ready} onClick={onContinue}>继续 <ChevronRight size={15} /></button></div>
  </div>
}

type MacPermissionHelperWindowProps = {
  activePermission: MacPermissionKind
  permissions: MacPermissions
  onOpenSettings: (kind: MacPermissionKind) => void
  onRevealApp: () => void
  onRefresh: () => void
  onClose: () => void
}

function MacPermissionHelperWindow({ activePermission, permissions, onOpenSettings, onRevealApp, onRefresh, onClose }: MacPermissionHelperWindowProps) {
  const ready = permissions.inputMonitoring && permissions.accessibility
  const activeTitle = activePermission === 'inputMonitoring' ? '输入监控' : '辅助功能'
  return <main className="permission-helper-shell">
    <header className="permission-helper-header">
      <div className="setup-brand"><span className="brand-mark">A</span><div><strong>Axonkey</strong><span>授权助手 · 保持置顶</span></div></div>
      <button type="button" className="dialog-close" aria-label="返回完整窗口" onClick={onClose}><X size={17} /></button>
    </header>

    <section className="permission-helper-content">
      <span className="section-kicker">{ready ? 'PERMISSIONS READY' : `CURRENT · ${activePermission === 'inputMonitoring' ? '1 / 2' : '2 / 2'}`}</span>
      <h1>{ready ? '两项权限都已打开' : `在系统设置中允许${activeTitle}`}</h1>
      <p className="permission-helper-lead">{ready ? '状态已自动刷新，可以返回引导继续连接遥控器。' : '若列表中已有 Axonkey，直接打开右侧开关；没有时按下面两步添加。'}</p>

      <div className="permission-helper-status" aria-live="polite">
        <span className={permissions.inputMonitoring ? 'granted' : activePermission === 'inputMonitoring' ? 'active' : ''}><Keyboard size={15} /> 输入监控 <strong>{permissions.inputMonitoring ? '已授权' : '待授权'}</strong></span>
        <span className={permissions.accessibility ? 'granted' : activePermission === 'accessibility' ? 'active' : ''}><Command size={15} /> 辅助功能 <strong>{permissions.accessibility ? '已授权' : '待授权'}</strong></span>
      </div>

      {!ready && <div className="permission-drag-guide">
        <div className="permission-drag-visual" aria-hidden="true"><span className="permission-app-tile"><span className="brand-mark">A</span>Axonkey.app</span><ChevronRight size={18} /><span className="permission-settings-tile"><Settings2 size={18} />系统设置</span></div>
        <ol><li>点击“在 Finder 中显示”，找到高亮的 Axonkey.app。</li><li>将它拖到已打开的系统授权列表，再打开开关。</li></ol>
      </div>}

      <div className="permission-helper-actions">
        {!ready && <button type="button" className="button primary" onClick={onRevealApp}><FolderOpen size={16} /> 在 Finder 中显示</button>}
        {!ready && <button type="button" className="dialog-secondary" onClick={() => onOpenSettings(activePermission)}><ExternalLink size={15} /> 再次打开系统设置</button>}
      </div>
    </section>

    <footer className="permission-helper-footer">
      <button type="button" className="setup-text-button permission-refresh-button" onClick={onRefresh}><RotateCcw size={14} /> 重新检测</button>
      <button type="button" className={`button ${ready ? 'primary' : 'permission-return-button'}`} onClick={onClose}>{ready ? '继续连接遥控器' : '返回引导'} <ChevronRight size={15} /></button>
    </footer>
  </main>
}

type DriversSetupScreenProps = {
  state: SetupState
  onAction: (driver: DriverKind, action: DriverActionKind) => void
  onSkipAction: (driver: DriverKind, action: DriverActionKind) => void
  onMarkInstalled: (driver: DriverKind) => void
  onProbeAudio: () => void
  onContinue: () => void
  onSkip: () => void
  onOpenSettings: () => void
  onOpenVendorPage: () => void
}

function driverStatusLabel(status: SetupState['drivers']['input']['status']) {
  const labels = { unknown: '未检查', checking: '检查中', missing: '未安装', installed: '已安装', restartRequired: '等待重启', error: '操作失败' }
  return labels[status]
}

function isDriverInstalled(state: SetupState, kind: DriverKind) {
  const status = state.drivers[kind].status
  return status === 'installed' || status === 'restartRequired'
}

type DriverSetupItemProps = Pick<DriversSetupScreenProps, 'state' | 'onAction' | 'onMarkInstalled' | 'onProbeAudio' | 'onOpenSettings' | 'onOpenVendorPage'> & {
  kind: DriverKind
  disabled: boolean
}

function DriverSetupItem({ kind, state, onAction, onMarkInstalled, onProbeAudio, onOpenSettings, onOpenVendorPage, disabled }: DriverSetupItemProps) {
  const definition = driverDefinitions[kind]
  const driver = state.drivers[kind]
  const running = driver.action.status === 'running'
  const installed = isDriverInstalled(state, kind)
  const message = driver.action.error ?? driver.message ?? (kind === 'input'
    ? '经过校验的 OpenInputBridge 驱动，仅用于识别 RC003 按键。'
    : 'VB-Audio Donationware，安装后提供 CABLE Output 虚拟录音设备。')
  return <section className={`driver-setup-item ${driver.status}`}>
    <div className="driver-setup-heading">
      <span className="driver-setup-icon">{kind === 'input' ? <Keyboard size={18} /> : <AudioLines size={18} />}</span>
      <div><h3>{definition.title}</h3><p>{definition.description}</p></div>
      <span className="driver-status-chip"><span className="setup-status-dot" /> {driverStatusLabel(driver.status)}</span>
    </div>
    <p className="driver-setup-message">{message}</p>
    <div className="driver-setup-actions">
      {!installed && <button type="button" className="dialog-secondary" disabled={disabled} onClick={() => onAction(kind, 'install')}><Download size={14} /> {running ? '等待安装器…' : kind === 'audio' ? '安装 VB-CABLE' : '安装驱动'}</button>}
      {installed && <button type="button" className="dialog-secondary danger" disabled={disabled} onClick={() => onAction(kind, 'uninstall')}><Trash2 size={14} /> {running ? '等待安装器…' : kind === 'audio' ? '卸载 VB-CABLE' : '卸载驱动'}</button>}
      {kind === 'input' && !installed && <button type="button" className="dialog-secondary" disabled={disabled} onClick={() => onMarkInstalled(kind)}><Check size={14} /> 我已手动安装</button>}
      {kind === 'audio' && <button type="button" className="dialog-secondary" disabled={disabled || driver.status === 'checking'} onClick={onProbeAudio}><RotateCcw size={14} /> {driver.status === 'checking' ? '检测中' : '重新检测'}</button>}
      {kind === 'audio' && <button type="button" className="dialog-secondary" disabled={disabled} onClick={onOpenSettings}><Settings2 size={14} /> 声音设置</button>}
      {kind === 'audio' && <button type="button" className="dialog-secondary" disabled={disabled} onClick={onOpenVendorPage}><ExternalLink size={14} /> VB-Audio 官网</button>}
    </div>
  </section>
}

function DriversSetupScreen({ state, onAction, onSkipAction, onMarkInstalled, onProbeAudio, onContinue, onSkip, onOpenSettings, onOpenVendorPage }: DriversSetupScreenProps) {
  const anyRunning = (['input', 'audio'] as const).some((kind) => state.drivers[kind].action.status === 'running')
  const allInstalled = (['input', 'audio'] as const).every((kind) => isDriverInstalled(state, kind))
  const restartRequired = (['input', 'audio'] as const).some((kind) => state.drivers[kind].restartRequired)
  const skipDrivers = () => {
    for (const kind of ['input', 'audio'] as const) {
      if (!isDriverInstalled(state, kind)) onSkipAction(kind, 'install')
    }
    onSkip()
  }
  return <div className="setup-screen drivers-setup-screen">
    <span className="setup-hero-icon"><Download size={24} /></span>
    <span className="section-kicker">DRIVERS</span>
    <h2 id="setup-title">一次完成两个驱动</h2>
    <p className="setup-lead">依次完成按键驱动和 CABLE 虚拟麦克风安装。两个安装器都结束后再重启 Windows，避免重复重启。</p>
    <div className="driver-setup-list">
      <DriverSetupItem kind="input" state={state} onAction={onAction} onMarkInstalled={onMarkInstalled} onProbeAudio={onProbeAudio} onOpenSettings={onOpenSettings} onOpenVendorPage={onOpenVendorPage} disabled={anyRunning} />
      <DriverSetupItem kind="audio" state={state} onAction={onAction} onMarkInstalled={onMarkInstalled} onProbeAudio={onProbeAudio} onOpenSettings={onOpenSettings} onOpenVendorPage={onOpenVendorPage} disabled={anyRunning} />
    </div>
    <div className="driver-restart-notice"><RotateCcw size={16} /><div><strong>两个驱动安装完成后统一重启一次</strong><span>重启前可以先完成剩余引导；驱动将在下一次进入 Windows 后生效。</span></div></div>
    <div className="setup-actions"><button type="button" className="setup-text-button" disabled={anyRunning} onClick={skipDrivers}>稍后安装</button><button type="button" className="button primary setup-primary" disabled={anyRunning} onClick={onContinue}>{allInstalled ? restartRequired ? '继续，稍后重启' : '继续' : '稍后处理并继续'} <ChevronRight size={15} /></button></div>
  </div>
}

export default App
