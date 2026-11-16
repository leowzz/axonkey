import { normalizeExternalHttpUrl } from '../openExternalUrl.ts'
import type { RelayClient } from './relayClient.ts'
import { RelayError } from './relayClient.ts'

const endpoint = '/v2/device-models?app_id=axonkey'
const catalogCacheKey = 'axonkey.device-model-catalog.cache.v1'

export const deviceModelCatalogCacheTtlMs = 15 * 60 * 1000

export type DeviceModelLink = { label: string; url: string }

export type CloudDeviceModel = {
  id: string
  code: string
  name: string
  model: string
  brand_id?: string | null
  brand_name?: string | null
  description?: string
  tags?: string[]
  links?: DeviceModelLink[]
}

export type CatalogDeviceModel = CloudDeviceModel & {
  brand_id: string | null
  brand_name: string | null
  description: string
  tags: string[]
  links: DeviceModelLink[]
}

export type CatalogCacheStorage = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>

type CatalogCacheEntry = {
  expiresAt: number
  items: CatalogDeviceModel[]
}

const memoryCacheByStorage = new WeakMap<CatalogCacheStorage, CatalogCacheEntry>()
let fallbackMemoryCache: CatalogCacheEntry | null = null
const inFlightByClient = new WeakMap<RelayClient, Promise<CatalogDeviceModel[]>>()

export function parseDeviceModelCatalog(value: unknown): CatalogDeviceModel[] {
  const payload = value as { items?: unknown } | null
  if (!payload || typeof payload !== 'object' || !Array.isArray(payload.items)) {
    throw new Error('设备型号目录响应无法读取')
  }
  const items: CatalogDeviceModel[] = []
  for (const raw of payload.items) {
    const normalized = normalizeCatalogItem(raw)
    if (normalized) items.push(normalized)
  }
  return items
}

export async function fetchDeviceModelCatalog(client: RelayClient): Promise<CatalogDeviceModel[]> {
  if (client.session) {
    try {
      return parseDeviceModelCatalog(await client.request<unknown>('GET', endpoint, undefined, true))
    } catch (error) {
      if (client.session && !(error instanceof RelayError && error.status === 401)) throw error
    }
  }
  return parseDeviceModelCatalog(await client.request<unknown>('GET', endpoint, undefined, false))
}

export function readCachedDeviceModelCatalog(
  storage: CatalogCacheStorage | undefined,
  now = Date.now(),
): { items: CatalogDeviceModel[]; fresh: boolean } | null {
  const memory = storage ? memoryCacheByStorage.get(storage) : fallbackMemoryCache
  if (memory) {
    return { items: memory.items, fresh: memory.expiresAt > now }
  }
  if (!storage) return null
  try {
    const raw = storage.getItem(catalogCacheKey)
    if (!raw) return null
    const parsed = JSON.parse(raw) as Partial<CatalogCacheEntry>
    if (typeof parsed.expiresAt !== 'number' || !Number.isFinite(parsed.expiresAt) || !Array.isArray(parsed.items)) {
      storage.removeItem(catalogCacheKey)
      return null
    }
    const items = parseDeviceModelCatalog({ items: parsed.items })
    const entry: CatalogCacheEntry = { expiresAt: parsed.expiresAt, items }
    memoryCacheByStorage.set(storage, entry)
    return { items, fresh: entry.expiresAt > now }
  } catch {
    try {
      storage.removeItem(catalogCacheKey)
    } catch {
      /* Storage cleanup is best-effort. */
    }
    return null
  }
}

export function writeCachedDeviceModelCatalog(
  items: CatalogDeviceModel[],
  storage: CatalogCacheStorage | undefined,
  now = Date.now(),
) {
  const entry: CatalogCacheEntry = { expiresAt: now + deviceModelCatalogCacheTtlMs, items }
  if (storage) {
    memoryCacheByStorage.set(storage, entry)
    try {
      storage.setItem(catalogCacheKey, JSON.stringify(entry))
    } catch {
      /* Local storage can be full or unavailable; memory cache still serves this session. */
    }
  } else {
    fallbackMemoryCache = entry
  }
}

export function clearDeviceModelCatalogCache(storage?: CatalogCacheStorage) {
  if (storage) {
    memoryCacheByStorage.delete(storage)
    try {
      storage.removeItem(catalogCacheKey)
    } catch {
      /* Ignore storage failure. */
    }
  } else {
    fallbackMemoryCache = null
  }
}

export async function loadDeviceModelCatalog(
  client: RelayClient,
  storage: CatalogCacheStorage | undefined,
  now = Date.now(),
): Promise<CatalogDeviceModel[]> {
  const cached = readCachedDeviceModelCatalog(storage, now)
  if (cached?.fresh) return cached.items
  let pending = inFlightByClient.get(client)
  if (!pending) {
    pending = fetchDeviceModelCatalog(client).finally(() => {
      inFlightByClient.delete(client)
    })
    inFlightByClient.set(client, pending)
  }
  try {
    const items = await pending
    writeCachedDeviceModelCatalog(items, storage, Date.now())
    return items
  } catch (error) {
    if (cached) return cached.items
    throw error
  }
}

function normalizeCatalogItem(raw: unknown): CatalogDeviceModel | null {
  if (!raw || typeof raw !== 'object') return null
  const candidate = raw as Record<string, unknown>
  const id = typeof candidate.id === 'string' ? candidate.id.trim() : ''
  const code = typeof candidate.code === 'string' ? candidate.code.trim() : ''
  if (!id || !code) return null
  const name = typeof candidate.name === 'string' ? candidate.name.trim() : ''
  const model = typeof candidate.model === 'string' ? candidate.model.trim() : ''
  const brand_id =
    typeof candidate.brand_id === 'string' && candidate.brand_id.trim() ? candidate.brand_id.trim() : null
  const brand_name =
    typeof candidate.brand_name === 'string' && candidate.brand_name.trim() ? candidate.brand_name.trim() : null
  const description =
    typeof candidate.description === 'string' ? candidate.description.replace(/\r\n/g, '\n').trim() : ''
  const tags: string[] = []
  if (Array.isArray(candidate.tags)) {
    const seen = new Set<string>()
    for (const entry of candidate.tags) {
      if (typeof entry !== 'string') continue
      const tag = entry.trim()
      if (!tag || tag.length > 64 || seen.has(tag)) continue
      seen.add(tag)
      tags.push(tag)
      if (tags.length >= 32) break
    }
  }
  const links: DeviceModelLink[] = []
  if (Array.isArray(candidate.links)) {
    for (const entry of candidate.links) {
      if (!entry || typeof entry !== 'object') continue
      const link = entry as Record<string, unknown>
      const label = typeof link.label === 'string' ? link.label.trim() : ''
      const url = normalizeExternalHttpUrl(link.url)
      if (!label || label.length > 120 || !url) continue
      links.push({ label, url })
      if (links.length >= 20) break
    }
  }
  return { id, code, name, model, brand_id, brand_name, description, tags, links }
}
