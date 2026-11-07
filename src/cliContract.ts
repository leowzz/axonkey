import { normalizeApplicationPath, normalizeBehavior, normalizeFilePath, normalizeWebsiteUrl } from './behaviorModel.ts'
import type { Behavior } from './behaviorModel.ts'
import type { DeviceId, InputId } from './devices/index.ts'
import type { TriggerType } from './behaviorModel.ts'

/** Public version for the local Agent CLI protocol and its JSON documents. */
export const cliSchema = 'axonkey.cli/v1' as const

export type CliRequest = {
  protocol: typeof cliSchema
  id: string
  method: string
  params: unknown
}

export type CliPlatform = 'windows' | 'macos'

export const cliBehaviorTypes = [
  'key',
  'shortcut',
  'wheel',
  'mouse',
  'cursorMove',
  'paste',
  'typeText',
  'delay',
  'openApp',
  'openPath',
  'openWebsite',
  'switchProfile',
  'disabled',
] as const

export type CliBehaviorType = (typeof cliBehaviorTypes)[number]

type CliBehaviorBase = { enabled: boolean }

export type CliBehavior =
  | (CliBehaviorBase & { type: 'key'; key: string })
  | (CliBehaviorBase & { type: 'shortcut'; keys: string[] })
  | (CliBehaviorBase & { type: 'wheel'; direction: 'up' | 'down' | 'left' | 'right' })
  | (CliBehaviorBase & { type: 'mouse'; button: 'left' | 'right' | 'back' | 'forward' })
  | (CliBehaviorBase & { type: 'cursorMove'; direction: 'up' | 'down' | 'left' | 'right'; distance: number })
  | (CliBehaviorBase & { type: 'paste'; text: string })
  | (CliBehaviorBase & { type: 'typeText'; text: string })
  | (CliBehaviorBase & { type: 'delay'; ms: number })
  | (CliBehaviorBase & { type: 'openApp'; path: string })
  | (CliBehaviorBase & { type: 'openPath'; path: string })
  | (CliBehaviorBase & { type: 'openWebsite'; url: string })
  | (CliBehaviorBase & { type: 'switchProfile'; direction: 'previous' | 'next'; wrap: boolean })
  | (CliBehaviorBase & { type: 'disabled' })

/** Agent input may omit enabled; normalized responses always include it. */
export type CliBehaviorInput =
  | (Omit<Extract<CliBehavior, { type: 'key' }>, 'enabled'> & { enabled?: boolean })
  | (Omit<Extract<CliBehavior, { type: 'shortcut' }>, 'enabled'> & { enabled?: boolean })
  | (Omit<Extract<CliBehavior, { type: 'wheel' }>, 'enabled'> & { enabled?: boolean })
  | (Omit<Extract<CliBehavior, { type: 'mouse' }>, 'enabled'> & { enabled?: boolean })
  | (Omit<Extract<CliBehavior, { type: 'cursorMove' }>, 'enabled'> & { enabled?: boolean })
  | (Omit<Extract<CliBehavior, { type: 'paste' }>, 'enabled'> & { enabled?: boolean })
  | (Omit<Extract<CliBehavior, { type: 'typeText' }>, 'enabled'> & { enabled?: boolean })
  | (Omit<Extract<CliBehavior, { type: 'delay' }>, 'enabled'> & { enabled?: boolean })
  | (Omit<Extract<CliBehavior, { type: 'openApp' }>, 'enabled'> & { enabled?: boolean })
  | (Omit<Extract<CliBehavior, { type: 'openPath' }>, 'enabled'> & { enabled?: boolean })
  | (Omit<Extract<CliBehavior, { type: 'openWebsite' }>, 'enabled'> & { enabled?: boolean })
  | (Omit<Extract<CliBehavior, { type: 'switchProfile' }>, 'enabled'> & { enabled?: boolean })
  | (Omit<Extract<CliBehavior, { type: 'disabled' }>, 'enabled'> & { enabled?: boolean })

export type CliBehaviorSequence = CliBehavior[]

export type CliShortcutTarget = {
  device: DeviceId
  button: InputId
  trigger: TriggerType
  profile?: string
}

export type CliShortcutDocument = {
  schema: typeof cliSchema
  target: CliShortcutTarget
  sequence: CliBehaviorSequence
}

const tokenAliases: Record<string, string> = {
  esc: 'Esc',
  escape: 'Esc',
  return: 'Enter',
  spacebar: 'Space',
  backspace: 'Backspace',
  del: 'Delete',
  delete: 'Delete',
  ins: 'Insert',
  insert: 'Insert',
  pgup: 'PageUp',
  pageup: 'PageUp',
  pgdn: 'PageDown',
  pagedown: 'PageDown',
  up: 'Up',
  down: 'Down',
  left: 'Left',
  right: 'Right',
  control: 'Ctrl',
  ctl: 'Ctrl',
  lctrl: 'Ctrl',
  rctrl: 'RCtrl',
  shift: 'Shift',
  lshift: 'Shift',
  rshift: 'RShift',
  alt: 'Alt',
  option: 'Alt',
  opt: 'Alt',
  lalt: 'LAlt',
  loption: 'LAlt',
  lopt: 'LAlt',
  ralt: 'RAlt',
  roption: 'RAlt',
  ropt: 'RAlt',
  command: 'Mod',
  cmd: 'Mod',
  meta: 'Mod',
  super: 'Win',
  windows: 'Win',
  win: 'Win',
  rwin: 'RWin',
  rmeta: 'Mod',
  rcmd: 'Mod',
  rcommand: 'Mod',
  fn: 'Fn',
  volumeup: 'VolumeUp',
  volumedown: 'VolumeDown',
  volumemute: 'VolumeMute',
  mute: 'VolumeMute',
  mediaplaypause: 'MediaPlayPause',
  playpause: 'MediaPlayPause',
  mediaprevious: 'MediaPrevious',
  previous: 'MediaPrevious',
  medianext: 'MediaNext',
  next: 'MediaNext',
  mediastop: 'MediaStop',
}

const canonicalTokens = new Set([
  'Esc',
  'Enter',
  'Space',
  'Tab',
  'Backspace',
  'Delete',
  'Insert',
  'Home',
  'End',
  'PageUp',
  'PageDown',
  'Up',
  'Down',
  'Left',
  'Right',
  'Ctrl',
  'RCtrl',
  'Shift',
  'RShift',
  'Alt',
  'LAlt',
  'RAlt',
  'Win',
  'RWin',
  'Fn',
  'VolumeUp',
  'VolumeDown',
  'VolumeMute',
  'MediaPlayPause',
  'MediaPrevious',
  'MediaNext',
  'MediaStop',
  ...[...'ABCDEFGHIJKLMNOPQRSTUVWXYZ'],
  ...[...'0123456789'],
  ...['[', ']', '\\', ';', "'", ',', '.', '/', '-', '=', '`'],
  ...Array.from({ length: 24 }, (_, index) => `F${index + 1}`),
])

const modifierOrder = new Map(
  ['Mod', 'Ctrl', 'RCtrl', 'Shift', 'RShift', 'Alt', 'LAlt', 'RAlt', 'Win', 'RWin', 'Fn'].map((key, index) => [
    key,
    index,
  ]),
)

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function splitKeys(value: string | readonly string[]): string[] {
  const values = typeof value === 'string' ? [value] : [...value]
  return values.flatMap(item =>
    item
      .split('+')
      .map(token => token.trim())
      .filter(Boolean),
  )
}

/** Convert a user-facing token into the platform-neutral CLI spelling. */
export function canonicalizeCliKeyToken(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const raw = value.trim()
  if (!raw) return null
  const alias = tokenAliases[raw.toLowerCase()]
  if (alias) return alias
  if (/^mod$/i.test(raw)) return 'Mod'
  if (/^f(?:[1-9]|1\d|2[0-4])$/i.test(raw)) return raw.toUpperCase()
  if (/^[a-z]$/i.test(raw)) return raw.toUpperCase()
  if (/^\d$/.test(raw)) return raw
  const exact = [...canonicalTokens].find(token => token.toLowerCase() === raw.toLowerCase())
  return exact ?? null
}

/**
 * Normalize a shortcut into a stable token order. `Mod` is intentionally kept
 * platform-neutral here; the app bridge converts it to Ctrl on Windows and
 * Cmd/Win on macOS when applying the behavior.
 */
export function canonicalizeCliShortcutKeys(value: string | readonly string[]): string[] | null {
  if (typeof value !== 'string' && !Array.isArray(value)) return null
  const keys = splitKeys(value)
  if (!keys.length) return null
  const normalized = keys.map(canonicalizeCliKeyToken)
  if (normalized.some(token => token === null)) return null
  const result = normalized as string[]
  if (new Set(result).size !== result.length) return null
  if (result.filter(token => !modifierOrder.has(token)).length > 1) return null
  return [...result].sort((left, right) => {
    const leftOrder = modifierOrder.get(left) ?? 100
    const rightOrder = modifierOrder.get(right) ?? 100
    return leftOrder - rightOrder || left.localeCompare(right)
  })
}

/** Translate the public `Mod` token into the app's persisted key names. */
export function cliKeysToBehaviorKeys(keys: readonly string[], platform: CliPlatform): string[] | null {
  const normalized = canonicalizeCliShortcutKeys(keys)
  if (!normalized) return null
  return normalized.map(key => {
    if (key === 'Mod') return platform === 'macos' ? 'Win' : 'Ctrl'
    return key
  })
}

/** Translate persisted key names back to the platform-neutral CLI spelling. */
export function behaviorKeysToCliKeys(keys: readonly string[], platform: CliPlatform): string[] | null {
  const platformNeutral = keys.map(key => {
    if (platform === 'macos' && key === 'Win') return 'Mod'
    if (platform === 'windows' && key === 'Ctrl') return 'Mod'
    return key
  })
  const normalized = canonicalizeCliShortcutKeys(platformNeutral)
  if (!normalized) return null
  return normalized
}

function enabled(value: Record<string, unknown>) {
  return value.enabled !== false
}

/** Normalize one external behavior at the CLI boundary. IDs are deliberately omitted. */
export function normalizeCliBehavior(value: unknown, platform: CliPlatform): CliBehavior | null {
  if (!isRecord(value) || typeof value.type !== 'string' || !cliBehaviorTypes.includes(value.type as CliBehaviorType))
    return null
  const isEnabled = enabled(value)
  switch (value.type as CliBehaviorType) {
    case 'key': {
      const key = canonicalizeCliKeyToken(value.key)
      if (!key) return null
      return { type: 'key', key: key === 'Mod' ? (platform === 'macos' ? 'Win' : 'Ctrl') : key, enabled: isEnabled }
    }
    case 'shortcut': {
      const keys = canonicalizeCliShortcutKeys(value.keys as string[])
      const platformKeys = keys ? cliKeysToBehaviorKeys(keys, platform) : null
      return platformKeys && new Set(platformKeys).size === platformKeys.length
        ? { type: 'shortcut', keys: platformKeys, enabled: isEnabled }
        : null
    }
    case 'wheel':
      return ['up', 'down', 'left', 'right'].includes(String(value.direction))
        ? { type: 'wheel', direction: value.direction as 'up' | 'down' | 'left' | 'right', enabled: isEnabled }
        : null
    case 'mouse':
      return ['left', 'right', 'back', 'forward'].includes(String(value.button))
        ? { type: 'mouse', button: value.button as 'left' | 'right' | 'back' | 'forward', enabled: isEnabled }
        : null
    case 'cursorMove': {
      const distance = typeof value.distance === 'number' ? Math.round(value.distance) : Number(value.distance)
      return ['up', 'down', 'left', 'right'].includes(String(value.direction)) &&
        Number.isInteger(distance) &&
        distance >= 1 &&
        distance <= 500
        ? {
            type: 'cursorMove',
            direction: value.direction as 'up' | 'down' | 'left' | 'right',
            distance,
            enabled: isEnabled,
          }
        : null
    }
    case 'paste':
      return typeof value.text === 'string' ? { type: 'paste', text: value.text, enabled: isEnabled } : null
    case 'typeText':
      return typeof value.text === 'string' ? { type: 'typeText', text: value.text, enabled: isEnabled } : null
    case 'delay': {
      const ms = typeof value.ms === 'number' ? Math.round(value.ms) : Number(value.ms)
      return Number.isInteger(ms) && ms >= 0 && ms <= 300_000 ? { type: 'delay', ms, enabled: isEnabled } : null
    }
    case 'openApp': {
      const path = normalizeApplicationPath(value.path)
      return path ? { type: 'openApp', path, enabled: isEnabled } : null
    }
    case 'openPath': {
      const path = normalizeFilePath(value.path)
      return path ? { type: 'openPath', path, enabled: isEnabled } : null
    }
    case 'openWebsite': {
      const url = normalizeWebsiteUrl(value.url)
      return url ? { type: 'openWebsite', url, enabled: isEnabled } : null
    }
    case 'switchProfile':
      return (value.direction === 'previous' || value.direction === 'next') &&
        (value.wrap === undefined || typeof value.wrap === 'boolean')
        ? { type: 'switchProfile', direction: value.direction, wrap: value.wrap !== false, enabled: isEnabled }
        : null
    case 'disabled':
      return { type: 'disabled', enabled: isEnabled }
  }
}

export function normalizeCliSequence(value: unknown, platform: CliPlatform): CliBehaviorSequence | null {
  if (!Array.isArray(value)) return null
  const result = value.map(entry => normalizeCliBehavior(entry, platform))
  return result.some(entry => entry === null) ? null : (result as CliBehaviorSequence)
}

/** Convert a validated public action into the app's persisted behavior shape. */
export function cliBehaviorToBehavior(value: unknown, platform: CliPlatform, id?: string): Behavior | null {
  const normalized = normalizeCliBehavior(value, platform)
  return normalized ? normalizeBehavior({ ...normalized, ...(id ? { id } : {}) }) : null
}

/** Convert persisted actions into the stable public shape returned to Agents. */
export function behaviorToCliBehavior(value: Behavior, platform: CliPlatform): CliBehavior {
  const base = { enabled: value.enabled }
  switch (value.type) {
    case 'key': {
      const key = behaviorKeysToCliKeys([value.key], platform)?.[0] ?? value.key
      return { ...base, type: 'key', key }
    }
    case 'shortcut':
      return { ...base, type: 'shortcut', keys: behaviorKeysToCliKeys(value.keys, platform) ?? value.keys }
    case 'wheel':
      return { ...base, type: 'wheel', direction: value.direction }
    case 'mouse':
      return { ...base, type: 'mouse', button: value.button }
    case 'cursorMove':
      return { ...base, type: 'cursorMove', direction: value.direction, distance: value.distance }
    case 'paste':
      return { ...base, type: 'paste', text: value.text }
    case 'typeText':
      return { ...base, type: 'typeText', text: value.text }
    case 'delay':
      return { ...base, type: 'delay', ms: value.ms }
    case 'openApp':
      return { ...base, type: 'openApp', path: value.path }
    case 'openPath':
      return { ...base, type: 'openPath', path: value.path }
    case 'openWebsite':
      return { ...base, type: 'openWebsite', url: value.url }
    case 'switchProfile':
      return { ...base, type: 'switchProfile', direction: value.direction, wrap: value.wrap }
    case 'disabled':
      return { ...base, type: 'disabled' }
  }
}
