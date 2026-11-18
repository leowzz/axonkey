import { invoke } from '@tauri-apps/api/core'
import { logError } from './runtimeLogging.ts'

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
  'axonkey.device-hub-card-order.v1',
  'axonkey.device-hub-discovered-expanded.v1',
  'axonkey.remote-interaction-hint.v1',
] as const

type StorageLike = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>
type InvokeFn = <T>(cmd: string, args?: Record<string, unknown>) => Promise<T>

let nativeHydrated = false
let activeInvoke: InvokeFn = invoke
const memory = new Map<string, string>()
const pendingUpdates = new Map<string, string | null>()
let flushScheduled = false
let writeChain: Promise<void> = Promise.resolve()

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
  writeChain = writeChain
    .then(() => call<void>('update_app_config', { updates: batch }))
    .catch(error => {
      logError('Failed to persist app configuration to data directory', error)
    })
  return writeChain
}

function scheduleFlush() {
  if (flushScheduled) return
  flushScheduled = true
  queueMicrotask(() => {
    flushScheduled = false
    void enqueueFlush()
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

    const legacy = options?.legacyStorage === undefined ? tryLegacyLocalStorage() : options.legacyStorage
    if (legacy) {
      const migrated: Record<string, string> = {}
      for (const key of persistedConfigKeys) {
        let legacyValue: string | null = null
        try {
          legacyValue = legacy.getItem(key)
        } catch {
          legacyValue = null
        }
        if (legacyValue === null) continue
        if (!memory.has(key)) {
          memory.set(key, legacyValue)
          migrated[key] = legacyValue
        }
        try {
          legacy.removeItem(key)
        } catch {
          // Best-effort cleanup of legacy WebView localStorage.
        }
      }
      if (Object.keys(migrated).length > 0) {
        await activeInvoke<void>('update_app_config', { updates: migrated })
      }
    }

    nativeHydrated = true
  } catch (error) {
    nativeHydrated = false
    logError('Failed to bootstrap native app storage', error)
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
