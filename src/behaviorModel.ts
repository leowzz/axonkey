/**
 * The editable behavior model used by the key-mapping workbench.
 *
 * A trigger owns an ordered list instead of a single action, so one press can
 * run a sequence such as shortcut -> delay -> paste.
 */

export const buttonIds = [
  'power',
  'voice',
  'up',
  'left',
  'confirm',
  'right',
  'down',
  'home',
  'menu',
  'tv',
] as const

export type ButtonId = (typeof buttonIds)[number]

export const triggerTypes = ['click', 'doubleClick', 'longPress'] as const
export type TriggerType = (typeof triggerTypes)[number]

export const behaviorTypes = ['key', 'shortcut', 'paste', 'delay', 'disabled'] as const
export type BehaviorType = (typeof behaviorTypes)[number]

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

export type Behavior = KeyBehavior | ShortcutBehavior | PasteBehavior | DelayBehavior | DisabledBehavior

export type TriggerBehaviors = Record<TriggerType, Behavior[]>
export type BehaviorMap = Record<ButtonId, TriggerBehaviors>

export type CreateBehaviorOptions =
  | { type: 'key'; key?: string; enabled?: boolean; id?: string }
  | { type: 'shortcut'; keys?: readonly string[]; enabled?: boolean; id?: string }
  | { type: 'paste'; text?: string; enabled?: boolean; id?: string }
  | { type: 'delay'; ms?: number; enabled?: boolean; id?: string }
  | { type: 'disabled'; enabled?: boolean; id?: string }

const maxDelayMs = 300_000

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
  return Object.fromEntries(buttonIds.map((id) => [id, emptyTriggers()])) as BehaviorMap
}

/** The initial configuration mirrors the two mappings used by the current UI. */
export function createDefaultBehaviorMap(): BehaviorMap {
  const map = createEmptyBehaviorMap()
  map.power.click = [createBehavior({ type: 'key', key: 'Esc', id: 'power-click-esc' })]
  map.voice.click = [createBehavior({ type: 'key', key: 'RAlt', id: 'voice-click-ralt' })]
  return map
}

function isButtonId(value: string): value is ButtonId {
  return (buttonIds as readonly string[]).includes(value)
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

  const directLegacy = buttonIds.some((buttonId) => typeof parsed[buttonId] === 'string')
  const legacy = isRecord(parsed.mappings)
    ? legacyMappingsToBehaviorMap(parsed.mappings)
    : directLegacy
      ? legacyMappingsToBehaviorMap(parsed)
      : null
  const source = behaviorContainer(parsed)
  if (!source) return legacy ?? fallback

  const result = legacy ?? fallback
  for (const buttonId of buttonIds) {
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

/** Append a behavior without mutating the existing map. */
export function appendBehavior(map: BehaviorMap, buttonId: ButtonId, trigger: TriggerType, behavior: Behavior): BehaviorMap {
  return updateBehaviorList(map, buttonId, trigger, (list) => [...list, cloneBehavior(behavior)])
}

/** Replace one ordered list, cloning all values to keep React state immutable. */
export function updateBehaviorList(
  map: BehaviorMap,
  buttonId: ButtonId,
  trigger: TriggerType,
  update: (list: Behavior[]) => Behavior[],
): BehaviorMap {
  const next = { ...map, [buttonId]: { ...map[buttonId] } }
  next[buttonId][trigger] = update(map[buttonId][trigger].map(cloneBehavior)).map(cloneBehavior)
  return next
}

/** Move a behavior in a trigger list; invalid indices return an unchanged clone. */
export function moveBehavior(map: BehaviorMap, buttonId: ButtonId, trigger: TriggerType, fromIndex: number, toIndex: number): BehaviorMap {
  return updateBehaviorList(map, buttonId, trigger, (list) => {
    if (!Number.isInteger(fromIndex) || !Number.isInteger(toIndex) || fromIndex < 0 || fromIndex >= list.length || toIndex < 0 || toIndex >= list.length || fromIndex === toIndex) return list
    const next = [...list]
    const [item] = next.splice(fromIndex, 1)
    next.splice(toIndex, 0, item)
    return next
  })
}
