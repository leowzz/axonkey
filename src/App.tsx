import {
  ArrowDown,
  ArrowUp,
  AudioLines,
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
  GripVertical,
  Home,
  Keyboard,
  Menu,
  Mic,
  Pencil,
  Power,
  Plus,
  RotateCcw,
  Settings2,
  Target,
  Trash2,
  Clock3,
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
import {
  KeyboardEvent,
  PointerEvent as ReactPointerEvent,
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
  audio_available: boolean
  rc003_connected: boolean
  input_backend_ready: boolean
  input_backend_error?: string | null
  device_hardware_id?: string | null
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
  key: '按键',
  shortcut: '组合键',
  paste: '粘贴文本',
  delay: '延迟',
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
    label: '修饰键',
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

function behaviorSummary(behavior: Behavior) {
  switch (behavior.type) {
    case 'key': return behavior.key || '未录入'
    case 'shortcut': return behavior.keys.length > 0 ? behavior.keys.join(' + ') : '未录入'
    case 'paste': return behavior.text ? `粘贴：${behavior.text.slice(0, 12)}` : '粘贴文本'
    case 'delay': return `等待 ${behavior.ms} ms`
  }
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
  const [newBehaviorType, setNewBehaviorType] = useState<BehaviorType>('key')
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
  const [connectors, setConnectors] = useState<Connector[]>([])

  const updateBehaviorState = useCallback((next: BehaviorMap) => {
    setBehaviors(next)
    setAutoSaveState('saving')
  }, [])

  const updateSelectedBehaviorList = useCallback((update: (list: Behavior[]) => Behavior[]) => {
    setBehaviors((current) => updateBehaviorList(current, selectedBehavior.buttonId, selectedBehavior.trigger, update))
    setAutoSaveState('saving')
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
      try {
        const level = await invoke<number | null>('probe_rc003_battery_level')
        if (active) setBatteryLevel(typeof level === 'number' && level >= 0 && level <= 100 ? Math.round(level) : null)
      } catch {
        if (active) setBatteryLevel(null)
      }
    }
    const handleFocus = () => void refreshBattery()
    void refreshBattery()
    const interval = window.setInterval(refreshBattery, 60_000)
    window.addEventListener('focus', handleFocus)
    return () => {
      active = false
      window.clearInterval(interval)
      window.removeEventListener('focus', handleFocus)
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
  }

  const addBehavior = () => {
    const behavior = createBehavior({ type: newBehaviorType })
    updateSelectedBehaviorList((list) => [...list, behavior])
    setEditingBehaviorId(behavior.id)
    setCapturingBehaviorId(null)
    setToast(`${behaviorTypeLabels[newBehaviorType]}行为已添加`)
    window.setTimeout(() => setToast(''), 1600)
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
    updateBehavior(behavior.id, (current) => current.type === 'shortcut'
      ? { ...current, keys: captured.split('+') }
      : current.type === 'key'
        ? { ...current, key: captured }
        : current)
    setCapturingBehaviorId(null)
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
    if (driver === 'audio') {
      updateSetup((current) => finishDriverAction(current, driver, action, {
        success: true,
        status: action === 'install' ? 'installed' : 'missing',
        message: action === 'install' ? '已由用户确认安装。' : '已标记为手动卸载；系统驱动仍需在 Windows 中移除。',
      }))
      return
    }
    try {
      await invoke('launch_driver_action', { driver, action })
      updateSetup((current) => finishDriverAction(current, driver, action, {
        success: true,
        status: action === 'install' ? 'missing' : 'installed',
        restartRequired: false,
        message: action === 'install' ? '已请求管理员权限；批准后驱动将在后台安装，完成后请重启 Windows。' : '已请求管理员权限；批准后驱动将在后台卸载，完成后请重启 Windows。',
      }))
    } catch (error) {
      const browserPreview = typeof window !== 'undefined' && !('__TAURI_INTERNALS__' in window)
      updateSetup((current) => finishDriverAction(current, driver, action, {
        success: false,
        status: current.drivers[driver].status,
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

  const probeSystemState = async () => {
    if (typeof window === 'undefined' || !('__TAURI_INTERNALS__' in window)) return false
    updateSetup((current) => {
      let next = setDriverStatus(current, 'input', 'checking', { message: '正在检查按键拦截驱动…' })
      next = setDriverStatus(next, 'audio', 'checking', { message: '正在检查音频设备…' })
      return setDeviceConnection(next, { status: 'checking', message: '正在检查 RC003…' })
    })
    try {
      const probe = await invoke<SystemProbe>('probe_system_state')
      updateSetup((current) => {
        const inputStatus = !probe.input_driver_installed ? 'missing' : probe.input_backend_error ? 'error' : 'installed'
        const inputMessage = !probe.input_driver_installed
          ? '未检测到 Interception 按键驱动。'
          : probe.input_backend_error
            ? `驱动已安装，但输入服务启动失败：${probe.input_backend_error}`
            : probe.input_backend_ready
              ? 'Interception 按键服务工作正常。'
              : '已检测到 Interception 按键驱动，输入服务正在启动。'
        let next = setDriverStatus(current, 'input', inputStatus, { message: inputMessage })
        next = setDriverStatus(next, 'audio', probe.audio_available ? 'installed' : 'missing', { message: probe.audio_available ? 'Windows 音频设备工作正常。' : '未检测到可用的 Windows 音频设备。' })
        return setDeviceConnection(next, probe.rc003_connected
          ? {
            status: 'connected',
            name: '小米遥控器 RC003',
            hardwareId: probe.device_hardware_id ?? undefined,
            message: probe.device_hardware_id
              ? 'Interception 输入服务已识别并接管 RC003。'
              : 'Windows 已检测到 RC003；按任意键唤醒后即可接管输入。',
          }
          : { status: 'disconnected', message: '未检测到 RC003，请确认蓝牙已配对并按任意键唤醒。' })
      })
      return true
    } catch (error) {
      updateSetup((current) => setDeviceConnection(current, { status: 'error', message: String(error) }))
      return false
    }
  }

  const checkDeviceConnection = () => {
    if (typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window) {
      void probeSystemState()
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

  return (
    <div className="app-shell">
      <main className="main-content">
        <header className="topbar">
          <div className="topbar-left">
            <button className="brand-lockup compact brand-trigger" type="button" aria-label="Axonkey" title="Axonkey" onClick={handleBrandClick}>
              <span className="brand-mark">A</span>
              <span>
                <span className="brand-name">axonkey</span>
                <span className="brand-version">RC003 控制台 <span>0.1</span></span>
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
        <BehaviorEditor
          button={buttons.find((button) => button.id === selectedBehavior.buttonId) ?? buttons[0]}
          trigger={selectedBehavior.trigger}
          behaviors={behaviors[selectedBehavior.buttonId][selectedBehavior.trigger]}
          newBehaviorType={newBehaviorType}
          onNewBehaviorType={setNewBehaviorType}
          onAddBehavior={addBehavior}
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
        onMarkDriverInstalled={(driver) => updateSetup((current) => setDriverStatus(current, driver, driver === 'input' ? 'restartRequired' : 'installed', { restartRequired: driver === 'input', message: driver === 'input' ? '已确认安装，重启 Windows 后驱动生效。' : '已由用户确认安装。' }))}
        onMarkDriverRemoved={(driver) => updateSetup((current) => setDriverStatus(current, driver, 'missing', { restartRequired: driver === 'input', message: driver === 'input' ? '已确认卸载，重启 Windows 后完成移除。' : '已由用户确认卸载。' }))}
        onOpenWindowsSettings={(page) => void openWindowsSettings(page)}
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
  newBehaviorType: BehaviorType
  onNewBehaviorType: (type: BehaviorType) => void
  onAddBehavior: () => void
  onRemoveBehavior: (behaviorId: string) => void
  onMoveBehavior: (behaviorId: string, direction: -1 | 1) => void
  onEditBehavior: (behaviorId: string) => void
}

function BehaviorEditor({ button, trigger, behaviors, newBehaviorType, onNewBehaviorType, onAddBehavior, onRemoveBehavior, onMoveBehavior, onEditBehavior }: BehaviorEditorProps) {
  return <section className="behavior-editor" aria-label={`${button.label}${triggerLabels[trigger]}行为配置`}>
    <div className="behavior-editor-head">
      <div className="behavior-editor-title">
        <span className={`row-icon icon-${button.icon}`}>{iconFor(button.icon, 17)}</span>
        <div><h2>{button.label} · {triggerLabels[trigger]}</h2><p>按顺序执行下面的行为，支持连续组合</p></div>
      </div>
      <span className="behavior-trigger-pill"><GripVertical size={13} /> {behaviors.length ? `${behaviors.length} 个行为` : '尚未配置'}</span>
    </div>
    <div className="behavior-editor-body">
      <div className="behavior-list">
        {behaviors.length === 0 && <div className="behavior-empty">这个触发方式暂时保留原按键，点击右侧添加第一个行为</div>}
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
      <aside className="behavior-side">
        <span className="behavior-side-label">添加行为</span>
        <div className="behavior-add-row">
          <select aria-label="选择行为类型" value={newBehaviorType} onChange={(event) => onNewBehaviorType(event.target.value as BehaviorType)}>
            <option value="key">按键</option>
            <option value="shortcut">组合键</option>
            <option value="paste">粘贴文本</option>
            <option value="delay">延迟</option>
          </select>
          <button type="button" className="button primary" onClick={onAddBehavior}><Plus size={14} /> 添加</button>
        </div>
        <p className="behavior-tip">新增后在弹窗中编辑，所有更改都会自动保存并立即生效。</p>
      </aside>
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
  return <div className="behavior-item">
    <span className="behavior-item-index">{String(index + 1).padStart(2, '0')}</span>
    <button type="button" className="behavior-item-summary" onClick={() => onEdit(behavior.id)}>
      <span className="behavior-type-label">{behaviorTypeLabels[behavior.type]}</span>
      <strong>{behaviorSummary(behavior)}</strong>
      <span className="behavior-type-note">点击编辑</span>
    </button>
    <div className="behavior-item-actions">
      <button type="button" className="icon-button" title="编辑" aria-label="编辑行为" onClick={() => onEdit(behavior.id)}><Pencil size={14} /></button>
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
  onStartCapture: () => void
  onCancelCapture: () => void
  onCaptureKey: (behavior: Behavior, event: KeyboardEvent<HTMLElement>) => void
  onUpdate: (update: (behavior: Behavior) => Behavior) => void
  onClose: () => void
}

function ManualKeySelect({ value, onChange, label, includeModifiers = true }: { value: string; onChange: (value: string) => void; label: string; includeModifiers?: boolean }) {
  const groups = includeModifiers ? manualKeyGroups : manualKeyGroups.filter((group) => group.label !== '修饰键')
  const knownValue = groups.some((group) => group.options.some((option) => option.value === value)) ? value : ''
  return <select value={knownValue} aria-label={label} onChange={(event) => onChange(event.target.value)}>
    <option value="" disabled>{value && !knownValue ? `当前：${value}` : '选择按键'}</option>
    {groups.map((group) => <optgroup key={group.label} label={group.label}>
      {group.options.map((option) => <option key={`${group.label}-${option.value}`} value={option.value}>{option.label}</option>)}
    </optgroup>)}
  </select>
}

function BehaviorEditDialog({ button, trigger, behavior, capturing, onStartCapture, onCancelCapture, onCaptureKey, onUpdate, onClose }: BehaviorEditDialogProps) {
  const captureValue = behavior.type === 'shortcut' ? behavior.keys.join(' + ') : behavior.type === 'key' ? behavior.key : ''
  const shortcutBase = behavior.type === 'shortcut' ? behavior.keys.find((key) => !shortcutModifiers.includes(key)) ?? 'C' : 'C'
  const setShortcut = (modifiers: string[], base: string) => {
    onUpdate((current) => current.type === 'shortcut' ? { ...current, keys: [...modifiers, base] } : current)
  }
  return <div className="behavior-dialog-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose() }}>
    <section
      className="behavior-dialog"
      role="dialog"
      aria-modal="true"
      aria-labelledby="behavior-dialog-title"
      onKeyDown={(event) => { if (capturing) onCaptureKey(behavior, event) }}
    >
      <header className="behavior-dialog-head">
        <div><span className="section-kicker">{button.label} · {triggerLabels[trigger]}</span><h2 id="behavior-dialog-title">编辑{behaviorTypeLabels[behavior.type]}行为</h2></div>
        <button type="button" className="dialog-close" aria-label="关闭编辑" onClick={onClose}><X size={17} /></button>
      </header>
      <div className="behavior-dialog-body">
        {behavior.type === 'key' || behavior.type === 'shortcut' ? <>
          <div className="behavior-current-value"><span>当前按键</span><strong>{captureValue || '未设置'}</strong></div>
          <div className="behavior-record-row">
            <button type="button" className={`record-key-button ${capturing ? 'capturing' : ''}`} onClick={capturing ? onCancelCapture : onStartCapture}>
              <Keyboard size={17} />
              <span><strong>{capturing ? '等待按键输入…' : '开始录入'}</strong><small>{capturing ? '现在按下目标按键或组合键' : '仅在点击后监听下一次按键'}</small></span>
            </button>
          </div>
          <div className="behavior-manual-section">
            <div className="behavior-field-title"><strong>手动选择</strong><span>录入不到时直接从列表设置</span></div>
            {behavior.type === 'key' ? <ManualKeySelect
              value={behavior.key}
              label="手动选择按键"
              onChange={(key) => { onCancelCapture(); onUpdate((current) => current.type === 'key' ? { ...current, key } : current) }}
            /> : <div className="shortcut-manual-builder">
              <div className="shortcut-modifiers">
                {shortcutModifiers.map((modifier) => {
                  const selected = behavior.keys.includes(modifier)
                  return <button key={modifier} type="button" className={selected ? 'selected' : ''} aria-pressed={selected} onClick={() => {
                    onCancelCapture()
                    const modifiers = shortcutModifiers.filter((item) => item === modifier ? !selected : behavior.keys.includes(item))
                    setShortcut(modifiers, shortcutBase)
                  }}>{modifier}</button>
                })}
              </div>
              <span className="shortcut-plus">+</span>
              <ManualKeySelect
                value={shortcutBase}
                label="手动选择组合键的基础按键"
                includeModifiers={false}
                onChange={(base) => { onCancelCapture(); setShortcut(shortcutModifiers.filter((modifier) => behavior.keys.includes(modifier)), base) }}
              />
            </div>}
          </div>
        </> : behavior.type === 'paste' ? <div className="behavior-dialog-field"><label htmlFor="behavior-paste-text">粘贴内容</label><textarea
          id="behavior-paste-text"
          className="behavior-paste-input"
          value={behavior.text}
          placeholder="输入要粘贴的文本"
          onChange={(event) => onUpdate((current) => current.type === 'paste' ? { ...current, text: event.target.value } : current)}
        /></div> : <div className="behavior-dialog-field"><label htmlFor="behavior-delay-ms">延迟时间</label><div className="behavior-delay-row"><Clock3 size={16} /><input id="behavior-delay-ms" className="behavior-delay-input" type="number" min="0" max="300000" step="50" value={behavior.ms} onChange={(event) => onUpdate((current) => current.type === 'delay' ? { ...current, ms: Math.max(0, Math.min(300000, Number(event.target.value) || 0)) } : current)} /><span>毫秒</span></div></div>}
      </div>
      <footer className="behavior-dialog-actions"><span><Check size={13} /> 更改会自动保存</span><button type="button" className="button primary" onClick={onClose}>完成</button></footer>
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
  onMarkDriverRemoved: (driver: DriverKind) => void
  onOpenWindowsSettings: (page: 'bluetooth' | 'sound') => void
  onCheckDevice: () => void
  onMarkDeviceConnected: () => void
  onFinish: () => void
}

const setupStepLabels: Record<SetupStepId, string> = {
  welcome: '开始',
  inputDriver: '按键驱动',
  audioDriver: '音频驱动',
  deviceConnection: '连接设备',
  complete: '完成',
}

function SetupDialog({ state, onClose, onOpenStep, onCompleteStep, onSkipStep, onSkipAll, onReset, onDriverAction, onSkipDriverAction, onMarkDriverInstalled, onMarkDriverRemoved, onOpenWindowsSettings, onCheckDevice, onMarkDeviceConnected, onFinish }: SetupDialogProps) {
  const step = state.currentStep
  return <div className="setup-backdrop" role="presentation">
    <section className="setup-dialog" role="dialog" aria-modal="true" aria-labelledby="setup-title">
      <aside className="setup-progress">
        <div className="setup-brand"><span className="brand-mark">A</span><div><strong>Axonkey</strong><span>首次使用设置</span></div></div>
        <div className="setup-step-list">
          {(Object.keys(setupStepLabels) as SetupStepId[]).map((stepId, index) => {
            const status = state.steps[stepId].status
            return <button type="button" key={stepId} className={`setup-step ${step === stepId ? 'active' : ''} ${status}`} onClick={() => onOpenStep(stepId)}>
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
          <h2 id="setup-title">准备好按键驱动与遥控器</h2>
          <p className="setup-lead">整个过程只在本机完成。按键拦截驱动需要管理员权限并在安装后重启一次；音频依赖是可选项，每一步都可以跳过。</p>
          <div className="setup-summary-grid">
            <div><Keyboard size={18} /><strong>按键拦截</strong><span>安装经过校验的 Interception 驱动</span></div>
            <div><AudioLines size={18} /><strong>音频依赖</strong><span>可选，可稍后手动配置</span></div>
            <div><Bluetooth size={18} /><strong>连接 RC003</strong><span>通过 Windows 蓝牙配对并唤醒</span></div>
          </div>
          <div className="setup-actions"><button type="button" className="button primary setup-primary" onClick={onCompleteStep}>开始设置 <ChevronRight size={15} /></button></div>
        </div>}
        {step === 'inputDriver' && <DriverSetupScreen
          kind="input"
          state={state}
          onAction={onDriverAction}
          onSkipAction={onSkipDriverAction}
          onMarkInstalled={onMarkDriverInstalled}
          onMarkRemoved={onMarkDriverRemoved}
          onContinue={onCompleteStep}
          onSkip={onSkipStep}
        />}
        {step === 'audioDriver' && <DriverSetupScreen
          kind="audio"
          state={state}
          onAction={onDriverAction}
          onSkipAction={onSkipDriverAction}
          onMarkInstalled={onMarkDriverInstalled}
          onMarkRemoved={onMarkDriverRemoved}
          onContinue={onCompleteStep}
          onSkip={onSkipStep}
          onOpenSettings={() => onOpenWindowsSettings('sound')}
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
            <span><AudioLines size={15} /> 音频驱动：{driverStatusLabel(state.drivers.audio.status)}</span>
            <span><Bluetooth size={15} /> RC003：{state.device.status === 'connected' ? '已连接' : '稍后连接'}</span>
          </div>
          <div className="setup-actions"><button type="button" className="button primary setup-primary" onClick={onFinish}>进入按键映射</button></div>
        </div>}
      </div>
    </section>
  </div>
}

type DriverSetupScreenProps = {
  kind: DriverKind
  state: SetupState
  onAction: (driver: DriverKind, action: DriverActionKind) => void
  onSkipAction: (driver: DriverKind, action: DriverActionKind) => void
  onMarkInstalled: (driver: DriverKind) => void
  onMarkRemoved: (driver: DriverKind) => void
  onContinue: () => void
  onSkip: () => void
  onOpenSettings?: () => void
}

function driverStatusLabel(status: SetupState['drivers']['input']['status']) {
  const labels = { unknown: '未检查', checking: '检查中', missing: '未安装', installed: '已安装', restartRequired: '等待重启', error: '操作失败' }
  return labels[status]
}

function DriverSetupScreen({ kind, state, onAction, onSkipAction, onMarkInstalled, onMarkRemoved, onContinue, onSkip, onOpenSettings }: DriverSetupScreenProps) {
  const definition = driverDefinitions[kind]
  const driver = state.drivers[kind]
  const running = driver.action.status === 'running'
  const installed = driver.status === 'installed' || driver.status === 'restartRequired'
  return <div className="setup-screen">
    <span className="setup-hero-icon">{kind === 'input' ? <Keyboard size={24} /> : <AudioLines size={24} />}</span>
    <span className="section-kicker">{kind === 'input' ? 'REQUIRED DRIVER' : 'OPTIONAL DRIVER'}</span>
    <h2 id="setup-title">{definition.title}</h2>
    <p className="setup-lead">{definition.description}</p>
    <div className={`setup-status-panel ${driver.status}`}><span className="setup-status-dot" /><div><strong>{driverStatusLabel(driver.status)}</strong><span>{driver.action.error ?? driver.message ?? (kind === 'input' ? '安装脚本会先校验文件，然后请求管理员权限。' : '当前安装包不包含音频驱动，可通过系统设置手动处理。')}</span></div></div>
    <div className="driver-notice">{kind === 'input' ? <><Download size={16} /><div><strong>安装与卸载需要 Windows 管理员权限</strong><span>点击后只会显示系统 UAC 授权，驱动操作在后台完成；完成后需要重启 Windows。卸载前请先关闭其他使用 Interception 的工具。</span></div></> : <><AudioLines size={16} /><div><strong>这是可选依赖</strong><span>按键映射、组合键和粘贴文本不依赖音频驱动，可以直接跳过。</span></div></>}</div>
    <div className="setup-inline-actions">
      {kind === 'input' && !installed && <button type="button" className="dialog-secondary" disabled={running} onClick={() => onAction(kind, 'install')}><Download size={14} /> {running ? '正在请求授权…' : '安装驱动'}</button>}
      {kind === 'input' && installed && <button type="button" className="dialog-secondary danger" disabled={running} onClick={() => onAction(kind, 'uninstall')}><Trash2 size={14} /> 卸载驱动</button>}
      {kind === 'input' && driver.action.kind === 'uninstall' && driver.action.status === 'succeeded' && <button type="button" className="dialog-secondary" onClick={() => onMarkRemoved(kind)}><Check size={14} /> 卸载已完成</button>}
      {kind === 'audio' && <button type="button" className="dialog-secondary" onClick={onOpenSettings}><Settings2 size={14} /> 打开声音设置</button>}
      {!installed && <button type="button" className="dialog-secondary" onClick={() => onMarkInstalled(kind)}><Check size={14} /> 我已手动安装</button>}
      {installed && kind === 'audio' && <button type="button" className="dialog-secondary danger" onClick={() => onMarkRemoved(kind)}><Trash2 size={14} /> 标记已卸载</button>}
    </div>
    <div className="setup-actions"><button type="button" className="setup-text-button" onClick={() => { onSkipAction(kind, installed ? 'uninstall' : 'install'); onSkip() }}>跳过此项</button><button type="button" className="button primary setup-primary" onClick={onContinue}>{installed ? '继续' : '稍后处理并继续'} <ChevronRight size={15} /></button></div>
  </div>
}

export default App
