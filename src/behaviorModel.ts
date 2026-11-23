/**
 * The editable behavior model used by the key-mapping workbench.
 *
 * A trigger owns an ordered list instead of a single action, so one press can
 * run a sequence such as shortcut -> delay -> paste.
 */

import { cmiotA15RemoteButtonIds, devices, inputIds } from './devices/index.ts'
import type { DeviceId, InputId, RemoteButtonId } from './devices/index.ts'
export type { InputId } from './devices/index.ts'
export type ButtonId = RemoteButtonId

export const triggerTypes = ['click', 'doubleClick', 'longPress'] as const
export type TriggerType = (typeof triggerTypes)[number]

export const behaviorTypes = [
  'key',
  'shortcut',
  'wheel',
  'mouse',
  'cursorMove',
  'paste',
  'typeText',
  'copyText',
  'delay',
  'openApp',
  'openPath',
  'openWebsite',
  'runCommand',
  'httpRequest',
  'switchProfile',
  'quickOverlay',
  'clipboardOverlay',
  'disabled',
] as const
export type BehaviorType = (typeof behaviorTypes)[number]
export const cursorDirections = ['up', 'down', 'left', 'right'] as const
export type CursorDirection = (typeof cursorDirections)[number]
export const defaultCursorDistance = 50
export const maxCursorDistance = 500
export const httpRequestMethods = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'] as const
export type HttpRequestMethod = (typeof httpRequestMethods)[number]
export const maxCommandLength = 4096
export const maxHttpHeaders = 16
export const maxHttpHeaderValueLength = 2048
export const maxHttpBodyLength = 16_384

type BehaviorBase = {
  id: string
  enabled: boolean
  libraryItemId?: string
}

export function libraryItemId(value: unknown): string | undefined {
  return typeof value === 'string' && /^[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}$/i.test(value)
    ? value
    : undefined
}

export type KeyBehavior = BehaviorBase & {
  type: 'key'
  key: string
}

export type ShortcutBehavior = BehaviorBase & {
  type: 'shortcut'
  keys: string[]
}

export type PasteBehavior = BehaviorBase & {
  type: 'paste'
  text: string
  title?: string
}

export type TypeTextBehavior = BehaviorBase & { type: 'typeText'; text: string; title?: string }
export type CopyTextBehavior = BehaviorBase & { type: 'copyText'; text: string; title?: string }
export type OpenPathBehavior = BehaviorBase & { type: 'openPath'; path: string }

export type DelayBehavior = BehaviorBase & {
  type: 'delay'
  ms: number
}

export type DisabledBehavior = BehaviorBase & {
  type: 'disabled'
}

export type WheelBehavior = BehaviorBase & { type: 'wheel'; direction: 'up' | 'down' | 'left' | 'right' }
export type MouseBehavior = BehaviorBase & { type: 'mouse'; button: 'left' | 'right' | 'back' | 'forward' }
export type CursorMoveBehavior = BehaviorBase & { type: 'cursorMove'; direction: CursorDirection; distance: number }
export type OpenAppBehavior = BehaviorBase & { type: 'openApp'; path: string }
export type ProfileDirection = 'previous' | 'next'
export type SwitchProfileBehavior = BehaviorBase & { type: 'switchProfile'; direction: ProfileDirection; wrap: boolean }
export type QuickOverlayBehavior = BehaviorBase & { type: 'quickOverlay'; profileId: string }
export const clipboardOverlayActions = ['paste', 'copyText'] as const
export type ClipboardOverlayAction = (typeof clipboardOverlayActions)[number]
export type ClipboardOverlayBehavior = BehaviorBase & { type: 'clipboardOverlay'; action: ClipboardOverlayAction }
export type OpenWebsiteBehavior = BehaviorBase & { type: 'openWebsite'; url: string }
export type RunCommandBehavior = BehaviorBase & {
  type: 'runCommand'
  command: string
  workingDirectory?: string
  title?: string
}
export type HttpRequestBehavior = BehaviorBase & {
  type: 'httpRequest'
  method: HttpRequestMethod
  url: string
  headers?: Record<string, string>
  body?: string
  title?: string
}

export type Behavior =
  | KeyBehavior
  | ShortcutBehavior
  | WheelBehavior
  | MouseBehavior
  | CursorMoveBehavior
  | PasteBehavior
  | TypeTextBehavior
  | CopyTextBehavior
  | OpenPathBehavior
  | DelayBehavior
  | OpenAppBehavior
  | OpenWebsiteBehavior
  | RunCommandBehavior
  | HttpRequestBehavior
  | DisabledBehavior
  | SwitchProfileBehavior
  | QuickOverlayBehavior
  | ClipboardOverlayBehavior

export type TriggerBehaviors = Record<TriggerType, Behavior[]>
export type BehaviorMap = Record<InputId, TriggerBehaviors>

export const mappingTransferFormat = 'axonkey-mapping'
export const mappingTransferVersion = 2

export type MappingTransfer = {
  format: typeof mappingTransferFormat
  version: 2 | 3
  minAppVersion?: string
  exportedAt: string
  deviceId: DeviceId
  enabled: boolean
  profileName?: string
  behaviors: Partial<BehaviorMap>
}

export type ImportedMapping = {
  behaviors: BehaviorMap
  enabled?: boolean
  profileName?: string
}

export type CreateBehaviorOptions = { libraryItemId?: string } & (
  | { type: 'wheel'; direction: 'up' | 'down' | 'left' | 'right'; enabled?: boolean; id?: string }
  | { type: 'mouse'; button: 'left' | 'right' | 'back' | 'forward'; enabled?: boolean; id?: string }
  | { type: 'cursorMove'; direction: CursorDirection; distance?: number; enabled?: boolean; id?: string }
  | { type: 'key'; key?: string; enabled?: boolean; id?: string }
  | { type: 'shortcut'; keys?: readonly string[]; enabled?: boolean; id?: string }
  | { type: 'typeText'; text?: string; title?: string; enabled?: boolean; id?: string }
  | { type: 'copyText'; text?: string; title?: string; enabled?: boolean; id?: string }
  | { type: 'openPath'; path?: string; enabled?: boolean; id?: string }
  | { type: 'paste'; text?: string; title?: string; enabled?: boolean; id?: string }
  | { type: 'delay'; ms?: number; enabled?: boolean; id?: string }
  | { type: 'openApp'; path?: string; enabled?: boolean; id?: string }
  | { type: 'openWebsite'; url?: string; enabled?: boolean; id?: string }
  | { type: 'runCommand'; command?: string; workingDirectory?: string; title?: string; enabled?: boolean; id?: string }
  | {
      type: 'httpRequest'
      method?: HttpRequestMethod
      url?: string
      headers?: Record<string, string>
      body?: string
      title?: string
      enabled?: boolean
      id?: string
    }
  | { type: 'switchProfile'; direction?: ProfileDirection; wrap?: boolean; enabled?: boolean; id?: string }
  | { type: 'quickOverlay'; profileId?: string; enabled?: boolean; id?: string }
  | { type: 'clipboardOverlay'; action?: ClipboardOverlayAction; enabled?: boolean; id?: string }
  | { type: 'disabled'; enabled?: boolean; id?: string }
)

const maxDelayMs = 300_000

export const newBehaviorMinAppVersion = '1.8.11'
export const quickOverlayMinAppVersion = '1.9.11'
export const commandBehaviorMinAppVersion = '1.9.19'
export const clipboardOverlayMinAppVersion = '1.9.21'
export function minAppVersionForBehaviors(behaviors: readonly Behavior[]): string | undefined {
  if (behaviors.some(behavior => behavior.type === 'clipboardOverlay')) return clipboardOverlayMinAppVersion
  if (
    behaviors.some(
      behavior => behavior.type === 'copyText' || behavior.type === 'runCommand' || behavior.type === 'httpRequest',
    )
  )
    return commandBehaviorMinAppVersion
  if (
    behaviors.some(
      behavior =>
        behavior.type === 'quickOverlay' ||
        ((behavior.type === 'paste' || behavior.type === 'typeText') && Boolean(behavior.title)),
    )
  )
    return quickOverlayMinAppVersion
  if (behaviors.some(behavior => behavior.type === 'typeText' || behavior.type === 'openPath'))
    return newBehaviorMinAppVersion
  return undefined
}
export function requiresNewBehaviorVersion(behaviors: readonly Behavior[]): boolean {
  return Boolean(minAppVersionForBehaviors(behaviors))
}

export function isCommunityShareableBehavior(behavior: Pick<Behavior, 'type'>): boolean {
  return (
    behavior.type !== 'quickOverlay' &&
    behavior.type !== 'clipboardOverlay' &&
    behavior.type !== 'runCommand' &&
    behavior.type !== 'httpRequest'
  )
}

export function normalizeBehaviorTitle(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  const clean = value
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .trim()
    .slice(0, 40)
  return clean || undefined
}

export function normalizeShellCommand(value: unknown): string | null {
  if (typeof value !== 'string' || value.includes('\0')) return null
  const command = value.trim()
  if (!command || command.length > maxCommandLength) return null
  return command
}

export function normalizeHttpMethod(value: unknown): HttpRequestMethod | null {
  if (typeof value !== 'string') return null
  const method = value.trim().toUpperCase()
  return (httpRequestMethods as readonly string[]).includes(method) ? (method as HttpRequestMethod) : null
}

const headerNamePattern = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/

export function normalizeHttpHeaders(value: unknown): Record<string, string> | undefined | null {
  if (value === undefined) return undefined
  if (!isRecord(value)) return null
  const entries = Object.entries(value)
  if (entries.length > maxHttpHeaders) return null
  const result: Record<string, string> = {}
  const seen = new Set<string>()
  for (const [rawKey, rawVal] of entries) {
    const key = rawKey.trim()
    if (!key || key.length > 128 || !headerNamePattern.test(key)) return null
    const lower = key.toLowerCase()
    if (seen.has(lower)) return null
    if (typeof rawVal !== 'string' || rawVal.length > maxHttpHeaderValueLength) return null
    if (/[\u0000-\u0008\u000a-\u001f\u007f]/.test(rawVal)) return null
    seen.add(lower)
    result[key] = rawVal.trim()
  }
  return Object.keys(result).length > 0 ? result : undefined
}

export function normalizeHttpBody(value: unknown): string | undefined | null {
  if (value === undefined || value === '') return undefined
  if (typeof value !== 'string' || value.includes('\0') || value.length > maxHttpBodyLength) return null
  return value
}

export function normalizeProfileReferenceId(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const id = value.trim()
  if (!id || id.length > 128 || /[\u0000-\u001f\u007f]/.test(id)) return null
  return id
}

export function normalizeClipboardOverlayAction(value: unknown): ClipboardOverlayAction | null {
  if (value === undefined) return 'paste'
  return value === 'paste' || value === 'copyText' ? value : null
}

export function normalizeFilePath(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const path = value.trim().replace(/^"(.*)"$/, '$1')
  if (/[\u0000-\u001f\u007f]/.test(path)) return null
  return /^(?:[a-z]:[\\/]|\\\\[^\\]+\\|\/)/i.test(path) ? path : null
}

export function normalizeApplicationPath(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const path = value.trim().replace(/^"(.*)"$/, '$1')
  if (/[\u0000-\u001f\u007f]/.test(path)) return null
  if (!/^(?:[a-z]:[\\/]|\\\\[^\\]+\\|\/)/i.test(path)) return null
  return /\.(?:exe|com|lnk|app)$/i.test(path) ? path : null
}

export function normalizeWebsiteUrl(value: unknown): string | null {
  if (typeof value !== 'string' || !value.trim() || /[\u0000-\u0020\u007f]/.test(value.trim())) return null
  const input = value.trim()
  try {
    const hasScheme = /^[a-z][a-z\d+.-]*:/i.test(input) && !/^[^/?#:\s]+:\d+(?:[/?#]|$)/.test(input)
    const url = new URL(hasScheme ? input : `https://${input}`)
    return (url.protocol === 'https:' || url.protocol === 'http:') && url.hostname && !url.username && !url.password
      ? url.href
      : null
  } catch {
    return null
  }
}

function finiteCursorDistance(value: unknown, fallback = defaultCursorDistance) {
  let number: number
  try {
    number = typeof value === 'number' ? value : Number(value)
  } catch {
    return fallback
  }
  if (!Number.isFinite(number)) return fallback
  const rounded = Math.round(number)
  if (rounded < 1) return fallback
  return Math.min(maxCursorDistance, rounded)
}

function createBehaviorId() {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID()
  }
  return `behavior-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
}

function finiteDelay(value: unknown, fallback = 300) {
  let number: number
  try {
    number = typeof value === 'number' ? value : Number(value)
  } catch {
    return fallback
  }
  if (!Number.isFinite(number)) return fallback
  return Math.min(maxDelayMs, Math.max(0, Math.round(number)))
}

function cleanKey(value: unknown) {
  return typeof value === 'string' ? value.trim() : ''
}

function cleanKeys(value: unknown) {
  if (!Array.isArray(value)) return []
  return value.map(cleanKey).filter(Boolean)
}

/** Create a valid behavior with sensible defaults for editor forms. */
export function createBehavior(options: CreateBehaviorOptions): Behavior {
  const id = options.id?.trim() || createBehaviorId()
  const enabled = options.enabled !== false
  const source = libraryItemId(options.libraryItemId)
  const base = { id, enabled, ...(source ? { libraryItemId: source } : {}) }

  switch (options.type) {
    case 'wheel':
      return { ...base, type: 'wheel', direction: options.direction }
    case 'mouse':
      return { ...base, type: 'mouse', button: options.button }
    case 'cursorMove':
      return {
        ...base,
        type: 'cursorMove',
        direction: options.direction,
        distance: finiteCursorDistance(options.distance),
      }
    case 'key':
      return { ...base, type: 'key', key: cleanKey(options.key) || 'Enter' }
    case 'shortcut': {
      const keys = cleanKeys(options.keys)
      return { ...base, type: 'shortcut', keys: keys.length > 0 ? keys : ['Ctrl', 'C'] }
    }
    case 'typeText':
    case 'paste':
    case 'copyText': {
      const title = normalizeBehaviorTitle(options.title)
      return {
        ...base,
        type: options.type,
        text: typeof options.text === 'string' ? options.text : '',
        ...(title ? { title } : {}),
      }
    }
    case 'delay':
      return { ...base, type: 'delay', ms: finiteDelay(options.ms) }
    case 'openPath':
      return { ...base, type: 'openPath', path: normalizeFilePath(options.path) ?? '' }
    case 'openApp':
      return { ...base, type: 'openApp', path: normalizeApplicationPath(options.path) ?? '' }
    case 'openWebsite':
      return { ...base, type: 'openWebsite', url: normalizeWebsiteUrl(options.url) ?? '' }
    case 'runCommand': {
      const workingDirectory = normalizeFilePath(options.workingDirectory)
      const title = normalizeBehaviorTitle(options.title)
      return {
        ...base,
        type: 'runCommand',
        command: typeof options.command === 'string' && !options.command.includes('\0') ? options.command.trim() : '',
        ...(workingDirectory ? { workingDirectory } : {}),
        ...(title ? { title } : {}),
      }
    }
    case 'httpRequest': {
      const headers = normalizeHttpHeaders(options.headers)
      const body = normalizeHttpBody(options.body)
      const title = normalizeBehaviorTitle(options.title)
      return {
        ...base,
        type: 'httpRequest',
        method: normalizeHttpMethod(options.method) ?? 'POST',
        url: normalizeWebsiteUrl(options.url) ?? '',
        ...(headers ? { headers } : {}),
        ...(body ? { body } : {}),
        ...(title ? { title } : {}),
      }
    }
    case 'switchProfile':
      return {
        ...base,
        type: 'switchProfile',
        direction: options.direction ?? 'next',
        wrap: options.wrap !== false,
      }
    case 'quickOverlay':
      return {
        ...base,
        type: 'quickOverlay',
        profileId: normalizeProfileReferenceId(options.profileId) ?? '',
      }
    case 'clipboardOverlay':
      return {
        ...base,
        type: 'clipboardOverlay',
        action: normalizeClipboardOverlayAction(options.action) ?? 'paste',
      }
    case 'disabled':
      return { ...base, type: 'disabled' }
  }
}

function cloneBehavior(behavior: Behavior): Behavior {
  if (behavior.type === 'shortcut') return { ...behavior, keys: [...behavior.keys] }
  if (behavior.type === 'httpRequest' && behavior.headers) {
    return { ...behavior, headers: { ...behavior.headers } }
  }
  return { ...behavior }
}

function emptyTriggers(): TriggerBehaviors {
  return { click: [], doubleClick: [], longPress: [] }
}

/** Returns a fresh map so callers can mutate their state without sharing defaults. */
export function createEmptyBehaviorMap(): BehaviorMap {
  return Object.fromEntries(inputIds.map(id => [id, emptyTriggers()])) as BehaviorMap
}

/** The initial configuration mirrors the two mappings used by the current UI. */
export function createDefaultBehaviorMap(): BehaviorMap {
  const map = createEmptyBehaviorMap()
  map.power.click = [createBehavior({ type: 'key', key: 'Esc', id: 'power-click-esc' })]
  map.voice.click = [createBehavior({ type: 'key', key: 'RAlt', id: 'voice-click-ralt' })]
  map[cmiotA15RemoteButtonIds[0]].click = [createBehavior({ type: 'key', key: 'Esc', id: 'cmiot-a15-power-click-esc' })]
  map[cmiotA15RemoteButtonIds[1]].click = [
    createBehavior({ type: 'key', key: 'RAlt', id: 'cmiot-a15-voice-click-ralt' }),
  ]
  return map
}

/** Clone every sequence so a profile can be edited independently of its source. */
export function cloneBehaviorMap(map: BehaviorMap): BehaviorMap {
  return Object.fromEntries(
    inputIds.map(id => [
      id,
      Object.fromEntries(triggerTypes.map(trigger => [trigger, map[id][trigger].map(cloneBehavior)])),
    ]),
  ) as BehaviorMap
}

function isButtonId(value: string): value is InputId {
  return (inputIds as readonly string[]).includes(value)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Normalize persisted data and discard malformed behavior entries safely. */
export function normalizeBehavior(value: unknown, fallbackId?: string): Behavior | null {
  if (!isRecord(value)) return null
  const type = value.type
  if (typeof type !== 'string' || !(behaviorTypes as readonly string[]).includes(type)) return null
  const id = typeof value.id === 'string' && value.id.trim() ? value.id.trim() : fallbackId || createBehaviorId()
  const enabled = value.enabled !== false
  const source = libraryItemId(value.libraryItemId)
  if (value.libraryItemId !== undefined && !source) return null
  const base = { id, enabled, ...(source ? { libraryItemId: source } : {}) }

  switch (type) {
    case 'wheel':
      return ['up', 'down', 'left', 'right'].includes(String(value.direction))
        ? { ...base, type, direction: value.direction as WheelBehavior['direction'] }
        : null
    case 'mouse':
      return ['left', 'right', 'back', 'forward'].includes(String(value.button))
        ? { ...base, type, button: value.button as MouseBehavior['button'] }
        : null
    case 'cursorMove':
      return (cursorDirections as readonly string[]).includes(String(value.direction))
        ? {
            ...base,
            type,
            direction: value.direction as CursorDirection,
            distance: finiteCursorDistance(value.distance),
          }
        : null
    case 'key': {
      const key = cleanKey(value.key)
      return key ? { ...base, type, key } : null
    }
    case 'shortcut': {
      const keys = cleanKeys(value.keys)
      return keys.length > 0 ? { ...base, type, keys } : null
    }
    case 'typeText':
    case 'paste':
    case 'copyText': {
      if (typeof value.text !== 'string') return null
      if (value.title !== undefined && typeof value.title !== 'string') return null
      const title = normalizeBehaviorTitle(value.title)
      return { ...base, type, text: value.text, ...(title ? { title } : {}) }
    }
    case 'delay':
      return { ...base, type, ms: finiteDelay(value.ms) }
    case 'openPath': {
      const path = normalizeFilePath(value.path)
      return path ? { ...base, type, path } : null
    }
    case 'openApp': {
      const path = normalizeApplicationPath(value.path)
      return path ? { ...base, type, path } : null
    }
    case 'openWebsite': {
      const url = normalizeWebsiteUrl(value.url)
      return url ? { ...base, type, url } : null
    }
    case 'runCommand': {
      const command = normalizeShellCommand(value.command)
      if (!command) return null
      if (value.workingDirectory !== undefined && typeof value.workingDirectory !== 'string') return null
      const workingDirectory =
        typeof value.workingDirectory === 'string' && value.workingDirectory.trim()
          ? normalizeFilePath(value.workingDirectory)
          : undefined
      if (typeof value.workingDirectory === 'string' && value.workingDirectory.trim() && !workingDirectory) return null
      if (value.title !== undefined && typeof value.title !== 'string') return null
      const title = normalizeBehaviorTitle(value.title)
      return {
        ...base,
        type,
        command,
        ...(workingDirectory ? { workingDirectory } : {}),
        ...(title ? { title } : {}),
      }
    }
    case 'httpRequest': {
      const method = normalizeHttpMethod(value.method)
      const url = normalizeWebsiteUrl(value.url)
      const headers = normalizeHttpHeaders(value.headers)
      const body = normalizeHttpBody(value.body)
      if (!method || !url || headers === null || body === null) return null
      if (value.title !== undefined && typeof value.title !== 'string') return null
      const title = normalizeBehaviorTitle(value.title)
      return {
        ...base,
        type,
        method,
        url,
        ...(headers ? { headers } : {}),
        ...(body ? { body } : {}),
        ...(title ? { title } : {}),
      }
    }
    case 'switchProfile':
      return (value.direction === 'previous' || value.direction === 'next') &&
        (value.wrap === undefined || typeof value.wrap === 'boolean')
        ? { ...base, type, direction: value.direction, wrap: value.wrap !== false }
        : null
    case 'quickOverlay': {
      const profileId = normalizeProfileReferenceId(value.profileId)
      return profileId ? { ...base, type, profileId } : null
    }
    case 'clipboardOverlay': {
      const action = normalizeClipboardOverlayAction(value.action)
      return action ? { ...base, type, action } : null
    }
    case 'disabled':
      return { ...base, type }
  }
  return null
}

function behaviorContainer(value: unknown) {
  if (!isRecord(value)) return null
  if (isRecord(value.behaviors)) return value.behaviors
  return value
}

function hasBehaviorMapShape(value: unknown) {
  if (!isRecord(value)) return false
  const knownButtons = inputIds.filter(buttonId => Object.prototype.hasOwnProperty.call(value, buttonId))
  if (knownButtons.length === 0) return false
  return knownButtons.every(buttonId => {
    const rawButton = value[buttonId]
    if (!isRecord(rawButton)) return false
    return triggerTypes.every(trigger => {
      const rawList = rawButton[trigger]
      return (
        rawList === undefined || (Array.isArray(rawList) && rawList.every(entry => normalizeBehavior(entry) !== null))
      )
    })
  })
}

export function parseStoredBehaviors(value: unknown): BehaviorMap {
  let parsed: unknown = value
  if (typeof value === 'string') {
    try {
      parsed = JSON.parse(value) as unknown
    } catch {
      return createDefaultBehaviorMap()
    }
  }

  const fallback = createDefaultBehaviorMap()
  if (!isRecord(parsed)) return fallback

  const source = behaviorContainer(parsed)
  if (!source) return fallback
  const result = fallback
  for (const buttonId of inputIds) {
    const rawButton = source[buttonId]
    if (!isRecord(rawButton)) continue
    for (const trigger of triggerTypes) {
      const rawList = rawButton[trigger]
      if (!Array.isArray(rawList)) continue
      const normalized = rawList.map((entry, index) => normalizeBehavior(entry, `${buttonId}-${trigger}-${index + 1}`))
      if (normalized.some(entry => entry === null)) {
        console.error(`不支持的行为：${buttonId}/${trigger} 已禁用整个序列，请升级 Axonkey。`)
        result[buttonId][trigger] = [createBehavior({ type: 'disabled' })]
      } else result[buttonId][trigger] = normalized as Behavior[]
    }
  }
  return result
}

export type SanitizedInputBehaviors = {
  sequences: TriggerBehaviors
  warning: string | null
  hasDroppedItems: boolean
}

/** Sanitize a single input's raw trigger object while collecting per-button warnings. */
export function sanitizeInputBehaviors(
  inputId: string,
  raw: unknown,
  validProfileIds?: ReadonlySet<string>,
): SanitizedInputBehaviors {
  const sequences = emptyTriggers()
  if (raw === undefined || raw === null) {
    return { sequences, warning: null, hasDroppedItems: false }
  }
  if (!isRecord(raw)) {
    return { sequences, warning: '映射格式无效', hasDroppedItems: true }
  }

  const reasons: string[] = []
  const pushReason = (reason: string) => {
    if (!reasons.includes(reason)) reasons.push(reason)
  }
  let hasDroppedItems = false

  for (const trigger of triggerTypes) {
    const rawList = raw[trigger]
    if (rawList === undefined || rawList === null) continue
    if (!Array.isArray(rawList)) {
      hasDroppedItems = true
      pushReason('触发序列格式无效')
      continue
    }
    rawList.forEach((entry, index) => {
      const normalized = normalizeBehavior(entry, `${inputId}-${trigger}-${index + 1}`)
      if (!normalized) {
        hasDroppedItems = true
        const kind = isRecord(entry) && typeof entry.type === 'string' ? entry.type.trim() : ''
        pushReason(kind ? `包含无法识别或无效的动作（${kind}）` : '包含格式无效的动作')
        return
      }
      sequences[trigger].push(normalized)
      if (normalized.enabled && normalized.type === 'quickOverlay') {
        if (!normalized.profileId) {
          pushReason('未选择快捷交互配置')
        } else if (validProfileIds && !validProfileIds.has(normalized.profileId)) {
          pushReason('关联的快捷交互配置不存在')
        }
      }
    })
  }

  return {
    sequences,
    warning: reasons.length > 0 ? reasons.join('；') : null,
    hasDroppedItems,
  }
}

export type SanitizedProfileBehaviors = {
  behaviors: Record<string, TriggerBehaviors>
  warnings: Record<string, string>
  droppedInputIds: Set<string>
}

/** Sanitize an entire profile's raw behavior map at the UI boundary. */
export function sanitizeProfileBehaviors(
  rawBehaviors: unknown,
  validProfileIds?: ReadonlySet<string>,
): SanitizedProfileBehaviors {
  const behaviors: Record<string, TriggerBehaviors> = {}
  const warnings: Record<string, string> = {}
  const droppedInputIds = new Set<string>()
  if (!isRecord(rawBehaviors)) {
    return { behaviors, warnings, droppedInputIds }
  }

  for (const [inputId, raw] of Object.entries(rawBehaviors)) {
    const result = sanitizeInputBehaviors(inputId, raw, validProfileIds)
    if (
      result.sequences.click.length > 0 ||
      result.sequences.doubleClick.length > 0 ||
      result.sequences.longPress.length > 0
    ) {
      behaviors[inputId] = result.sequences
    }
    if (result.warning) warnings[inputId] = result.warning
    if (result.hasDroppedItems) droppedInputIds.add(inputId)
  }

  return { behaviors, warnings, droppedInputIds }
}

/** Collect per-input warnings for an already normalized device BehaviorMap. */
export function inspectBehaviorMapWarnings(
  behaviors: Partial<Record<string, TriggerBehaviors>>,
  targetInputIds: readonly string[],
  validProfileIds?: ReadonlySet<string>,
): Record<string, string> {
  const warnings: Record<string, string> = {}
  for (const inputId of targetInputIds) {
    const result = sanitizeInputBehaviors(inputId, behaviors[inputId], validProfileIds)
    if (result.warning) warnings[inputId] = result.warning
  }
  return warnings
}

/** Build the stable, versioned JSON shape used for mapping file transfers. */
export function createMappingExport(
  behaviors: BehaviorMap,
  enabled: boolean,
  exportedAt = new Date().toISOString(),
  profileName?: string,
  deviceId: DeviceId = 'rc003',
): MappingTransfer {
  const device = devices.find(device => device.id === deviceId)!
  const cloned = cloneBehaviorMap(behaviors)
  const transfer: MappingTransfer = {
    format: mappingTransferFormat,
    version: mappingTransferVersion,
    exportedAt,
    deviceId,
    enabled,
    behaviors: Object.fromEntries(device.inputIds.map(id => [id, cloned[id]])),
  }
  const minAppVersion = minAppVersionForBehaviors(
    Object.values(transfer.behaviors).flatMap(triggers => triggerTypes.flatMap(trigger => triggers[trigger])),
  )
  if (minAppVersion) {
    transfer.version = 3
    transfer.minAppVersion = minAppVersion
  }
  const name =
    typeof profileName === 'string'
      ? profileName
          .trim()
          .replace(/[\u0000-\u001f\u007f]/g, '')
          .slice(0, 40)
      : ''
  if (name) transfer.profileName = name
  return transfer
}

const sequenceTextHeader = 'axonkey/1'

function sequenceArgument(value: string) {
  return value && !/[\s"\\]/.test(value) ? value : JSON.stringify(value)
}

/** One command per line; quoted arguments preserve text, whitespace and paths. */
export function serializeSequence(behaviors: Behavior[]): string {
  return [
    requiresNewBehaviorVersion(behaviors) ? 'axonkey/2' : sequenceTextHeader,
    ...behaviors.map(behavior => {
      let line: string
      switch (behavior.type) {
        case 'key':
          line = `key ${sequenceArgument(behavior.key)}`
          break
        case 'shortcut':
          line = `keys ${behavior.keys.map(sequenceArgument).join(' ')}`
          break
        case 'delay':
          line = `wait ${behavior.ms}ms`
          break
        case 'typeText':
          line = behavior.title
            ? `type ${JSON.stringify(behavior.text)} ${JSON.stringify(behavior.title)}`
            : `type ${JSON.stringify(behavior.text)}`
          break
        case 'openPath':
          line = `path ${sequenceArgument(behavior.path)}`
          break
        case 'paste':
          line = behavior.title
            ? `text ${JSON.stringify(behavior.text)} ${JSON.stringify(behavior.title)}`
            : `text ${JSON.stringify(behavior.text)}`
          break
        case 'copyText':
          line = behavior.title
            ? `copy ${JSON.stringify(behavior.text)} ${JSON.stringify(behavior.title)}`
            : `copy ${JSON.stringify(behavior.text)}`
          break
        case 'wheel':
          line = `wheel ${behavior.direction}`
          break
        case 'mouse':
          line = `mouse ${behavior.button}`
          break
        case 'cursorMove':
          line = `move ${behavior.direction} ${behavior.distance}`
          break
        case 'openApp':
          line = `app ${sequenceArgument(behavior.path)}`
          break
        case 'openWebsite':
          line = `url ${sequenceArgument(behavior.url)}`
          break
        case 'runCommand':
          line = `cmd ${JSON.stringify(behavior.command)}${
            behavior.workingDirectory ? ` cwd ${JSON.stringify(behavior.workingDirectory)}` : ''
          }${behavior.title ? ` title ${JSON.stringify(behavior.title)}` : ''}`
          break
        case 'httpRequest': {
          const parts = ['http', behavior.method, sequenceArgument(behavior.url)]
          if (behavior.headers) {
            for (const [key, value] of Object.entries(behavior.headers)) {
              parts.push('header', JSON.stringify(key), JSON.stringify(value))
            }
          }
          if (behavior.body) parts.push('body', JSON.stringify(behavior.body))
          if (behavior.title) parts.push('title', JSON.stringify(behavior.title))
          line = parts.join(' ')
          break
        }
        case 'switchProfile':
          line = `profile ${behavior.direction} ${behavior.wrap ? 'wrap' : 'stop'}`
          break
        case 'quickOverlay':
          line = `quick ${sequenceArgument(behavior.profileId)}`
          break
        case 'clipboardOverlay':
          line = behavior.action === 'copyText' ? 'clipboard copy' : 'clipboard'
          break
        case 'disabled':
          line = 'disabled'
          break
      }
      return behavior.enabled ? line : `off ${line}`
    }),
    'end',
  ].join('\n')
}

function sequenceTokens(line: string): string[] | null {
  const tokens: string[] = []
  let remaining = line.trim()
  while (remaining) {
    const match = /^(?:"(?:\\.|[^"\\])*"|[^\s"]+)(?=\s|$)/.exec(remaining)
    if (!match) return null
    try {
      tokens.push(match[0].startsWith('"') ? (JSON.parse(match[0]) as string) : match[0])
    } catch {
      return null
    }
    remaining = remaining.slice(match[0].length).trimStart()
  }
  return tokens
}

function parseSequenceText(text: string): unknown[] | null {
  // Explicit boundaries survive captions, Markdown fences and quote blocks.
  const lines = text.split(/\r\n?|\n/).map(line =>
    line
      .trim()
      .replace(/^(?:>\s*)+/, '')
      .trim(),
  )
  const headers = lines.flatMap((line, index) => (/^axonkey\/\S+$/.test(line) ? [index] : []))
  if (headers.length !== 1 || ![sequenceTextHeader, 'axonkey/2'].includes(lines[headers[0]])) return null
  const end = lines.indexOf('end', headers[0] + 1)
  if (end === -1) return null
  const behaviors: unknown[] = []
  for (const line of lines.slice(headers[0] + 1, end).filter(Boolean)) {
    const tokens = sequenceTokens(line)
    if (!tokens) return null
    const enabled = tokens[0] !== 'off'
    if (!enabled) tokens.shift()
    const [command, ...args] = tokens
    let behavior: Record<string, unknown>
    if (command === 'key' && args.length === 1) behavior = { type: 'key', key: args[0] }
    else if (command === 'keys' && args.length > 0 && args.every(key => key.trim()))
      behavior = { type: 'shortcut', keys: args }
    else if (command === 'wait' && args.length === 1 && /^\d+(?:\.\d+)?(?:ms)?$/.test(args[0])) {
      const ms = Number(args[0].replace(/ms$/, ''))
      if (ms > maxDelayMs) return null
      behavior = { type: 'delay', ms }
    } else if (command === 'text' && (args.length === 1 || args.length === 2)) {
      behavior = args.length === 2 ? { type: 'paste', text: args[0], title: args[1] } : { type: 'paste', text: args[0] }
    } else if (command === 'copy' && (args.length === 1 || args.length === 2)) {
      behavior =
        args.length === 2 ? { type: 'copyText', text: args[0], title: args[1] } : { type: 'copyText', text: args[0] }
    } else if (command === 'type' && (args.length === 1 || args.length === 2)) {
      behavior =
        args.length === 2 ? { type: 'typeText', text: args[0], title: args[1] } : { type: 'typeText', text: args[0] }
    } else if (command === 'path' && args.length === 1) behavior = { type: 'openPath', path: args[0] }
    else if (command === 'wheel' && args.length === 1) behavior = { type: 'wheel', direction: args[0] }
    else if (command === 'mouse' && args.length === 1) behavior = { type: 'mouse', button: args[0] }
    else if (command === 'move' && args.length === 2 && /^\d+$/.test(args[1])) {
      const distance = Number(args[1])
      if (distance < 1 || distance > maxCursorDistance) return null
      behavior = { type: 'cursorMove', direction: args[0], distance }
    } else if (command === 'app' && args.length === 1) behavior = { type: 'openApp', path: args[0] }
    else if (command === 'url' && args.length === 1) behavior = { type: 'openWebsite', url: args[0] }
    else if (command === 'cmd' && args.length >= 1) {
      behavior = { type: 'runCommand', command: args[0] }
      for (let index = 1; index < args.length;) {
        const flag = args[index]
        if (flag === 'cwd' && index + 1 < args.length && behavior.workingDirectory === undefined) {
          behavior.workingDirectory = args[index + 1]
          index += 2
        } else if (flag === 'title' && index + 1 < args.length && behavior.title === undefined) {
          behavior.title = args[index + 1]
          index += 2
        } else return null
      }
    } else if (command === 'http' && args.length >= 2) {
      const headers: Record<string, string> = {}
      behavior = { type: 'httpRequest', method: args[0], url: args[1] }
      for (let index = 2; index < args.length;) {
        const flag = args[index]
        if (flag === 'header' && index + 2 < args.length) {
          headers[args[index + 1]] = args[index + 2]
          index += 3
        } else if (flag === 'body' && index + 1 < args.length && behavior.body === undefined) {
          behavior.body = args[index + 1]
          index += 2
        } else if (flag === 'title' && index + 1 < args.length && behavior.title === undefined) {
          behavior.title = args[index + 1]
          index += 2
        } else return null
      }
      if (Object.keys(headers).length > 0) behavior.headers = headers
    } else if (
      command === 'profile' &&
      args.length === 2 &&
      ['previous', 'next'].includes(args[0]) &&
      ['wrap', 'stop'].includes(args[1])
    )
      behavior = { type: 'switchProfile', direction: args[0], wrap: args[1] === 'wrap' }
    else if (command === 'quick' && args.length === 1) behavior = { type: 'quickOverlay', profileId: args[0] }
    else if (command === 'clipboard' && args.length === 0) behavior = { type: 'clipboardOverlay', action: 'paste' }
    else if (command === 'clipboard' && args.length === 1 && (args[0] === 'paste' || args[0] === 'copy'))
      behavior = { type: 'clipboardOverlay', action: args[0] === 'copy' ? 'copyText' : 'paste' }
    else if (command === 'disabled' && args.length === 0) behavior = { type: 'disabled' }
    else return null
    behaviors.push({ ...behavior, enabled })
  }
  return behaviors
}

/** Reject an invalid sequence as a whole and assign fresh IDs on each paste. */
export function parseSequenceImport(value: unknown): Behavior[] | null {
  if (typeof value !== 'string') return null
  const entries = parseSequenceText(value)
  if (entries === null) return null
  const result: Behavior[] = []
  for (const entry of entries) {
    const behavior = normalizeBehavior(entry)
    if (!behavior) return null
    result.push(behavior)
  }
  return result
}

/** Parse a current, device-scoped mapping export. */
export function parseMappingImport(value: unknown, targetDeviceId: DeviceId = 'rc003'): ImportedMapping | null {
  let parsed: unknown = value
  if (typeof value === 'string') {
    try {
      parsed = JSON.parse(value) as unknown
    } catch {
      return null
    }
  }
  if (!isRecord(parsed)) return null

  if (parsed.format !== mappingTransferFormat || ![mappingTransferVersion, 3].includes(parsed.version as number))
    return null
  if (parsed.deviceId !== targetDeviceId) return null
  const device = devices.find(device => device.id === targetDeviceId)!
  const source = parsed.behaviors
  if (!hasBehaviorMapShape(source) || !isRecord(source)) return null
  if (
    Object.keys(source).some(id => !(device.inputIds as readonly string[]).includes(id)) ||
    device.inputIds.some(id => {
      const triggers = source[id]
      return !isRecord(triggers) || triggerTypes.some(trigger => !Array.isArray(triggers[trigger]))
    })
  )
    return null
  const parsedBehaviors = parseStoredBehaviors(source)
  const behaviors = createEmptyBehaviorMap()
  for (const inputId of device.inputIds) behaviors[inputId] = parsedBehaviors[inputId]
  const imported: ImportedMapping = {
    behaviors,
    enabled: typeof parsed.enabled === 'boolean' ? parsed.enabled : undefined,
  }
  if (typeof parsed.profileName === 'string' && parsed.profileName.trim()) {
    imported.profileName = parsed.profileName
      .trim()
      .replace(/[\u0000-\u001f\u007f]/g, '')
      .slice(0, 40)
  }
  return imported
}

/** Replace one ordered list, cloning all values to keep React state immutable. */
export function updateBehaviorList(
  map: BehaviorMap,
  buttonId: InputId,
  trigger: TriggerType,
  update: (list: Behavior[]) => Behavior[],
): BehaviorMap {
  if (!isButtonId(buttonId)) throw new Error(`Unsupported mapping input: ${buttonId}`)
  const next = { ...map, [buttonId]: { ...map[buttonId] } }
  next[buttonId][trigger] = update(map[buttonId][trigger].map(cloneBehavior)).map(cloneBehavior)
  return next
}

/** Move a behavior in a trigger list; invalid indices return an unchanged clone. */
export function moveBehavior(
  map: BehaviorMap,
  buttonId: InputId,
  trigger: TriggerType,
  fromIndex: number,
  toIndex: number,
): BehaviorMap {
  return updateBehaviorList(map, buttonId, trigger, list => {
    if (
      !Number.isInteger(fromIndex) ||
      !Number.isInteger(toIndex) ||
      fromIndex < 0 ||
      fromIndex >= list.length ||
      toIndex < 0 ||
      toIndex >= list.length ||
      fromIndex === toIndex
    )
      return list
    const next = [...list]
    const [item] = next.splice(fromIndex, 1)
    next.splice(toIndex, 0, item)
    return next
  })
}
