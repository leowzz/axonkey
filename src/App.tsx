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
  Target,
  Trash2,
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
import appPackage from '../package.json'
import {
  KeyboardEvent,
  PointerEvent as ReactPointerEvent,
  ReactNode,
  useCallback,
  useEffect,
  useLayoutEffect,
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
  icon: 'power' | 'mic' | 'up' | 'left' | 'center' | 'right' | 'down' | 'home' | 'menu' | 'tv'
}

type SystemProbe = {
  input_driver_installed: boolean
  rc003_connected: boolean
  input_backend_ready: boolean
  input_backend_error?: string | null
  device_hardware_id?: string | null
}

type DriverActionResult = {
  logPath: string
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
  { id: 'home', label: '主页键', short: '主页', side: 'left', x: 22.80, y: 75.72, icon: 'home' },
  { id: 'menu', label: '功能键', short: '功能', side: 'left', x: 21.18, y: 90.79, icon: 'menu' },
  { id: 'tv', label: '电视键', short: '电视', side: 'right', x: 60.69, y: 91.91, icon: 'tv' },
]

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
      { value: 'Ctrl', label: 'Ctrl' }, { value: 'Shift', label: 'Shift' }, { value: 'Alt', label: 'Alt' },
      { value: 'LAlt', label: '左 Alt' }, { value: 'RAlt', label: '右 Alt' },
      { value: 'Win', label: 'Windows' },
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

const shortcutModifiers = ['Ctrl', 'Shift', 'Alt', 'Win']
const standaloneModifierKeys = ['Ctrl', 'Shift', 'Alt', 'LAlt', 'RAlt', 'Win']

function isStandaloneModifierKey(key: string) {
  return standaloneModifierKeys.includes(key)
}

function behaviorSummary(behavior: Behavior) {
  switch (behavior.type) {
    case 'key': return behavior.key || '未录入'
    case 'shortcut': return behavior.keys.length > 0 ? behavior.keys.join(' + ') : '未录入'
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

function triggerSummary(list: Behavior[], trigger: TriggerType) {
  if (list.length === 0) return trigger === 'click' ? '保留原按键' : '未设置'
  const summary = behaviorSummary(list[0])
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
  home: { x: 22.80, y: 75.72 },
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
  const [setupState, setSetupState] = useState<SetupState>(loadSetupState)
  const [setupOpen, setSetupOpen] = useState(() => !isSetupComplete(loadSetupState()))
  const workspaceRef = useRef<HTMLDivElement>(null)
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
  const [connectors, setConnectors] = useState<Connector[]>([])

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
    const next = buttons.flatMap((button) => {
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
  }, [])

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

  const connectedCount = Object.values(behaviors).reduce((count, triggers) => count + Object.values(triggers).reduce((total, list) => total + list.length, 0), 0)

  const selectBehaviorTarget = (buttonId: ButtonId, trigger: TriggerType) => {
    setActiveId(buttonId)
    setSelectedBehavior({ buttonId, trigger })
    setCapturingBehaviorId(null)
    setEditingBehaviorId(null)
    setDraftBehavior(null)
    setTextInputDraft(null)
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
      const driverName = driver === 'audio' ? 'VB-CABLE' : '按键驱动'
      updateSetup((current) => finishDriverAction(current, driver, action, {
        success: true,
        status: action === 'install' ? 'restartRequired' : 'missing',
        restartRequired: true,
        message: action === 'install'
          ? `${driverName} 安装已完成，请重启 Windows。日志：${result.logPath}`
          : `${driverName} 卸载已完成，请重启 Windows。日志：${result.logPath}`,
      }))
    } catch (error) {
      const browserPreview = typeof window !== 'undefined' && !('__TAURI_INTERNALS__' in window)
      updateSetup((current) => finishDriverAction(current, driver, action, {
        success: false,
        status: 'error',
        error: browserPreview ? '浏览器预览不会启动系统脚本，请在 Tauri 桌面版中操作。' : String(error),
      }))
    }
  }

  const openWindowsSettings = async (page: 'bluetooth' | 'sound') => {
    try {
      await invoke('open_windows_settings', { page })
    } catch {
      setToast('浏览器预览无法打开 Windows 设置')
      window.setTimeout(() => setToast(''), 2200)
    }
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
      updateSetup((current) => {
        const connectedDevice = {
          status: 'connected' as const,
          name: '小米遥控器 RC003',
          hardwareId: probe.device_hardware_id ?? undefined,
          message: probe.device_hardware_id
            ? 'Interception 输入服务已识别并接管 RC003。'
            : 'Windows 已检测到 RC003；按任意键唤醒后即可接管输入。',
        }
        const disconnectedDevice = {
          status: 'disconnected' as const,
          name: undefined,
          hardwareId: undefined,
          message: '未检测到 RC003，请确认蓝牙已配对并按任意键唤醒。',
        }
        const device = probe.rc003_connected ? connectedDevice : disconnectedDevice
        if (!showChecking) {
          const unchanged = current.device.status === device.status
            && current.device.name === device.name
            && current.device.hardwareId === device.hardwareId
            && current.device.message === device.message
          return unchanged ? current : setDeviceConnection(current, device)
        }
        const inputStatus = !probe.input_driver_installed ? 'missing' : probe.input_backend_error ? 'error' : 'installed'
        const inputMessage = !probe.input_driver_installed
          ? '未检测到 Interception 按键驱动。'
          : probe.input_backend_error
            ? `驱动已安装，但输入服务启动失败：${probe.input_backend_error}`
            : probe.input_backend_ready
              ? 'Interception 按键服务工作正常。'
              : '已检测到 Interception 按键驱动，输入服务正在启动。'
        const next = setDriverStatus(current, 'input', inputStatus, { message: inputMessage })
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
    updateSetup((current) => setDriverStatus(current, 'audio', 'checking', { message: '正在检查 VB-CABLE 虚拟麦克风…' }))
    try {
      const available = await withTimeout(
        invoke<boolean>('probe_audio_available'),
        5_000,
        '检测超时，请点击“重新检测”再试',
      )
      updateSetup((current) => setDriverStatus(current, 'audio', available ? 'installed' : 'missing', {
        message: available ? '已检测到 VB-Audio Virtual Cable（CABLE Output）。' : '未检测到 VB-CABLE 虚拟麦克风驱动。',
      }))
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
          message: current.device.hardwareId
            ? 'Interception 输入服务已识别并接管 RC003。'
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
  }, [setupOpen, setupState.currentStep])

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
    const lines = buttons.map((button) => `  ${button.id}: { x: ${hitPositions[button.id].x.toFixed(2)}, y: ${hitPositions[button.id].y.toFixed(2)} },`)
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
    setToast(copied ? '坐标已复制，也可以从弹窗中手动复制' : '请在弹窗文本框中按 Ctrl+C 复制坐标')
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
            <div className="title-row"><h1>按键映射</h1><span className="title-divider" /><span className="title-hint">RC003</span></div>
          </div>
          <div className="header-actions">
            <label className="enable-control"><span>启用自定义按键功能</span><button className={`switch ${enabled ? 'on' : ''}`} type="button" aria-pressed={enabled} onClick={toggleEnabled}><span /></button></label>
          </div>
        </header>

        <div className="toolbar-row">
          <div className="toolbar-context"><span className="toolbar-context-mark" /> 选择按键，设置不同的触发行为</div>
          <div className="toolbar-meta"><span>{connectedCount} 个自定义行为</span><span className="toolbar-divider" /><span className={`auto-save-state ${autoSaveState}`}><Check size={13} /> {autoSaveState === 'saving' ? '保存中' : '已自动保存'}</span>{debugMode && <><span className="toolbar-divider" /><span className="debug-status"><Target size={13} /> 调试模式</span><span className="debug-hint">拖动图上的点调整连线起点</span><button type="button" className="reset-button" onClick={() => void copyHitPositions()}><Copy size={13} /> 复制坐标</button><button type="button" className="reset-button" onClick={resetHitPositions}><RotateCcw size={13} /> 恢复点位</button></>}<button type="button" className="reset-button" onClick={resetMappings}><RotateCcw size={14} /> 恢复默认</button></div>
        </div>

        <div className={`workspace ${debugMode ? 'debug-mode' : ''}`} ref={workspaceRef}>
          <MappingSide
            side="left"
            buttons={buttons.filter((button) => button.side === 'left')}
            behaviors={behaviors}
            activeId={activeId}
            selectedBehavior={selectedBehavior}
            rowRefs={rowRefs}
            selectBehaviorTarget={selectBehaviorTarget}
          />

          <section className="remote-panel panel-surface">
            <button type="button" className="device-card remote-device-card" onClick={() => openSetupStep('deviceConnection')}><div className="device-card-head"><strong>小米遥控器</strong>{setupState.device.status === 'connected' ? <CheckCircle2 className="device-icon" size={16} /> : <Bluetooth className="device-icon" size={16} />}</div><div className="device-card-meta"><span className={`device-state-dot ${setupState.device.status === 'connected' ? 'connected' : ''}`} /> <span>{setupState.device.status === 'connected' ? '已连接' : '未连接'}</span><BatteryMedium size={14} /><span className={`battery-level ${batteryLevel !== null && batteryLevel <= 20 ? 'low' : ''}`}>{batteryLevel === null ? '电量未知' : `${batteryLevel}%`}</span><span className="device-meta-separator" /><span>设备与驱动</span></div></button>
            <div className="remote-stage">
              <div className="remote-art" ref={remoteArtRef}>
                <img src="/rc003-remote-cutout.png" alt="小米 RC003 遥控器" />
                {buttons.map((button) => (
                  <button
                    key={button.id}
                    ref={(node) => { if (node) markerRefs.current[button.id] = node }}
                    type="button"
                    aria-label={button.label}
                    className={`hotspot hotspot-${button.icon} ${activeId === button.id ? 'active' : ''} ${Object.values(behaviors[button.id]).some((list) => list.length > 0) ? 'mapped' : ''} ${draggingId === button.id ? 'dragging' : ''}`}
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
            side="right"
            buttons={buttons.filter((button) => button.side === 'right')}
            behaviors={behaviors}
            activeId={activeId}
            selectedBehavior={selectedBehavior}
            rowRefs={rowRefs}
            selectBehaviorTarget={selectBehaviorTarget}
          />

          <svg className="connector-layer" aria-hidden="true">
            {connectors.map((line) => {
              const selected = line.id === activeId
              const elbow = line.side === 'left'
                ? Math.min(line.x1 - 34, line.x2 + 32)
                : Math.max(line.x1 + 34, line.x2 - 32)
              return <g key={line.id} className={selected ? 'connector selected' : 'connector'}>
                <path d={`M ${line.x1} ${line.y1} C ${elbow} ${line.y1}, ${elbow} ${line.y2}, ${line.x2} ${line.y2}`} />
                <circle cx={line.x1} cy={line.y1} r={selected ? 4 : 2.5} />
                <circle cx={line.x2} cy={line.y2} r={selected ? 3.5 : 2} />
              </g>
            })}
          </svg>
        </div>
        <div className="mapping-limit-note" role="note">
          <Info size={12} aria-hidden="true" />
          <span>返回键和独立音量 + / - 键暂不可配置：Windows 无法可靠区分这些按键来自哪台设备，强制映射可能影响其他键盘或遥控器。</span>
        </div>
        <BehaviorEditor
          button={buttons.find((button) => button.id === selectedBehavior.buttonId) ?? buttons[0]}
          trigger={selectedBehavior.trigger}
          behaviors={behaviors[selectedBehavior.buttonId][selectedBehavior.trigger]}
          canUndoCommonBehavior={canUndoCommonBehavior}
          onApplyCommonBehavior={applyCommonBehavior}
          onUndoCommonBehavior={undoCommonBehavior}
          onAddAdvancedBehavior={(type) => beginBehaviorDraft(type, 'append')}
          onRemoveBehavior={removeBehavior}
          onMoveBehavior={moveSelectedBehavior}
          onEditBehavior={setEditingBehaviorId}
        />
        <footer className="main-footer"><span>Axonkey 仅修改 RC003 遥控器输入，不影响普通键盘。</span><span className="footer-key"><Command size={12} /> 本地配置</span></footer>
      </main>
      {toast && <div className="toast"><Check size={15} /> {toast}</div>}
      {coordinateSnippet && <div className="coordinate-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) setCoordinateSnippet('') }}>
        <section className="coordinate-dialog" role="dialog" aria-modal="true" aria-labelledby="coordinate-title">
          <div className="coordinate-dialog-head"><div><span className="section-kicker">DEBUG POSITION</span><h2 id="coordinate-title">坐标已生成</h2></div><button type="button" className="dialog-close" aria-label="关闭" onClick={() => setCoordinateSnippet('')}><X size={16} /></button></div>
          <p>文本框已经自动选中，按 Ctrl+C 后粘贴发给我，或替换 App.tsx 中的 initialHitPositions。</p>
          <textarea ref={coordinateTextRef} value={coordinateSnippet} readOnly aria-label="定位坐标代码" />
          <div className="coordinate-dialog-actions"><button type="button" className="dialog-secondary" onClick={() => coordinateTextRef.current?.select()}><Copy size={14} /> 全选坐标</button><button type="button" className="button primary" onClick={() => setCoordinateSnippet('')}>完成</button></div>
        </section>
      </div>}
      {editingBehavior && <BehaviorEditDialog
        button={buttons.find((button) => button.id === selectedBehavior.buttonId) ?? buttons[0]}
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
        button={buttons.find((button) => button.id === selectedBehavior.buttonId) ?? buttons[0]}
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
        button={buttons.find((button) => button.id === selectedBehavior.buttonId) ?? buttons[0]}
        trigger={selectedBehavior.trigger}
        value={textInputDraft}
        onChange={setTextInputDraft}
        onClose={() => setTextInputDraft(null)}
        onSave={commitTextInputPreset}
      />}
      {setupOpen && <SetupDialog
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
        onOpenWindowsSettings={(page) => void openWindowsSettings(page)}
        onOpenExternalPage={(page) => void openExternalPage(page)}
        onCheckDevice={checkDeviceConnection}
        onMarkDeviceConnected={() => updateSetup((current) => setDeviceConnection(current, { status: 'connected', name: '小米遥控器 RC003', message: '设备已由用户确认连接。' }))}
        onFinish={() => { updateSetup((current) => completeSetupStep(current, 'complete')); setSetupOpen(false) }}
      />}
    </div>
  )
}

type MappingSideProps = {
  side: 'left' | 'right'
  buttons: RemoteButton[]
  behaviors: BehaviorMap
  activeId: ButtonId
  selectedBehavior: { buttonId: ButtonId; trigger: TriggerType }
  rowRefs: { current: Partial<Record<ButtonId, HTMLDivElement>> }
  selectBehaviorTarget: (buttonId: ButtonId, trigger: TriggerType) => void
}

function MappingSide({ side, buttons: sideButtons, behaviors, activeId, selectedBehavior, rowRefs, selectBehaviorTarget }: MappingSideProps) {
  return <section className={`mapping-side panel-surface ${side}`}>
    <div className="mapping-list">
      {sideButtons.map((button) => (
        <MappingRow
          key={button.id}
          button={button}
          behaviors={behaviors[button.id]}
          active={activeId === button.id}
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
  button: RemoteButton
  behaviors: Record<TriggerType, Behavior[]>
  active: boolean
  selectedTrigger: TriggerType | null
  rowRef: (node: HTMLDivElement | null) => void
  onSelect: () => void
  onSelectTrigger: (trigger: TriggerType) => void
}

function MappingRow({ button, behaviors, active, selectedTrigger, rowRef, onSelect, onSelectTrigger }: MappingRowProps) {
  const triggerOrder: TriggerType[] = ['click', 'doubleClick', 'longPress']
  const hasBehavior = triggerOrder.some((trigger) => behaviors[trigger].length > 0)
  return <article ref={rowRef} className={`mapping-card ${active ? 'active' : ''}`} onClick={onSelect}>
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
          <strong>{triggerSummary(list, trigger)}</strong>
        </button>
      })}
    </div>
  </article>
}

type BehaviorEditorProps = {
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

function BehaviorEditor({ button, trigger, behaviors, canUndoCommonBehavior, onApplyCommonBehavior, onUndoCommonBehavior, onAddAdvancedBehavior, onRemoveBehavior, onMoveBehavior, onEditBehavior }: BehaviorEditorProps) {
  const [activeTab, setActiveTab] = useState<BehaviorEditorTab>('common')
  const tabId = `behavior-${button.id}-${trigger}`
  return <section className="behavior-editor" aria-label={`${button.label}${triggerLabels[trigger]}行为配置`}>
    <div className="behavior-editor-head">
      <div className="behavior-editor-title">
        <span className={`row-icon icon-${button.icon}`}>{iconFor(button.icon, 17)}</span>
        <div><h2>{button.label} · {triggerLabels[trigger]}</h2><p>按顺序执行下面的行为，支持连续组合</p></div>
      </div>
      <span className="behavior-trigger-pill"><GripVertical size={13} /> {behaviors.length ? `${behaviors.length} 个行为` : '尚未配置'}</span>
    </div>
    <div className="behavior-editor-body">
      <section className="behavior-current-panel" aria-labelledby={`${tabId}-current-title`}>
        <div className="behavior-column-heading">
          <h3 id={`${tabId}-current-title`}>现有行为</h3>
        </div>
        <div className="behavior-list">
          {behaviors.length === 0 && <div className="behavior-empty">{trigger === 'click' ? '当前保留原按键，可从右侧直接更改行为' : '这个触发方式尚未设置，可从右侧直接选择行为'}</div>}
          {behaviors.map((behavior, index) => <BehaviorItem
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
        <div className="behavior-tabs-row">
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
  behavior: Behavior
  index: number
  total: number
  onRemove: (behaviorId: string) => void
  onMove: (behaviorId: string, direction: -1 | 1) => void
  onEdit: (behaviorId: string) => void
}

function BehaviorItem({ behavior, index, total, onRemove, onMove, onEdit }: BehaviorItemProps) {
  const editable = behavior.type !== 'disabled'
  return <div className="behavior-item">
    <span className="behavior-item-index">{String(index + 1).padStart(2, '0')}</span>
    <button type="button" className="behavior-item-summary" disabled={!editable} onClick={() => onEdit(behavior.id)}>
      <span className="behavior-type-label">{behaviorTypeLabels[behavior.type]}</span>
      <strong>{behaviorSummary(behavior)}</strong>
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

function ManualKeySelect({ value, onChange, label, includeModifiers = true }: { value: string; onChange: (value: string) => void; label: string; includeModifiers?: boolean }) {
  const groups = includeModifiers ? manualKeyGroups : manualKeyGroups.filter((group) => group.label !== '单独修饰键')
  const knownValue = groups.some((group) => group.options.some((option) => option.value === value)) ? value : ''
  return <select value={knownValue} aria-label={label} onChange={(event) => onChange(event.target.value)}>
    <option value="" disabled>{value && !knownValue ? `当前：${value}` : '选择按键'}</option>
    {groups.map((group) => <optgroup key={group.label} label={group.label}>
      {group.options.map((option) => <option key={`${group.label}-${option.value}`} value={option.value}>{option.label}</option>)}
    </optgroup>)}
  </select>
}

function BehaviorEditDialog({ button, trigger, behavior, capturing, draft = false, onStartCapture, onCancelCapture, onCaptureKey, onUpdate, onClose, onSave }: BehaviorEditDialogProps) {
  const captureValue = behavior.type === 'shortcut' ? behavior.keys.join(' + ') : behavior.type === 'key' ? behavior.key : ''
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
                  }}>{modifier}</button>
                })}
              </div>
              <span className="shortcut-plus">+</span>
              <ManualKeySelect
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
  onOpenWindowsSettings: (page: 'bluetooth' | 'sound') => void
  onOpenExternalPage: (page: 'vbcable') => void
  onCheckDevice: () => void
  onMarkDeviceConnected: () => void
  onFinish: () => void
}

const setupStepLabels: Record<SetupStepId, string> = {
  welcome: '开始',
  inputDriver: '驱动安装',
  deviceConnection: '连接设备',
  complete: '完成',
}

function SetupDialog({ state, onClose, onOpenStep, onCompleteStep, onSkipStep, onSkipAll, onReset, onDriverAction, onSkipDriverAction, onMarkDriverInstalled, onProbeAudio, onOpenWindowsSettings, onOpenExternalPage, onCheckDevice, onMarkDeviceConnected, onFinish }: SetupDialogProps) {
  const step = state.currentStep
  return <div className="setup-backdrop" role="presentation">
    <section className="setup-dialog" role="dialog" aria-modal="true" aria-labelledby="setup-title">
      <aside className="setup-progress">
        <div className="setup-brand"><span className="brand-mark">A</span><div><strong>Axonkey</strong><span>首次使用设置</span></div></div>
        <div className="setup-step-list">
          {(Object.keys(setupStepLabels) as SetupStepId[]).map((stepId, index) => {
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
          <h2 id="setup-title">准备好驱动与遥控器</h2>
          <p className="setup-lead">整个过程只在本机完成。两个驱动将在同一页依次安装，全部完成后只需重启 Windows 一次。</p>
          <div className="setup-summary-grid">
            <div><Keyboard size={18} /><strong>按键拦截</strong><span>安装经过校验的 Interception 驱动</span></div>
            <div><AudioLines size={18} /><strong>CABLE 虚拟麦克风</strong><span>安装经过校验的 VB-Audio 官方驱动</span></div>
            <div><Bluetooth size={18} /><strong>连接 RC003</strong><span>通过 Windows 蓝牙配对并唤醒</span></div>
          </div>
          <div className="setup-actions"><button type="button" className="button primary setup-primary" onClick={onCompleteStep}>开始设置 <ChevronRight size={15} /></button></div>
        </div>}
        {step === 'inputDriver' && <DriversSetupScreen
          state={state}
          onAction={onDriverAction}
          onSkipAction={onSkipDriverAction}
          onMarkInstalled={onMarkDriverInstalled}
          onProbeAudio={onProbeAudio}
          onContinue={onCompleteStep}
          onSkip={onSkipStep}
          onOpenSettings={() => onOpenWindowsSettings('sound')}
          onOpenVendorPage={() => onOpenExternalPage('vbcable')}
        />}
        {step === 'deviceConnection' && <div className="setup-screen">
          <span className="setup-hero-icon"><Bluetooth size={24} /></span>
          <span className="section-kicker">DEVICE</span>
          <h2 id="setup-title">连接小米遥控器 RC003</h2>
          <p className="setup-lead">先在 Windows 蓝牙设置中完成配对，再按遥控器任意按键将它唤醒。Axonkey 只处理 VID 2717 / PID 32B8 的目标设备。</p>
          <div className={`setup-status-panel ${state.device.status}`}><span className="setup-status-dot" /><div><strong>{state.device.status === 'connected' ? 'RC003 已连接' : state.device.status === 'checking' ? '正在检查设备' : '尚未确认连接'}</strong><span>{state.device.message ?? '打开系统设置完成蓝牙配对，然后返回这里检查。'}</span></div></div>
          <div className="setup-inline-actions"><button type="button" className="dialog-secondary" onClick={() => onOpenWindowsSettings('bluetooth')}><Bluetooth size={14} /> 打开蓝牙设置</button><button type="button" className="dialog-secondary" onClick={onCheckDevice}><RotateCcw size={14} /> 重新检测</button><button type="button" className="dialog-secondary" onClick={onMarkDeviceConnected}><Check size={14} /> 我已连接</button></div>
          <div className="setup-actions"><button type="button" className="setup-text-button" onClick={onSkipStep}>稍后连接</button><button type="button" className="button primary setup-primary" disabled={state.device.status !== 'connected'} onClick={onCompleteStep}>继续 <ChevronRight size={15} /></button></div>
        </div>}
        {step === 'complete' && <div className="setup-screen setup-complete">
          <span className="setup-hero-icon success"><Check size={26} /></span>
          <span className="section-kicker">READY</span>
          <h2 id="setup-title">基本设置已完成</h2>
          <p className="setup-lead">映射配置会自动保存。以后点击顶部的设备状态卡，可以重新打开这里安装、卸载驱动或检查 RC003 连接。</p>
          <div className="setup-result-list">
            <span><Keyboard size={15} /> 按键驱动：{driverStatusLabel(state.drivers.input.status)}</span>
            <span><AudioLines size={15} /> CABLE 麦克风：{driverStatusLabel(state.drivers.audio.status)}</span>
            <span><Bluetooth size={15} /> RC003：{state.device.status === 'connected' ? '已连接' : '稍后连接'}</span>
          </div>
          <div className="setup-actions"><button type="button" className="button primary setup-primary" onClick={onFinish}>进入按键映射</button></div>
        </div>}
      </div>
    </section>
  </div>
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
    ? '经过校验的 Interception 驱动，仅用于识别 RC003 按键。'
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
