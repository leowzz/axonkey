import { invoke } from '@tauri-apps/api/core'
import { logError } from './runtimeLogging.ts'

export const storageMigrationMarkerKey = 'axonkey.storage-migrated.v1'

export const persistedConfigKeys = [
  'axonkey.settings.v1',
  'axonkey.mapping-profiles.v1',
  'axonkey.mapping-profiles.v2',
  'axonkey.saved-sequences.v1',
  'axonkey.audio-settings.v2',
  'axonkey.ui-state.v1',
  'axonkey.cloud-profile-metadata.v1',
  'axonkey.cloud-installation.v1',
  'axonkey.cloud-computer-name.v1',
  'axonkey.relay.v1',
  'axonkey.device-input-selection.v1',
  'axonkey.mapping-panel-layout.v1',
  'axonkey.device-hub-card-order.v1',
  'axonkey.device-hub-discovered-expanded.v1',
  'axonkey.remote-interaction-hint.v1',
] as const

type StorageLike = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>
type InvokeFn = <T>(cmd: string, args?: Record<string, unknown>) => Promise<T>

let nativeHydrated = false
let lifecycleBound = false
let activeInvoke: InvokeFn = invoke
const memory = new Map<string, string>()
const pendingUpdates = new Map<string, string | null>()
let flushScheduled = false
let writeChain: Promise<void> = Promise.resolve()

function bindLifecycleFlush() {
  if (lifecycleBound || typeof window === 'undefined' || typeof window.addEventListener !== 'function') return
  lifecycleBound = true
  window.addEventListener('pagehide', () => {
    void flushAppStorage().catch(() => {})
  })
  if (typeof document !== 'undefined' && typeof document.addEventListener === 'function') {
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'hidden') void flushAppStorage().catch(() => {})
    })
  }
}

function fallbackStorage(): StorageLike {
  if (typeof window !== 'undefined' && 'localStorage' in window) {
    const store = window.localStorage
    if (!store) throw new Error('localStorage is unavailable')
    return store
  }
  if (typeof localStorage !== 'undefined' && localStorage) {
    return localStorage
  }
  throw new Error('localStorage is unavailable')
}

function tryLegacyLocalStorage(): StorageLike | null {
  try {
    if (typeof window !== 'undefined' && window.localStorage) return window.localStorage
  } catch {
    // Ignore restricted WebView storage environments.
  }
  return null
}

function enqueueFlush(): Promise<void> {
  if (!pendingUpdates.size) return writeChain
  const batch = Object.fromEntries(pendingUpdates.entries())
  pendingUpdates.clear()
  const call = activeInvoke
  const nextWrite = writeChain.then(async () => {
    try {
      await call<void>('update_app_config', { updates: batch })
    } catch (error) {
      for (const [key, value] of Object.entries(batch)) {
        if (!pendingUpdates.has(key)) pendingUpdates.set(key, value)
      }
      logError('Failed to persist app configuration to data directory', error)
      throw error
    }
  })
  // Keep writeChain recoverable after an error while letting callers of enqueueFlush() observe failures.
  writeChain = nextWrite.catch(() => {})
  return nextWrite
}

function scheduleFlush() {
  if (flushScheduled) return
  flushScheduled = true
  queueMicrotask(() => {
    flushScheduled = false
    void enqueueFlush().catch(() => {})
  })
}

export const appStorage: StorageLike = {
  getItem(key: string): string | null {
    if (!nativeHydrated) return fallbackStorage().getItem(key)
    return memory.get(key) ?? null
  },

  setItem(key: string, value: string): void {
    const normalized = String(value)
    if (!nativeHydrated) {
      fallbackStorage().setItem(key, normalized)
      return
    }
    if (memory.get(key) === normalized && !pendingUpdates.has(key)) return
    memory.set(key, normalized)
    pendingUpdates.set(key, normalized)
    scheduleFlush()
  },

  removeItem(key: string): void {
    if (!nativeHydrated) {
      fallbackStorage().removeItem(key)
      return
    }
    const hadKey = memory.delete(key)
    if (hadKey || pendingUpdates.has(key)) {
      pendingUpdates.set(key, null)
      scheduleFlush()
    }
    tryLegacyLocalStorage()?.removeItem(key)
  },
}

export async function flushAppStorage(): Promise<void> {
  if (!nativeHydrated) return
  flushScheduled = false
  await enqueueFlush()
}

export async function bootstrapAppStorage(options?: {
  invokeFn?: InvokeFn
  legacyStorage?: StorageLike | null
  forceNative?: boolean
}): Promise<void> {
  const isNative = options?.forceNative ?? (typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window)
  if (!isNative) {
    nativeHydrated = false
    return
  }

  activeInvoke = options?.invokeFn ?? invoke
  memory.clear()
  pendingUpdates.clear()

  try {
    const loaded = await activeInvoke<Record<string, string>>('load_app_config')
    for (const [key, value] of Object.entries(loaded ?? {})) {
      if (typeof value === 'string') memory.set(key, value)
    }
  } catch (error) {
    nativeHydrated = false
    logError('Failed to load native app storage; falling back to WebView localStorage', error)
    return
  }

  nativeHydrated = true
  bindLifecycleFlush()

  if (memory.get(storageMigrationMarkerKey) !== '1') {
    const legacy = options?.legacyStorage === undefined ? tryLegacyLocalStorage() : options.legacyStorage
    const migrated: Record<string, string> = {}
    if (legacy) {
      for (const key of persistedConfigKeys) {
        let legacyValue: string | null = null
        try {
          legacyValue = legacy.getItem(key)
        } catch {
          legacyValue = null
        }
        if (legacyValue === null || memory.has(key)) continue
        memory.set(key, legacyValue)
        migrated[key] = legacyValue
      }
    }
    memory.set(storageMigrationMarkerKey, '1')
    migrated[storageMigrationMarkerKey] = '1'

    try {
      await activeInvoke<void>('update_app_config', { updates: migrated })
    } catch (error) {
      // Keep hydrated values in memory and queue retry on next flush; legacy localStorage stays untouched.
      for (const [key, value] of Object.entries(migrated)) {
        if (!pendingUpdates.has(key)) pendingUpdates.set(key, value)
      }
      logError('Failed to persist migrated legacy localStorage config; queued for retry', error)
    }
  }
}

export function resetAppStorageForTests(): void {
  nativeHydrated = false
  activeInvoke = invoke
  memory.clear()
  pendingUpdates.clear()
  flushScheduled = false
  writeChain = Promise.resolve()
}
