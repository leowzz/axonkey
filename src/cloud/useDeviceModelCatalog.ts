import { invoke } from '@tauri-apps/api/core'
import { useEffect, useMemo, useRef, useState } from 'react'
import {
  activateCatalogDeviceDescriptors,
  buildOfflineFallbackCatalog,
  extractCatalogRuntimeDescriptors,
  loadDeviceModelCatalog,
  readCachedDeviceModelCatalog,
  type CatalogCacheStorage,
  type CatalogDeviceModel,
  type CloudDescriptorSvgPayload,
} from './deviceModelCatalog.ts'
import type { RelayClient } from './relayClient.ts'

const previewInstancesKey = 'axonkey.device-instances.preview.v1'

export type UseDeviceModelCatalogOptions = {
  native?: boolean
  retainedKinds?: readonly string[]
  onNativeDescriptorsSynced?: () => void
}

let lastSyncedNativeSignature: string | null = null

export function resetNativeDescriptorSyncCache() {
  lastSyncedNativeSignature = null
}

function localStorageOrUndefined(): CatalogCacheStorage | undefined {
  try {
    return typeof window === 'undefined' ? undefined : window.localStorage
  } catch {
    return undefined
  }
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

function syncNativeCloudDescriptors(
  descriptors: CloudDescriptorSvgPayload[],
  native: boolean,
  forceEvenWhenEmpty: boolean,
  onSynced?: () => void,
) {
  if (!native) return
  if (descriptors.length === 0 && !forceEvenWhenEmpty && lastSyncedNativeSignature === null) return
  const signature = JSON.stringify(descriptors)
  if (signature === lastSyncedNativeSignature) return
  lastSyncedNativeSignature = signature
  void invoke<{ changed?: boolean } | undefined>('sync_cloud_device_descriptors', { descriptors })
    .then(result => {
      if (result?.changed) onSynced?.()
    })
    .catch(() => {
      lastSyncedNativeSignature = null
    })
}

export function useDeviceModelCatalog(
  client: RelayClient | undefined,
  accountReady = true,
  options: UseDeviceModelCatalogOptions = {},
) {
  const native = options.native ?? (typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window)
  const onNativeSyncedRef = useRef(options.onNativeDescriptorsSynced)
  onNativeSyncedRef.current = options.onNativeDescriptorsSynced
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

  useEffect(() => {
    const storage = localStorageOrUndefined()
    const retainedKinds = collectRetainedKinds(storage, options.retainedKinds)
    const cached = readCachedDeviceModelCatalog(storage)
    if (cached?.fresh) {
      const { cloudDescriptors } = activateCatalogDeviceDescriptors(cached.items)
      syncNativeCloudDescriptors(cloudDescriptors, native, Boolean(client), onNativeSyncedRef.current)
      setItems(cached.items)
      setLoading(false)
      return
    }
    if (!client) {
      const fallback = buildOfflineFallbackCatalog(cached?.items, retainedKinds)
      const { cloudDescriptors } = activateCatalogDeviceDescriptors(fallback)
      syncNativeCloudDescriptors(cloudDescriptors, native, false, onNativeSyncedRef.current)
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
        syncNativeCloudDescriptors(cloudDescriptors, native, true, onNativeSyncedRef.current)
        setItems(loaded)
        setLoading(false)
      })
      .catch(() => {
        if (!active) return
        const fallback = buildOfflineFallbackCatalog(cached?.items, retainedKinds)
        const { cloudDescriptors } = activateCatalogDeviceDescriptors(fallback)
        syncNativeCloudDescriptors(cloudDescriptors, native, true, onNativeSyncedRef.current)
        setItems(fallback)
        setLoading(false)
      })
    return () => {
      active = false
    }
  }, [client, accountReady, native, explicitRetainedKey])

  const modelsByCode = useMemo(() => new Map(items.map(item => [item.code, item])), [items])
  return { items, modelsByCode, loading }
}
