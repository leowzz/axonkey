import {
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  ChevronUp,
  Command,
  Home,
  Menu,
  Mic,
  Power,
  Tv,
  Undo2,
  Volume1,
  Volume2,
  VolumeX,
  Settings,
} from 'lucide-react'
import { createBehavior, createDefaultBehaviorMap, parseStoredBehaviors } from './behaviorModel'
import { triggerTypes } from './behaviorModel'
import type { Behavior, BehaviorMap, BehaviorType, ButtonId, InputId, TriggerType } from './behaviorModel'
import { inputIds } from './deviceModel'
import type { DeviceId } from './deviceModel'
import { createDefaultDeviceProfiles, extractDeviceBehaviors, parseStoredDeviceProfiles } from './deviceProfiles'
import type {
  AppPage,
  ManualKeyOption,
  MappingProfile,
  Platform,
  RemoteButton,
  StoredProfiles,
  StoredSettings,
} from './appTypes'
import type { KeyboardEvent } from 'react'
import { xiaomiRemoteButtons, cmiotA15RemoteButtons } from './devices/index.ts'

export const detectBrowserPlatform = (): Platform => {
  if (typeof navigator === 'undefined') return 'windows'
  return /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent) ? 'macos' : 'windows'
}

export async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
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

/** RC003 is kept as the historical export used by integrations and tests. */
export const buttons: RemoteButton[] = xiaomiRemoteButtons
export const allRemoteButtons: RemoteButton[] = [...xiaomiRemoteButtons, ...cmiotA15RemoteButtons]

export const settingsStorageKey = 'axonkey.settings.v1'
export const profilesStorageKey = 'axonkey.mapping-profiles.v2'
export const uiStateStorageKey = 'axonkey.ui-state.v1'
export const audioSettingsStorageKey = 'axonkey.audio-settings.v2'
export const audioGainMin = -30
export const audioGainMax = 30
export const defaultAudioGain = 0

export type StoredUiState = {
  sidebarCollapsed: boolean
  activePage: AppPage
  selectedDeviceId: DeviceId
  activeId: ButtonId
  selectedBehavior: { buttonId: InputId; trigger: TriggerType }
  settingsSection: 'startup' | 'permissions' | 'remote' | 'backup'
  scrollTop: Partial<Record<AppPage, number>>
}

const appPages: readonly AppPage[] = ['home', 'mapping', 'settings', 'device-settings', 'about']
const settingsSections = ['startup', 'permissions', 'remote', 'backup'] as const
const deviceIds: readonly DeviceId[] = ['rc003', 'cmiotA15', 'mouse']

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isKnownTrigger(value: unknown): value is TriggerType {
  return typeof value === 'string' && (triggerTypes as readonly string[]).includes(value)
}

function isKnownRemoteButton(value: unknown): value is ButtonId {
  return typeof value === 'string' && allRemoteButtons.some(button => button.id === value)
}

function isKnownInput(value: unknown): value is InputId {
  return typeof value === 'string' && (inputIds as readonly string[]).includes(value)
}

const defaultUiState: StoredUiState = {
  sidebarCollapsed: false,
  activePage: 'home',
  selectedDeviceId: 'rc003',
  activeId: 'voice',
  selectedBehavior: { buttonId: 'voice', trigger: 'click' },
  settingsSection: 'startup',
  scrollTop: {},
}

export function getStoredUiState(): StoredUiState {
  if (typeof window === 'undefined') return defaultUiState
  const fallback = { ...defaultUiState, sidebarCollapsed: window.matchMedia?.('(max-width: 1200px)')?.matches === true }
  try {
    const stored = window.localStorage.getItem(uiStateStorageKey)
    if (!stored) return fallback
    const parsed = JSON.parse(stored) as unknown
    if (!isRecord(parsed)) return fallback

    const selectedBehavior =
      isRecord(parsed.selectedBehavior) &&
      isKnownInput(parsed.selectedBehavior.buttonId) &&
      isKnownTrigger(parsed.selectedBehavior.trigger)
        ? { buttonId: parsed.selectedBehavior.buttonId, trigger: parsed.selectedBehavior.trigger }
        : defaultUiState.selectedBehavior
    const storedScrollTop = isRecord(parsed.scrollTop) ? parsed.scrollTop : null
    const scrollTop = storedScrollTop
      ? (Object.fromEntries(
          appPages.flatMap(page => {
            const value = storedScrollTop[page]
            return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? [[page, value]] : []
          }),
        ) as Partial<Record<AppPage, number>>)
      : {}

    return {
      sidebarCollapsed:
        typeof parsed.sidebarCollapsed === 'boolean' ? parsed.sidebarCollapsed : fallback.sidebarCollapsed,
      activePage:
        parsed.activePage === 'mappingFlow'
          ? 'mapping'
          : parsed.activePage === 'overview' || parsed.activePage === 'devices'
            ? 'home'
            : typeof parsed.activePage === 'string' && appPages.includes(parsed.activePage as AppPage)
              ? (parsed.activePage as AppPage)
              : defaultUiState.activePage,
      selectedDeviceId:
        typeof parsed.selectedDeviceId === 'string' && deviceIds.includes(parsed.selectedDeviceId as DeviceId)
          ? (parsed.selectedDeviceId as DeviceId)
          : defaultUiState.selectedDeviceId,
      activeId: isKnownRemoteButton(parsed.activeId) ? parsed.activeId : defaultUiState.activeId,
      selectedBehavior,
      settingsSection:
        typeof parsed.settingsSection === 'string' &&
        settingsSections.includes(parsed.settingsSection as StoredUiState['settingsSection'])
          ? (parsed.settingsSection as StoredUiState['settingsSection'])
          : defaultUiState.settingsSection,
      scrollTop,
    }
  } catch {
    return fallback
  }
}

export function saveStoredUiState(state: StoredUiState) {
  if (typeof window === 'undefined') return
  try {
    window.localStorage.setItem(uiStateStorageKey, JSON.stringify(state))
  } catch {
    // UI state is best-effort and must not interrupt editing when storage is unavailable.
  }
}

export function getStoredSettings(): StoredSettings {
  const fallback: StoredSettings = {
    cmiotA15RecordingMode: 'hold',
    mouseEdgeWidth: 8,
    showRemoteKeyGrid: true,
    showMouseKeyGrid: false,
    behaviors: createDefaultBehaviorMap(),
    enabled: true,
    mouseEnabled: true,
    mouseVerticalScrollIntervalMs: 50,
    mouseHorizontalScrollIntervalMs: 50,
    mouseKeyHoldMs: 10,
    mouseScrollSensitivity: 100,
    mouseIgnoreScrollAcceleration: true,
  }
  if (typeof window === 'undefined') return fallback
  try {
    const stored = window.localStorage.getItem(settingsStorageKey)
    if (!stored) return fallback
    const parsed = JSON.parse(stored) as Record<string, unknown>
    return {
      mouseEdgeWidth:
        typeof parsed.mouseEdgeWidth === 'number' && Number.isFinite(parsed.mouseEdgeWidth)
          ? Math.max(1, Math.min(100, Math.round(parsed.mouseEdgeWidth)))
          : 8,
      cmiotA15RecordingMode: parsed.cmiotA15RecordingMode === 'click' ? 'click' : 'hold',
      showRemoteKeyGrid: parsed.showRemoteKeyGrid !== false,
      showMouseKeyGrid: parsed.showMouseKeyGrid === true,
      behaviors: parseStoredBehaviors(parsed),
      enabled: parsed.enabled !== false,
      mouseEnabled: parsed.mouseEnabled !== false,
      mouseHorizontalScrollIntervalMs:
        typeof parsed.mouseHorizontalScrollIntervalMs === 'number' &&
        Number.isFinite(parsed.mouseHorizontalScrollIntervalMs)
          ? Math.max(0, Math.min(10000, Math.round(parsed.mouseHorizontalScrollIntervalMs)))
          : 50,
      mouseVerticalScrollIntervalMs:
        typeof parsed.mouseVerticalScrollIntervalMs === 'number' &&
        Number.isFinite(parsed.mouseVerticalScrollIntervalMs)
          ? Math.max(0, Math.min(10000, Math.round(parsed.mouseVerticalScrollIntervalMs)))
          : 50,
      mouseIgnoreScrollAcceleration: parsed.mouseIgnoreScrollAcceleration !== false,
      mouseScrollSensitivity:
        typeof parsed.mouseScrollSensitivity === 'number' && Number.isFinite(parsed.mouseScrollSensitivity)
          ? Math.max(25, Math.min(400, Math.round(parsed.mouseScrollSensitivity)))
          : 100,
      mouseKeyHoldMs:
        typeof parsed.mouseKeyHoldMs === 'number' && Number.isFinite(parsed.mouseKeyHoldMs)
          ? Math.max(0, Math.min(1000, Math.round(parsed.mouseKeyHoldMs)))
          : 10,
    }
  } catch {
    return fallback
  }
}

function createProfileId() {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') return crypto.randomUUID()
  return `profile-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
}

function cleanProfileName(value: unknown, fallback = '默认配置') {
  if (typeof value !== 'string') return fallback
  const name = value
    .trim()
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .slice(0, 40)
  return name || fallback
}

/** Read the current device-profile store. */
export function getStoredProfiles(): StoredProfiles {
  const behaviors = createDefaultBehaviorMap()
  const fallback = createDefaultDeviceProfiles(behaviors)
  if (typeof window === 'undefined') return fallback
  try {
    const stored = window.localStorage.getItem(profilesStorageKey)
    return parseStoredDeviceProfiles(stored, behaviors)
  } catch {
    return fallback
  }
}

export function createMappingProfile(name: string, behaviors: BehaviorMap, deviceId: DeviceId): MappingProfile {
  return {
    id: createProfileId(),
    name: cleanProfileName(name),
    deviceId,
    behaviors: extractDeviceBehaviors(behaviors, deviceId),
  }
}

export function normalizeProfileName(value: string, fallback = '配置文件') {
  return cleanProfileName(value, fallback)
}

export function getStoredAudioGain() {
  if (typeof window === 'undefined') return defaultAudioGain
  try {
    const parsed = JSON.parse(window.localStorage.getItem(audioSettingsStorageKey) ?? '{}') as Record<string, unknown>
    const gain =
      typeof parsed.gain === 'number' && Number.isFinite(parsed.gain) ? Math.round(parsed.gain) : defaultAudioGain
    return Math.max(audioGainMin, Math.min(audioGainMax, gain))
  } catch {
    return defaultAudioGain
  }
}

export function getStoredAudioStretchCompensation() {
  if (typeof window === 'undefined') return false
  try {
    const parsed: unknown = JSON.parse(window.localStorage.getItem(audioSettingsStorageKey) ?? '{}')
    return isRecord(parsed) && parsed.stretchCompensation === true
  } catch {
    return false
  }
}

export const iconFor = (kind: RemoteButton['icon'], size = 16) => {
  const props = { size, strokeWidth: 1.8 }
  switch (kind) {
    case 'power':
      return <Power {...props} />
    case 'mic':
      return <Mic {...props} />
    case 'up':
      return <ChevronUp {...props} />
    case 'left':
      return <ChevronLeft {...props} />
    case 'right':
      return <ChevronRight {...props} />
    case 'down':
      return <ChevronDown {...props} />
    case 'back':
      return <Undo2 {...props} />
    case 'volumeUp':
      return <Volume2 {...props} />
    case 'volumeDown':
      return <Volume1 {...props} />
    case 'home':
      return <Home {...props} />
    case 'menu':
      return <Menu {...props} />
    case 'tv':
      return <Tv {...props} />
    case 'mute':
      return <VolumeX {...props} />
    case 'settings':
      return <Settings {...props} />
    case 'm':
      return (
        <svg
          width={size}
          height={size}
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth={1.8}
          aria-hidden="true"
        >
          <path d="M5 19V5l7 10 7-10v14" />
        </svg>
      )
    default:
      return <Command {...props} />
  }
}

export const triggerLabels: Record<TriggerType, string> = {
  click: '单击',
  doubleClick: '双击',
  longPress: '长按',
}

export const behaviorTypeLabels: Record<BehaviorType, string> = {
  mouse: '鼠标按键',
  wheel: '鼠标滚轮',
  cursorMove: '光标移动',
  key: '按键 / 组合键',
  shortcut: '按键 / 组合键',
  paste: '粘贴文本',
  delay: '等待',
  openApp: '打开应用',
  openWebsite: '打开网站',
  switchProfile: '切换配置文件',
  disabled: '禁用按键',
}

export const manualKeyGroups: { label: string; options: ManualKeyOption[] }[] = [
  {
    label: '常用按键',
    options: [
      { value: 'Esc', label: '退出（Esc）' },
      { value: 'Enter', label: '回车' },
      { value: 'Space', label: '空格' },
      { value: 'Tab', label: '切换焦点（Tab）' },
      { value: 'Backspace', label: '向前删除' },
      { value: 'Delete', label: '向后删除' },
      { value: 'Insert', label: '插入' },
      { value: 'Home', label: '跳到开头' },
      { value: 'End', label: '跳到结尾' },
      { value: 'PageUp', label: '向上翻页' },
      { value: 'PageDown', label: '向下翻页' },
      { value: 'Up', label: '方向上' },
      { value: 'Down', label: '方向下' },
      { value: 'Left', label: '方向左' },
      { value: 'Right', label: '方向右' },
    ],
  },
  {
    label: '单独修饰键',
    options: [
      { value: 'Ctrl', label: 'Ctrl' },
      { value: 'RCtrl', label: '右 Ctrl' },
      { value: 'Shift', label: 'Shift' },
      { value: 'RShift', label: '右 Shift' },
      { value: 'Alt', label: 'Alt' },
      { value: 'LAlt', label: '左 Alt' },
      { value: 'RAlt', label: '右 Alt' },
      { value: 'Win', label: 'Win' },
      { value: 'RWin', label: '右 Win' },
    ],
  },
  {
    label: '标点符号',
    options: [
      { value: '[', label: '[  左方括号' },
      { value: ']', label: ']  右方括号' },
      { value: '\\', label: '\\  反斜杠' },
      { value: ';', label: ';  分号' },
      { value: "'", label: "'  单引号" },
      { value: ',', label: ',  逗号' },
      { value: '.', label: '.  句点' },
      { value: '/', label: '/  斜杠' },
      { value: '-', label: '-  减号' },
      { value: '=', label: '=  等号' },
      { value: '`', label: '`  反引号' },
    ],
  },
  {
    label: '媒体按键',
    options: [
      { value: 'VolumeUp', label: '增大音量' },
      { value: 'VolumeDown', label: '减小音量' },
      { value: 'VolumeMute', label: '静音' },
      { value: 'MediaPlayPause', label: '播放 / 暂停' },
      { value: 'MediaPrevious', label: '上一首' },
      { value: 'MediaNext', label: '下一首' },
      { value: 'MediaStop', label: '停止播放' },
    ],
  },
  {
    label: '字母与数字',
    options: [
      ...[...'ABCDEFGHIJKLMNOPQRSTUVWXYZ'].map(value => ({ value, label: value })),
      ...[...'0123456789'].map(value => ({ value, label: value })),
    ],
  },
  {
    label: '功能键',
    options: Array.from({ length: 24 }, (_, index) => ({ value: `F${index + 1}`, label: `F${index + 1}` })),
  },
]

const keyLabels = new Map(
  manualKeyGroups.flatMap(group => group.options.map(({ value, label }) => [value, label] as const)),
)

export function keyDisplayName(key: string, platform: Platform) {
  if (platform === 'macos') {
    const labels: Record<string, string> = {
      Ctrl: 'Ctrl',
      RCtrl: '右 Ctrl',
      Alt: 'Opt',
      LAlt: '左 Opt',
      RAlt: '右 Opt',
      Win: 'Cmd',
      RWin: '右 Cmd',
    }
    if (labels[key]) return labels[key]
  }
  return keyLabels.get(key) ?? key
}

export function keyGroupsForPlatform(platform: Platform) {
  if (platform !== 'macos') return manualKeyGroups
  return manualKeyGroups.map(group => {
    if (group.label === '媒体按键') {
      return { ...group, options: group.options.filter(option => option.value !== 'MediaStop') }
    }
    if (group.label !== '单独修饰键') return group
    return {
      ...group,
      options: [
        ...group.options.map(option => ({ ...option, label: keyDisplayName(option.value, platform) })),
        { value: 'Fn', label: 'Fn' },
      ],
    }
  })
}

export const rightModifierKeys = {
  rightCtrl: 'RCtrl',
  rightAlt: 'RAlt',
  rightCommand: 'RWin',
} as const

export function rightModifierChoices() {
  return (Object.keys(rightModifierKeys) as (keyof typeof rightModifierKeys)[]).map(preset => ({
    preset,
    key: rightModifierKeys[preset],
  }))
}

export function isRightModifierPreset(preset: string): preset is keyof typeof rightModifierKeys {
  return Object.prototype.hasOwnProperty.call(rightModifierKeys, preset)
}

export const shortcutModifiers = ['Ctrl', 'Shift', 'Alt', 'Win']
export const standaloneModifierKeys = ['Ctrl', 'RCtrl', 'Shift', 'RShift', 'Alt', 'LAlt', 'RAlt', 'Win', 'RWin', 'Fn']

export function isStandaloneModifierKey(key: string) {
  return standaloneModifierKeys.includes(key)
}

export function behaviorSummary(behavior: Behavior, platform: Platform) {
  switch (behavior.type) {
    case 'wheel':
      return { up: '滚轮向上', down: '滚轮向下', left: '水平滚轮向左', right: '水平滚轮向右' }[behavior.direction]
    case 'mouse':
      return { left: '鼠标左键', right: '鼠标右键', back: '鼠标后退键', forward: '鼠标前进键' }[behavior.button]
    case 'cursorMove':
      return (
        { up: '光标上移', down: '光标下移', left: '光标左移', right: '光标右移' }[behavior.direction] +
        ` ${behavior.distance} 像素`
      )
    case 'key':
      return behavior.key ? keyDisplayName(behavior.key, platform) : '未录入'
    case 'shortcut':
      return behavior.keys.length > 0 ? behavior.keys.map(key => keyDisplayName(key, platform)).join(' + ') : '未录入'
    case 'paste':
      return behavior.text ? `粘贴：${behavior.text.slice(0, 12)}` : '粘贴文本'
    case 'delay':
      return `等待 ${behavior.ms} 毫秒`
    case 'openApp':
      return behavior.path.split(/[\\/]/).pop() || '打开应用'
    case 'openWebsite':
      return behavior.url || '打开网站'
    case 'switchProfile':
      return `${behavior.direction === 'previous' ? '上一个' : '下一个'}配置文件${behavior.wrap ? ' · 循环' : ''}`
    case 'disabled':
      return '不发送任何按键'
  }
}

export function textAndEnterValue(list: Behavior[]) {
  if (list.length !== 3) return null
  const [paste, delay, enter] = list
  if (
    paste.type !== 'paste' ||
    delay.type !== 'delay' ||
    delay.ms !== 30 ||
    enter.type !== 'key' ||
    enter.key !== 'Enter'
  )
    return null
  return paste.text
}

export function triggerSummary(list: Behavior[], trigger: TriggerType, platform: Platform) {
  if (list.length === 0) return trigger === 'click' ? '保留原按键' : '未设置'
  const summary = behaviorSummary(list[0], platform)
  return list.length > 1 ? `${summary} +${list.length - 1}` : summary
}

export function formatCapturedKey(event: KeyboardEvent<HTMLElement>) {
  const keyMap: Record<string, string> = {
    ' ': 'Space',
    Escape: 'Esc',
    Enter: 'Enter',
    Tab: 'Tab',
    Backspace: 'Backspace',
    Delete: 'Delete',
    ArrowUp: 'Up',
    ArrowDown: 'Down',
    ArrowLeft: 'Left',
    ArrowRight: 'Right',
    Meta: 'Win',
    Control: 'Ctrl',
    Shift: 'Shift',
    Alt: 'Alt',
    PageUp: 'PageUp',
    PageDown: 'PageDown',
    Home: 'Home',
    End: 'End',
  }
  const key = keyMap[event.key] ?? (event.key.length === 1 ? event.key.toUpperCase() : event.key)
  if (['Ctrl', 'Shift', 'Alt', 'Win'].includes(key)) return ''
  const modifiers = [
    event.ctrlKey ? 'Ctrl' : '',
    event.shiftKey ? 'Shift' : '',
    event.altKey ? 'Alt' : '',
    event.metaKey ? 'Win' : '',
  ].filter(Boolean)
  return [...modifiers, key].join('+')
}

export function behaviorFromCapturedKey(captured: string, id?: string) {
  const keys = captured.split('+')
  return keys.length > 1
    ? createBehavior({ type: 'shortcut', keys, id })
    : createBehavior({ type: 'key', key: captured, id })
}
