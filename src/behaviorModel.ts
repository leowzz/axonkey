/**
 * The editable behavior model used by the key-mapping workbench.
 *
 * A trigger owns an ordered list instead of a single action, so one press can
 * run a sequence such as shortcut -> delay -> paste.
 */

import { devices, inputIds, remoteButtonIds } from './deviceModel.ts'
import type { DeviceId, InputId, RemoteButtonId } from './deviceModel.ts'
export type { InputId } from './deviceModel.ts'
export const buttonIds = remoteButtonIds
export type ButtonId = RemoteButtonId

export const triggerTypes = ['click', 'doubleClick', 'longPress'] as const
export type TriggerType = (typeof triggerTypes)[number]

export const behaviorTypes = ['key', 'shortcut', 'wheel', 'mouse', 'cursorMove', 'paste', 'delay', 'openApp', 'openWebsite', 'switchProfile', 'disabled'] as const
export type BehaviorType = (typeof behaviorTypes)[number]
export const cursorDirections = ['up', 'down', 'left', 'right'] as const
export type CursorDirection = (typeof cursorDirections)[number]
export const defaultCursorDistance = 50
export const maxCursorDistance = 500

type BehaviorBase = {
  id: string
  enabled: boolean
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
}

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
export type OpenWebsiteBehavior = BehaviorBase & { type: 'openWebsite'; url: string }

export type Behavior = KeyBehavior | ShortcutBehavior | WheelBehavior | MouseBehavior | CursorMoveBehavior | PasteBehavior | DelayBehavior | OpenAppBehavior | OpenWebsiteBehavior | DisabledBehavior | SwitchProfileBehavior

export type TriggerBehaviors = Record<TriggerType, Behavior[]>
export type BehaviorMap = Record<InputId, TriggerBehaviors>

export const mappingTransferFormat = 'axonkey-mapping'
export const mappingTransferVersion = 2

export type MappingTransfer = {
  format: typeof mappingTransferFormat
  version: typeof mappingTransferVersion
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

export type CreateBehaviorOptions =
  | { type: 'wheel'; direction: 'up' | 'down' | 'left' | 'right'; enabled?: boolean; id?: string }
  | { type: 'mouse'; button: 'left' | 'right' | 'back' | 'forward'; enabled?: boolean; id?: string }
  | { type: 'cursorMove'; direction: CursorDirection; distance?: number; enabled?: boolean; id?: string }
  | { type: 'key'; key?: string; enabled?: boolean; id?: string }
  | { type: 'shortcut'; keys?: readonly string[]; enabled?: boolean; id?: string }
  | { type: 'paste'; text?: string; enabled?: boolean; id?: string }
  | { type: 'delay'; ms?: number; enabled?: boolean; id?: string }
  | { type: 'openApp'; path?: string; enabled?: boolean; id?: string }
  | { type: 'openWebsite'; url?: string; enabled?: boolean; id?: string }
  | { type: 'switchProfile'; direction?: ProfileDirection; wrap?: boolean; enabled?: boolean; id?: string }
  | { type: 'disabled'; enabled?: boolean; id?: string }

const maxDelayMs = 300_000

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
    return (url.protocol === 'https:' || url.protocol === 'http:') && url.hostname && !url.username && !url.password ? url.href : null
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

  switch (options.type) {
    case 'wheel':
      return { id, enabled, type: 'wheel', direction: options.direction }
    case 'mouse':
      return { id, enabled, type: 'mouse', button: options.button }
    case 'cursorMove':
      return { id, enabled, type: 'cursorMove', direction: options.direction, distance: finiteCursorDistance(options.distance) }
    case 'key':
      return { id, enabled, type: 'key', key: cleanKey(options.key) || 'Enter' }
    case 'shortcut': {
      const keys = cleanKeys(options.keys)
      return { id, enabled, type: 'shortcut', keys: keys.length > 0 ? keys : ['Ctrl', 'C'] }
    }
    case 'paste':
      return { id, enabled, type: 'paste', text: typeof options.text === 'string' ? options.text : '' }
    case 'delay':
      return { id, enabled, type: 'delay', ms: finiteDelay(options.ms) }
    case 'openApp':
      return { id, enabled, type: 'openApp', path: normalizeApplicationPath(options.path) ?? '' }
    case 'openWebsite':
      return { id, enabled, type: 'openWebsite', url: normalizeWebsiteUrl(options.url) ?? '' }
    case 'switchProfile':
      return { id, enabled, type: 'switchProfile', direction: options.direction ?? 'next', wrap: options.wrap !== false }
    case 'disabled':
      return { id, enabled, type: 'disabled' }
  }
}

function cloneBehavior(behavior: Behavior): Behavior {
  return behavior.type === 'shortcut' ? { ...behavior, keys: [...behavior.keys] } : { ...behavior }
}

function emptyTriggers(): TriggerBehaviors {
  return { click: [], doubleClick: [], longPress: [] }
}

/** Returns a fresh map so callers can mutate their state without sharing defaults. */
export function createEmptyBehaviorMap(): BehaviorMap {
  return Object.fromEntries(inputIds.map((id) => [id, emptyTriggers()])) as BehaviorMap
}

/** The initial configuration mirrors the two mappings used by the current UI. */
export function createDefaultBehaviorMap(): BehaviorMap {
  const map = createEmptyBehaviorMap()
  map.power.click = [createBehavior({ type: 'key', key: 'Esc', id: 'power-click-esc' })]
  map.voice.click = [createBehavior({ type: 'key', key: 'RAlt', id: 'voice-click-ralt' })]
  return map
}

/** Clone every sequence so a profile can be edited independently of its source. */
export function cloneBehaviorMap(map: BehaviorMap): BehaviorMap {
  return Object.fromEntries(inputIds.map((id) => [
    id,
    Object.fromEntries(triggerTypes.map((trigger) => [
      trigger,
      map[id][trigger].map((behavior) => behavior.type === 'shortcut'
        ? { ...behavior, keys: [...behavior.keys] }
        : { ...behavior }),
    ])),
  ])) as BehaviorMap
}

function isButtonId(value: string): value is InputId {
  return (inputIds as readonly string[]).includes(value)
}

function isTriggerType(value: string): value is TriggerType {
  return (triggerTypes as readonly string[]).includes(value)
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

  switch (type) {
    case 'wheel':
      return ['up', 'down', 'left', 'right'].includes(String(value.direction)) ? { id, enabled, type, direction: value.direction as WheelBehavior['direction'] } : null
    case 'mouse':
      return ['left', 'right', 'back', 'forward'].includes(String(value.button)) ? { id, enabled, type, button: value.button as MouseBehavior['button'] } : null
    case 'cursorMove':
      return (cursorDirections as readonly string[]).includes(String(value.direction))
        ? { id, enabled, type, direction: value.direction as CursorDirection, distance: finiteCursorDistance(value.distance) }
        : null
    case 'key': {
      const key = cleanKey(value.key)
      return key ? { id, enabled, type, key } : null
    }
    case 'shortcut': {
      const keys = cleanKeys(value.keys)
      return keys.length > 0 ? { id, enabled, type, keys } : null
    }
    case 'paste':
      return typeof value.text === 'string' ? { id, enabled, type, text: value.text } : null
    case 'delay':
      return { id, enabled, type, ms: finiteDelay(value.ms) }
    case 'openApp': {
      const path = normalizeApplicationPath(value.path)
      return path ? { id, enabled, type, path } : null
    }
    case 'openWebsite': {
      const url = normalizeWebsiteUrl(value.url)
      return url ? { id, enabled, type, url } : null
    }
    case 'switchProfile':
      return (value.direction === 'previous' || value.direction === 'next') && (value.wrap === undefined || typeof value.wrap === 'boolean')
        ? { id, enabled, type, direction: value.direction, wrap: value.wrap !== false } : null
    case 'disabled':
      return { id, enabled, type }
  }
  return null
}

/** Convert the legacy single-string mapping format into one-click behaviors. */
export function legacyMappingsToBehaviorMap(mappings: unknown): BehaviorMap {
  const map = createEmptyBehaviorMap()
  if (!isRecord(mappings)) return map

  for (const [id, value] of Object.entries(mappings)) {
    if (!isButtonId(id) || typeof value !== 'string') continue
    const action = value.trim()
    if (!action || action === 'original') continue
    const keys = action.split('+').map((key) => key.trim()).filter(Boolean)
    map[id].click = [keys.length > 1
      ? createBehavior({ type: 'shortcut', keys, id: `${id}-click-legacy` })
      : createBehavior({ type: 'key', key: keys[0], id: `${id}-click-legacy` })]
  }
  return map
}

function behaviorContainer(value: unknown) {
  if (!isRecord(value)) return null
  if (isRecord(value.behaviors)) return value.behaviors
  if (isRecord(value.actions)) return value.actions
  return value
}

function hasBehaviorMapShape(value: unknown) {
  if (!isRecord(value)) return false
  const knownButtons = inputIds.filter((buttonId) => Object.prototype.hasOwnProperty.call(value, buttonId))
  if (knownButtons.length === 0) return false
  return knownButtons.every((buttonId) => {
    const rawButton = value[buttonId]
    if (!isRecord(rawButton)) return false
    return triggerTypes.every((trigger) => {
      const rawList = rawButton[trigger]
      return rawList === undefined || (Array.isArray(rawList) && rawList.every((entry) => normalizeBehavior(entry) !== null))
    })
  })
}

function hasLegacyMappingShape(value: unknown) {
  if (!isRecord(value)) return false
  const knownButtons = inputIds.filter((buttonId) => Object.prototype.hasOwnProperty.call(value, buttonId))
  return knownButtons.length > 0 && knownButtons.every((buttonId) => typeof value[buttonId] === 'string')
}

/**
 * Parse localStorage JSON (or an already parsed value), merging it with defaults.
 * Both the new behavior map and the previous `{ mappings: Record<ButtonId,string> }`
 * settings shape are accepted.
 */
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

  const directLegacy = inputIds.some((buttonId) => typeof parsed[buttonId] === 'string')
  const legacy = isRecord(parsed.mappings)
    ? legacyMappingsToBehaviorMap(parsed.mappings)
    : directLegacy
      ? legacyMappingsToBehaviorMap(parsed)
      : null
  const source = behaviorContainer(parsed)
  if (!source) return legacy ?? fallback

  const result = legacy ?? fallback
  for (const buttonId of inputIds) {
    const rawButton = source[buttonId]
    if (!isRecord(rawButton)) continue
    for (const trigger of triggerTypes) {
      const rawList = rawButton[trigger]
      if (!Array.isArray(rawList)) continue
      result[buttonId][trigger] = rawList
        .map((entry, index) => normalizeBehavior(entry, `${buttonId}-${trigger}-${index + 1}`))
        .filter((entry): entry is Behavior => entry !== null)
    }
  }
  return result
}

/** Build the stable, versioned JSON shape used for mapping file transfers. */
export function createMappingExport(behaviors: BehaviorMap, enabled: boolean, exportedAt = new Date().toISOString(), profileName?: string, deviceId: DeviceId = 'rc003'): MappingTransfer {
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
  const name = typeof profileName === 'string' ? profileName.trim().replace(/[\u0000-\u001f\u007f]/g, '').slice(0, 40) : ''
  if (name) transfer.profileName = name
  return transfer
}

const sequenceTextHeader = 'axonkey/1'

function sequenceArgument(value: string) {
  return value && !/[\s"\\]/.test(value) ? value : JSON.stringify(value)
}

/** One command per line; quoted arguments preserve text, whitespace and paths. */
export function serializeSequence(behaviors: Behavior[]): string {
  return [sequenceTextHeader, ...behaviors.map((behavior) => {
    let line: string
    switch (behavior.type) {
      case 'key': line = `key ${sequenceArgument(behavior.key)}`; break
      case 'shortcut': line = `keys ${behavior.keys.map(sequenceArgument).join(' ')}`; break
      case 'delay': line = `wait ${behavior.ms}ms`; break
      case 'paste': line = `text ${JSON.stringify(behavior.text)}`; break
      case 'wheel': line = `wheel ${behavior.direction}`; break
      case 'mouse': line = `mouse ${behavior.button}`; break
      case 'cursorMove': line = `move ${behavior.direction} ${behavior.distance}`; break
      case 'openApp': line = `app ${sequenceArgument(behavior.path)}`; break
      case 'openWebsite': line = `url ${sequenceArgument(behavior.url)}`; break
      case 'switchProfile': line = `profile ${behavior.direction} ${behavior.wrap ? 'wrap' : 'stop'}`; break
      case 'disabled': line = 'disabled'; break
    }
    return behavior.enabled ? line : `off ${line}`
  }), 'end'].join('\n')
}

function sequenceTokens(line: string): string[] | null {
  const tokens: string[] = []
  let remaining = line.trim()
  while (remaining) {
    const match = /^(?:"(?:\\.|[^"\\])*"|[^\s"]+)(?=\s|$)/.exec(remaining)
    if (!match) return null
    try {
      tokens.push(match[0].startsWith('"') ? JSON.parse(match[0]) as string : match[0])
    } catch {
      return null
    }
    remaining = remaining.slice(match[0].length).trimStart()
  }
  return tokens
}

function parseSequenceText(text: string): unknown[] | null {
  // Explicit boundaries survive captions, Markdown fences and quote blocks.
  const lines = text.split(/\r\n?|\n/).map((line) => line.trim().replace(/^(?:>\s*)+/, '').trim())
  const headers = lines.flatMap((line, index) => /^axonkey\/\S+$/.test(line) ? [index] : [])
  if (headers.length !== 1 || lines[headers[0]] !== sequenceTextHeader) return null
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
    else if (command === 'keys' && args.length > 0 && args.every((key) => key.trim())) behavior = { type: 'shortcut', keys: args }
    else if (command === 'wait' && args.length === 1 && /^\d+(?:\.\d+)?(?:ms)?$/.test(args[0])) {
      const ms = Number(args[0].replace(/ms$/, ''))
      if (ms > maxDelayMs) return null
      behavior = { type: 'delay', ms }
    }
    else if (command === 'text' && args.length === 1) behavior = { type: 'paste', text: args[0] }
    else if (command === 'wheel' && args.length === 1) behavior = { type: 'wheel', direction: args[0] }
    else if (command === 'mouse' && args.length === 1) behavior = { type: 'mouse', button: args[0] }
    else if (command === 'move' && args.length === 2 && /^\d+$/.test(args[1])) {
      const distance = Number(args[1])
      if (distance < 1 || distance > maxCursorDistance) return null
      behavior = { type: 'cursorMove', direction: args[0], distance }
    }
    else if (command === 'app' && args.length === 1) behavior = { type: 'openApp', path: args[0] }
    else if (command === 'url' && args.length === 1) behavior = { type: 'openWebsite', url: args[0] }
    else if (command === 'profile' && args.length === 2 && ['previous', 'next'].includes(args[0]) && ['wrap', 'stop'].includes(args[1])) behavior = { type: 'switchProfile', direction: args[0], wrap: args[1] === 'wrap' }
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

/** Parse a mapping export while retaining compatibility with older settings files. */
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

  const isVersionedExport = parsed.format === mappingTransferFormat
  if (parsed.format !== undefined && !isVersionedExport) return null
  if (isVersionedExport && parsed.version !== 1 && parsed.version !== mappingTransferVersion) return null
  const device = devices.find(device => device.id === targetDeviceId)!
  const isDeviceExport = isVersionedExport && parsed.version === mappingTransferVersion
  if (isDeviceExport && parsed.deviceId !== targetDeviceId) return null

  const source = isVersionedExport
    ? parsed.behaviors
    : isRecord(parsed.behaviors) ? parsed.behaviors : behaviorContainer(parsed)
  const validBehaviorMap = hasBehaviorMapShape(source)
  const validLegacyMappings = hasLegacyMappingShape(parsed.mappings)
  if (isVersionedExport ? !validBehaviorMap : !validBehaviorMap && !validLegacyMappings) {
    return null
  }
  if (isDeviceExport && (!isRecord(source)
    || Object.keys(source).some(id => !(device.inputIds as readonly string[]).includes(id))
    || device.inputIds.some(id => {
      const triggers = source[id]
      return !isRecord(triggers) || triggerTypes.some(trigger => !Array.isArray(triggers[trigger]))
    }))) return null

  const parsedBehaviors = parseStoredBehaviors(isVersionedExport ? { behaviors: source } : parsed)
  const behaviors = createEmptyBehaviorMap()
  for (const inputId of device.inputIds) behaviors[inputId] = parsedBehaviors[inputId]
  const imported: ImportedMapping = {
    behaviors,
    // Legacy files store the application-wide switch, not the mouse switch.
    enabled: (isDeviceExport || targetDeviceId === 'rc003') && typeof parsed.enabled === 'boolean' ? parsed.enabled : undefined,
  }
  if (isVersionedExport && typeof parsed.profileName === 'string' && parsed.profileName.trim()) {
    imported.profileName = parsed.profileName.trim().replace(/[\u0000-\u001f\u007f]/g, '').slice(0, 40)
  }
  return imported
}

/** Append a behavior without mutating the existing map. */
export function appendBehavior(map: BehaviorMap, buttonId: InputId, trigger: TriggerType, behavior: Behavior): BehaviorMap {
  return updateBehaviorList(map, buttonId, trigger, (list) => [...list, cloneBehavior(behavior)])
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
export function moveBehavior(map: BehaviorMap, buttonId: InputId, trigger: TriggerType, fromIndex: number, toIndex: number): BehaviorMap {
  return updateBehaviorList(map, buttonId, trigger, (list) => {
    if (!Number.isInteger(fromIndex) || !Number.isInteger(toIndex) || fromIndex < 0 || fromIndex >= list.length || toIndex < 0 || toIndex >= list.length || fromIndex === toIndex) return list
    const next = [...list]
    const [item] = next.splice(fromIndex, 1)
    next.splice(toIndex, 0, item)
    return next
  })
}
