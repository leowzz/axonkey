import { appStorage } from './appStorage'
import { createBehavior, createDefaultBehaviorMap, parseStoredBehaviors, triggerTypes } from './behaviorModel'
import type { BehaviorMap, BehaviorType, ButtonId, InputId, TriggerType } from './behaviorModel'
import { inputIds } from './devices/index.ts'
import type { DeviceId } from './devices/index.ts'
import { createDefaultDeviceProfiles, extractDeviceBehaviors, parseStoredDeviceProfiles } from './deviceProfiles'
import type {
  AppPage,
  MappingEditorStyle,
  MappingProfile,
  Platform,
  RemoteButton,
  StoredProfiles,
  StoredSettings,
} from './appTypes'
import type { KeyboardEvent } from 'react'
import { xiaomiRemoteButtons, cmiotA15RemoteButtons } from './devices/index.ts'

export { iconFor } from './components/InputIcon.tsx'
export {
  behaviorSummary,
  keyDisplayName,
  keyGroupsForPlatform,
  manualKeyGroups,
  textAndEnterValue,
  triggerLabels,
  triggerSummary,
} from './behaviorSummary.ts'

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
export const buttons: RemoteButton[] = [...xiaomiRemoteButtons]
export const allRemoteButtons: RemoteButton[] = [...xiaomiRemoteButtons, ...cmiotA15RemoteButtons]

export const settingsStorageKey = 'axonkey.settings.v1'
export const profilesStorageKey = 'axonkey.mapping-profiles.v2'
export const uiStateStorageKey = 'axonkey.ui-state.v1'
export const audioSettingsStorageKey = 'axonkey.audio-settings.v2'
export const audioGainMin = -30
export const audioGainMax = 30
export const defaultAudioGain = 0

export type StoredUiState = {
  mappingStyle: MappingEditorStyle
  sidebarCollapsed: boolean
  activePage: AppPage
  selectedDeviceId: DeviceId
  activeId: ButtonId
  selectedBehavior: { buttonId: InputId; trigger: TriggerType }
  settingsSection: 'startup' | 'permissions' | 'remote' | 'backup' | 'cloud' | 'about'
  scrollTop: Partial<Record<AppPage, number>>
}

const appPages: readonly AppPage[] = ['home', 'mapping', 'settings']
const settingsSections = ['startup', 'permissions', 'remote', 'backup', 'cloud', 'about'] as const
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
  mappingStyle: 'flow',
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
    const stored = appStorage.getItem(uiStateStorageKey)
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
      mappingStyle: parsed.mappingStyle === 'legacy' ? 'legacy' : 'flow',
      sidebarCollapsed:
        typeof parsed.sidebarCollapsed === 'boolean' ? parsed.sidebarCollapsed : fallback.sidebarCollapsed,
      activePage:
        parsed.activePage === 'about'
          ? 'settings'
          : parsed.activePage === 'mappingFlow' || parsed.activePage === 'device-settings'
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
        parsed.activePage === 'about'
          ? 'about'
          : typeof parsed.settingsSection === 'string' &&
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
    appStorage.setItem(uiStateStorageKey, JSON.stringify(state))
  } catch {
    // UI state is best-effort and must not interrupt editing when storage is unavailable.
  }
}

export function getStoredSettings(): StoredSettings {
  const fallback: StoredSettings = {
    showRecordingOverlay: true,
    cmiotA15RecordingMode: 'click',
    mouseEdgeWidth: 8,
    showRemoteKeyGrid: true,
    showMouseKeyGrid: false,
    behaviors: createDefaultBehaviorMap(),
    enabled: true,
    mouseEnabled: true,
    mouseVerticalScrollIntervalMs: 50,
    mouseHorizontalScrollIntervalMs: 300,
    mouseKeyHoldMs: 10,
    mouseScrollSensitivity: 100,
    mouseIgnoreScrollAcceleration: true,
  }
  if (typeof window === 'undefined') return fallback
  try {
    const stored = appStorage.getItem(settingsStorageKey)
    if (!stored) return fallback
    const parsed = JSON.parse(stored) as Record<string, unknown>
    return {
      mouseEdgeWidth:
        typeof parsed.mouseEdgeWidth === 'number' && Number.isFinite(parsed.mouseEdgeWidth)
          ? Math.max(1, Math.min(100, Math.round(parsed.mouseEdgeWidth)))
          : 8,
      cmiotA15RecordingMode: parsed.cmiotA15RecordingMode === 'hold' ? 'hold' : 'click',
      showRecordingOverlay: parsed.showRecordingOverlay !== false,
      showRemoteKeyGrid: parsed.showRemoteKeyGrid !== false,
      showMouseKeyGrid: parsed.showMouseKeyGrid === true,
      behaviors: parseStoredBehaviors(parsed),
      enabled: parsed.enabled !== false,
      mouseEnabled: parsed.mouseEnabled !== false,
      mouseHorizontalScrollIntervalMs:
        typeof parsed.mouseHorizontalScrollIntervalMs === 'number' &&
        Number.isFinite(parsed.mouseHorizontalScrollIntervalMs)
          ? Math.max(0, Math.min(10000, Math.round(parsed.mouseHorizontalScrollIntervalMs)))
          : 300,
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
    const stored = appStorage.getItem(profilesStorageKey)
    return parseStoredDeviceProfiles(stored, behaviors)
  } catch {
    return fallback
  }
}

export function createMappingProfile(
  name: string,
  behaviors: BehaviorMap,
  deviceId: DeviceId,
  quick = false,
  promptMode = false,
): MappingProfile {
  return {
    id: createProfileId(),
    name: cleanProfileName(name),
    deviceId,
    behaviors: extractDeviceBehaviors(behaviors, deviceId),
    ...(quick ? { quick: true } : {}),
    ...(quick && promptMode ? { promptMode: true } : {}),
  }
}

export function normalizeProfileName(value: string, fallback = '配置文件') {
  return cleanProfileName(value, fallback)
}

export function getStoredAudioGain() {
  if (typeof window === 'undefined') return defaultAudioGain
  try {
    const parsed = JSON.parse(appStorage.getItem(audioSettingsStorageKey) ?? '{}') as Record<string, unknown>
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
    const parsed: unknown = JSON.parse(appStorage.getItem(audioSettingsStorageKey) ?? '{}')
    return isRecord(parsed) && parsed.stretchCompensation === true
  } catch {
    return false
  }
}

export const behaviorTypeLabels: Record<BehaviorType, string> = {
  mouse: '鼠标按键',
  wheel: '鼠标滚轮',
  cursorMove: '光标移动',
  key: '按键 / 组合键',
  shortcut: '按键 / 组合键',
  paste: '粘贴文本',
  typeText: '模拟输入文字',
  copyText: '写入剪贴板',
  openPath: '打开文件或文件夹',
  delay: '等待',
  openApp: '打开应用',
  openWebsite: '打开网站',
  runCommand: '执行命令',
  httpRequest: '发送 HTTP 请求',
  switchProfile: '切换配置文件',
  quickOverlay: '快捷交互窗',
  disabled: '禁用按键',
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
