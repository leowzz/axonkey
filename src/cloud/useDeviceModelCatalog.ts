import { useEffect, useMemo, useState } from 'react'
import { loadDeviceModelCatalog, readCachedDeviceModelCatalog, type CatalogDeviceModel } from './deviceModelCatalog.ts'
import type { RelayClient } from './relayClient.ts'

function localStorageOrUndefined() {
  try {
    return typeof window === 'undefined' ? undefined : window.localStorage
  } catch {
    return undefined
  }
}

export function useDeviceModelCatalog(client: RelayClient | undefined, accountReady = true) {
  const initialCached = readCachedDeviceModelCatalog(localStorageOrUndefined())
  const [items, setItems] = useState<CatalogDeviceModel[]>(() => initialCached?.items ?? [])
  const [loading, setLoading] = useState<boolean>(() => Boolean(client && !initialCached))

  useEffect(() => {
    if (!client) {
      setLoading(false)
      return
    }
    const storage = localStorageOrUndefined()
    const cached = readCachedDeviceModelCatalog(storage)
    if (cached) {
      setItems(cached.items)
      if (cached.fresh) {
        setLoading(false)
        return
      }
    }
    if (!accountReady) {
      setLoading(!cached)
      return
    }
    let active = true
    setLoading(!cached)
    void loadDeviceModelCatalog(client, storage)
      .then(loaded => {
        if (!active) return
        setItems(loaded)
        setLoading(false)
      })
      .catch(() => {
        if (active) setLoading(false)
      })
    return () => {
      active = false
    }
  }, [client, accountReady])

  const modelsByCode = useMemo(() => new Map(items.map(item => [item.code, item])), [items])
  return { items, modelsByCode, loading }
}
