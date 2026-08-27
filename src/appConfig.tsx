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
  Undo2,
  Volume1,
  Volume2,
} from 'lucide-react'
import {
  createBehavior,
  createDefaultBehaviorMap,
  parseStoredBehaviors,
} from './behaviorModel'
import type { Behavior, BehaviorType, ButtonId, TriggerType } from './behaviorModel'
import type { HitPosition, ManualKeyOption, Platform, RemoteButton, StoredSettings } from './appTypes'
import type { KeyboardEvent } from 'react'

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

export const buttons: RemoteButton[] = [
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

export const macOSOnlyButtonIds = new Set<ButtonId>(['back', 'volumeUp', 'volumeDown'])

export const settingsStorageKey = 'axonkey.settings.v1'
export const audioSettingsStorageKey = 'axonkey.audio-settings.v2'
export const audioGainMin = -30
export const audioGainMax = 30
export const defaultAudioGain = 0

export function getStoredSettings(): StoredSettings {
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

export function getStoredAudioGain() {
  if (typeof window === 'undefined') return defaultAudioGain
  try {
    const parsed = JSON.parse(window.localStorage.getItem(audioSettingsStorageKey) ?? '{}') as Record<string, unknown>
    const gain = typeof parsed.gain === 'number' && Number.isFinite(parsed.gain) ? Math.round(parsed.gain) : defaultAudioGain
    return Math.max(audioGainMin, Math.min(audioGainMax, gain))
  } catch {
    return defaultAudioGain
  }
}

export const iconFor = (kind: RemoteButton['icon'], size = 16) => {
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

export const triggerLabels: Record<TriggerType, string> = {
  click: '单击',
  doubleClick: '双击',
  longPress: '长按',
}

export const behaviorTypeLabels: Record<BehaviorType, string> = {
  key: '按键 / 组合键',
  shortcut: '按键 / 组合键',
  paste: '粘贴文本',
  delay: '等待',
  disabled: '禁用按键',
}

export const manualKeyGroups: { label: string; options: ManualKeyOption[] }[] = [
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

export function keyDisplayName(key: string, platform: Platform) {
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

export function keyGroupsForPlatform(platform: Platform) {
  if (platform !== 'macos') return manualKeyGroups
  return manualKeyGroups.map((group) => group.label !== '单独修饰键'
    ? group
    : {
      ...group,
      options: group.options.map((option) => ({ ...option, label: keyDisplayName(option.value, platform) })),
    })
}

export const shortcutModifiers = ['Ctrl', 'Shift', 'Alt', 'Win']
export const standaloneModifierKeys = ['Ctrl', 'RCtrl', 'Shift', 'RShift', 'Alt', 'LAlt', 'RAlt', 'Win', 'RWin']

export function isStandaloneModifierKey(key: string) {
  return standaloneModifierKeys.includes(key)
}

export function behaviorSummary(behavior: Behavior, platform: Platform) {
  switch (behavior.type) {
    case 'key': return behavior.key ? keyDisplayName(behavior.key, platform) : '未录入'
    case 'shortcut': return behavior.keys.length > 0 ? behavior.keys.map((key) => keyDisplayName(key, platform)).join(' + ') : '未录入'
    case 'paste': return behavior.text ? `粘贴：${behavior.text.slice(0, 12)}` : '粘贴文本'
    case 'delay': return `等待 ${behavior.ms} ms`
    case 'disabled': return '不发送任何按键'
  }
}

export function textAndEnterValue(list: Behavior[]) {
  if (list.length !== 3) return null
  const [paste, delay, enter] = list
  if (paste.type !== 'paste' || delay.type !== 'delay' || delay.ms !== 30 || enter.type !== 'key' || enter.key !== 'Enter') return null
  return paste.text
}

export function cloneBehaviorList(list: Behavior[]) {
  return list.map((behavior) => behavior.type === 'shortcut'
    ? { ...behavior, keys: [...behavior.keys] }
    : { ...behavior })
}

export function triggerSummary(list: Behavior[], trigger: TriggerType, platform: Platform) {
  if (list.length === 0) return trigger === 'click' ? '保留原按键' : '未设置'
  const summary = behaviorSummary(list[0], platform)
  return list.length > 1 ? `${summary} +${list.length - 1}` : summary
}

export function formatCapturedKey(event: KeyboardEvent<HTMLElement>) {
  const keyMap: Record<string, string> = {
    ' ': 'Space', Escape: 'Esc', Enter: 'Enter', Tab: 'Tab', Backspace: 'Backspace', Delete: 'Delete',
    ArrowUp: 'Up', ArrowDown: 'Down', ArrowLeft: 'Left', ArrowRight: 'Right', Meta: 'Win', Control: 'Ctrl',
    Shift: 'Shift', Alt: 'Alt', PageUp: 'PageUp', PageDown: 'PageDown', Home: 'Home', End: 'End',
  }
  const key = keyMap[event.key] ?? (event.key.length === 1 ? event.key.toUpperCase() : event.key)
  if (['Ctrl', 'Shift', 'Alt', 'Win'].includes(key)) return ''
  const modifiers = [event.ctrlKey ? 'Ctrl' : '', event.shiftKey ? 'Shift' : '', event.altKey ? 'Alt' : '', event.metaKey ? 'Win' : ''].filter(Boolean)
  return [...modifiers, key].join('+')
}

export function behaviorFromCapturedKey(captured: string, id?: string) {
  const keys = captured.split('+')
  return keys.length > 1
    ? createBehavior({ type: 'shortcut', keys, id })
    : createBehavior({ type: 'key', key: captured, id })
}

export const initialHitPositions: Record<ButtonId, HitPosition> = {
  power: { x: 24.27, y: 10.92 },
  voice: { x: 75.96, y: 10.92 },
  up: { x: 50.00, y: 21.46 },
  left: { x: 13.39, y: 35.44 },
  confirm: { x: 50.00, y: 35.44 },
  right: { x: 86.61, y: 35.44 },
  down: { x: 50.00, y: 49.73 },
  back: { x: 29.08, y: 59.90 },
  volumeUp: { x: 70.92, y: 59.90 },
  home: { x: 29.08, y: 75.09 },
  volumeDown: { x: 70.92, y: 75.09 },
  menu: { x: 29.08, y: 90.06 },
  tv: { x: 70.92, y: 90.06 },
}

export const hitPositionsStorageKey = 'axonkey.debug-hit-positions.v4'

export function getStoredHitPositions() {
  if (typeof window === 'undefined') return initialHitPositions
  try {
    const stored = window.localStorage.getItem(hitPositionsStorageKey)
    if (!stored) return initialHitPositions
    return { ...initialHitPositions, ...JSON.parse(stored) } as Record<ButtonId, HitPosition>
  } catch {
    return initialHitPositions
  }
}
