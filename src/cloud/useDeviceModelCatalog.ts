import { invoke } from '@tauri-apps/api/core'
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import {
  activateCatalogDeviceDescriptors,
  applyLocalCustomDevices,
  buildOfflineFallbackCatalog,
  extractCatalogRuntimeDescriptors,
  findLocalCloudDescriptorOverrides,
  getLocalCustomDevices,
  hydratePreviewLocalCustomDevices,
  loadDeviceModelCatalog,
  mergeCatalogWithLocalCustomDevices,
  readCachedDeviceModelCatalog,
  subscribeDeviceModelCatalog,
  subscribeLocalCustomDevices,
  warnLocalCloudOverrides,
  type CatalogCacheStorage,
  type CatalogDeviceModel,
  type CloudDescriptorSvgPayload,
  type LocalCustomDeviceEntry,
} from './deviceModelCatalog.ts'
import type { RelayClient } from './relayClient.ts'

const previewInstancesKey = 'axonkey.device-instances.preview.v1'

export type UseDeviceModelCatalogOptions = {
  native?: boolean
  retainedKinds?: readonly string[]
  onNativeDescriptorsSynced?: () => void
}

let lastSyncedNativeSignature: string | null = null
let lastWarnedLocalOverrideSignature: string | null = null

export function resetNativeDescriptorSyncCache() {
  lastSyncedNativeSignature = null
  lastWarnedLocalOverrideSignature = null
}

function localStorageOrUndefined(): CatalogCacheStorage | undefined {
  try {
    return typeof window === 'undefined' ? undefined : window.localStorage
  } catch {
    return undefined
  }
}

async function refreshLocalCustomDevices(native: boolean): Promise<LocalCustomDeviceEntry[]> {
  if (native) {
    try {
      const list = await invoke<LocalCustomDeviceEntry[]>('list_local_custom_devices')
      if (Array.isArray(list)) applyLocalCustomDevices(list)
    } catch {
      /* Ignore when command is unavailable in non-desktop mocks. */
    }
    return [...getLocalCustomDevices()]
  }
  return hydratePreviewLocalCustomDevices(localStorageOrUndefined())
}

function collectRetainedKinds(storage: CatalogCacheStorage | undefined, explicitKinds?: readonly string[]): string[] {
  const result = new Set<string>(explicitKinds ?? [])
  if (storage) {
    try {
      const raw = storage.getItem(previewInstancesKey)
      if (raw) {
        const parsed = JSON.parse(raw) as { instances?: { kind?: unknown }[] }
        if (Array.isArray(parsed?.instances)) {
          for (const instance of parsed.instances) {
            if (typeof instance?.kind === 'string' && instance.kind.trim()) {
              result.add(instance.kind.trim())
            }
          }
        }
      }
    } catch {
      /* Preview storage is best-effort. */
    }
  }
  return [...result].sort()
}

async function syncNativeCloudDescriptors(
  descriptors: CloudDescriptorSvgPayload[],
  native: boolean,
  forceEvenWhenEmpty: boolean,
  onSynced?: () => void,
): Promise<boolean> {
  if (!native) return false
  if (descriptors.length === 0 && !forceEvenWhenEmpty && lastSyncedNativeSignature === null) return false
  const signature = JSON.stringify(descriptors)
  if (signature === lastSyncedNativeSignature) return false
  lastSyncedNativeSignature = signature
  try {
    const result = await invoke<{ changed?: boolean } | undefined>('sync_cloud_device_descriptors', { descriptors })
    if (result?.changed) {
      onSynced?.()
      return true
    }
    return false
  } catch {
    lastSyncedNativeSignature = null
    return false
  }
}

export function useDeviceModelCatalog(
  client: RelayClient | undefined,
  accountReady = true,
  options: UseDeviceModelCatalogOptions = {},
) {
  const native = options.native ?? (typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window)
  const onNativeSyncedRef = useRef(options.onNativeDescriptorsSynced)
  onNativeSyncedRef.current = options.onNativeDescriptorsSynced
  const retainedKindsRef = useRef(options.retainedKinds)
  retainedKindsRef.current = options.retainedKinds
  const explicitRetainedKey = (options.retainedKinds ?? []).join('\0')

  const [initialState] = useState(() => {
    const storage = localStorageOrUndefined()
    const retainedKinds = collectRetainedKinds(storage, options.retainedKinds)
    const cached = readCachedDeviceModelCatalog(storage)
    if (cached?.fresh) {
      activateCatalogDeviceDescriptors(cached.items)
      return { items: cached.items, loading: false }
    }
    const fallback = buildOfflineFallbackCatalog(cached?.items, retainedKinds)
    activateCatalogDeviceDescriptors(fallback)
    return { items: fallback, loading: Boolean(client) }
  })

  const [items, setItems] = useState<CatalogDeviceModel[]>(initialState.items)
  const [loading, setLoading] = useState<boolean>(initialState.loading)
  const localDevices = useSyncExternalStore(subscribeLocalCustomDevices, getLocalCustomDevices, getLocalCustomDevices)

  useEffect(() => {
    void refreshLocalCustomDevices(native)
  }, [native])

  useEffect(() => {
    return subscribeDeviceModelCatalog(() => {
      const storage = localStorageOrUndefined()
      const retainedKinds = collectRetainedKinds(storage, retainedKindsRef.current)
      const cached = readCachedDeviceModelCatalog(storage)
      const next = cached?.fresh ? cached.items : buildOfflineFallbackCatalog(cached?.items, retainedKinds)
      const { cloudDescriptors } = activateCatalogDeviceDescriptors(next)
      void syncNativeCloudDescriptors(cloudDescriptors, native, Boolean(client), onNativeSyncedRef.current)
      setItems(next)
    })
  }, [client, native])

  useEffect(() => {
    const storage = localStorageOrUndefined()
    const retainedKinds = collectRetainedKinds(storage, options.retainedKinds)
    const cached = readCachedDeviceModelCatalog(storage)
    if (cached?.fresh) {
      const { cloudDescriptors } = activateCatalogDeviceDescriptors(cached.items)
      void syncNativeCloudDescriptors(cloudDescriptors, native, Boolean(client), onNativeSyncedRef.current)
      setItems(cached.items)
      setLoading(false)
      return
    }
    if (!client) {
      const fallback = buildOfflineFallbackCatalog(cached?.items, retainedKinds)
      const { cloudDescriptors } = activateCatalogDeviceDescriptors(fallback)
      void syncNativeCloudDescriptors(cloudDescriptors, native, false, onNativeSyncedRef.current)
      setItems(fallback)
      setLoading(false)
      return
    }
    if (!accountReady) {
      setLoading(true)
      return
    }
    let active = true
    setLoading(true)
    void loadDeviceModelCatalog(client, storage, undefined, { retainedKinds })
      .then(loaded => {
        if (!active) return
        const { cloudDescriptors } = extractCatalogRuntimeDescriptors(loaded)
        void syncNativeCloudDescriptors(cloudDescriptors, native, true, onNativeSyncedRef.current)
        setItems(loaded)
        setLoading(false)
      })
      .catch(() => {
        if (!active) return
        const fallback = buildOfflineFallbackCatalog(cached?.items, retainedKinds)
        const { cloudDescriptors } = activateCatalogDeviceDescriptors(fallback)
        void syncNativeCloudDescriptors(cloudDescriptors, native, true, onNativeSyncedRef.current)
        setItems(fallback)
        setLoading(false)
      })
    return () => {
      active = false
    }
  }, [client, accountReady, native, explicitRetainedKey])

  const refresh = useCallback(async () => {
    const storage = localStorageOrUndefined()
    const retainedKinds = collectRetainedKinds(storage, retainedKindsRef.current)
    const latestLocal = await refreshLocalCustomDevices(native)
    if (!client) {
      const cached = readCachedDeviceModelCatalog(storage)
      const fallback = cached?.fresh ? cached.items : buildOfflineFallbackCatalog(cached?.items, retainedKinds)
      const { cloudDescriptors } = activateCatalogDeviceDescriptors(fallback)
      await syncNativeCloudDescriptors(cloudDescriptors, native, false, onNativeSyncedRef.current)
      setItems(fallback)
      return mergeCatalogWithLocalCustomDevices(fallback, latestLocal)
    }
    setLoading(true)
    try {
      const loaded = await loadDeviceModelCatalog(client, storage, undefined, {
        retainedKinds,
        forceRefresh: true,
      })
      const { cloudDescriptors } = extractCatalogRuntimeDescriptors(loaded)
      await syncNativeCloudDescriptors(cloudDescriptors, native, true, onNativeSyncedRef.current)
      setItems(loaded)
      return mergeCatalogWithLocalCustomDevices(loaded, latestLocal)
    } finally {
      setLoading(false)
    }
  }, [client, native])

  const localCloudOverrides = useMemo(
    () => findLocalCloudDescriptorOverrides(items, localDevices),
    [items, localDevices],
  )
  useEffect(() => {
    if (localCloudOverrides.length === 0) {
      lastWarnedLocalOverrideSignature = null
      return
    }
    const signature = JSON.stringify(localCloudOverrides.map(item => [item.kind, item.filePath, item.differsFromCloud]))
    if (signature === lastWarnedLocalOverrideSignature) return
    lastWarnedLocalOverrideSignature = signature
    warnLocalCloudOverrides(localCloudOverrides)
  }, [localCloudOverrides])

  const mergedItems = useMemo(() => mergeCatalogWithLocalCustomDevices(items, localDevices), [items, localDevices])
  const modelsByCode = useMemo(() => new Map(mergedItems.map(item => [item.code, item])), [mergedItems])
  return { items: mergedItems, modelsByCode, localCloudOverrides, loading, refresh }
}
