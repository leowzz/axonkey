import * as bundledCatalogModule from '../devices/bundledModelCatalog.json' with { type: 'json' }
import {
  deriveDeviceKindFromId,
  isBuiltinDeviceKind,
  setLocalCustomSupportPackages,
  setRuntimeSupportPackages,
} from '../devices/integration/model.ts'
import { parseRuntimeDescriptorSvg, tryParseRuntimeDescriptorSvg } from '../devices/shared/descriptorSvg.ts'
import type { DeviceSupportPackage } from '../devices/types.ts'
import { normalizeExternalHttpUrl } from '../openExternalUrl.ts'
import type { RelayClient } from './relayClient.ts'
import { RelayError } from './relayClient.ts'

export const deviceModelCatalogEndpoint = '/v2/device-models?app_id=axonkey&include_svg=1'
const catalogCacheKey = 'axonkey.device-model-catalog.cache.v2'
const legacyCatalogCacheKey = 'axonkey.device-model-catalog.cache.v1'

export const deviceModelCatalogCacheTtlMs = 15 * 60 * 1000
export const minDeviceModelCatalogCacheTtlSeconds = 30
export const maxDeviceModelCatalogCacheTtlSeconds = 7 * 86400

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
  has_svg?: boolean
  svg_sha256?: string | null
  svg?: string | null
}

export type CatalogDeviceModel = CloudDeviceModel & {
  brand_id: string | null
  brand_name: string | null
  description: string
  tags: string[]
  links: DeviceModelLink[]
}

export type ParsedDeviceModelCatalogEnvelope = {
  items: CatalogDeviceModel[]
  cacheTtlSeconds: number | null
  ttlMs: number
}

export type CloudDescriptorSvgPayload = {
  kind: string
  svg: string
}

export type LocalCustomDeviceEntry = {
  kind: string
  deviceId: string
  name: string
  model: string
  vendor: string
  svg: string
  filePath: string
}

export type CatalogCacheStorage = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>

type CatalogCacheEntry = {
  expiresAt: number
  cacheTtlSeconds: number | null
  items: CatalogDeviceModel[]
}

export type LoadDeviceModelCatalogOptions = {
  retainedKinds?: Iterable<string>
  activateDescriptors?: boolean
  forceRefresh?: boolean
  syncPackages?: (packages: readonly DeviceSupportPackage[]) => boolean
}

const validModelCodePattern = /^[A-Za-z][A-Za-z0-9_-]{0,63}$/

const memoryCacheByStorage = new WeakMap<CatalogCacheStorage, CatalogCacheEntry>()
let fallbackMemoryCache: CatalogCacheEntry | null = null
const inFlightByClient = new WeakMap<RelayClient, Promise<ParsedDeviceModelCatalogEnvelope>>()
let parsedBundledCatalog: readonly CatalogDeviceModel[] | null = null
const catalogListeners = new Set<() => void>()

export function subscribeDeviceModelCatalog(listener: () => void): () => void {
  catalogListeners.add(listener)
  return () => {
    catalogListeners.delete(listener)
  }
}

function notifyDeviceModelCatalogListeners() {
  for (const listener of catalogListeners) listener()
}

export function getBundledDeviceModelCatalog(): CatalogDeviceModel[] {
  if (!parsedBundledCatalog) {
    const raw =
      'default' in bundledCatalogModule && bundledCatalogModule.default
        ? bundledCatalogModule.default
        : bundledCatalogModule
    parsedBundledCatalog = Object.freeze(parseDeviceModelCatalog(raw))
  }
  return [...parsedBundledCatalog]
}

export function resolveCatalogCacheTtl(rawTtlSeconds: unknown): { cacheTtlSeconds: number | null; ttlMs: number } {
  if (typeof rawTtlSeconds === 'number' && Number.isFinite(rawTtlSeconds)) {
    if (rawTtlSeconds <= 0) {
      return { cacheTtlSeconds: 0, ttlMs: 0 }
    }
    const clamped = Math.min(
      maxDeviceModelCatalogCacheTtlSeconds,
      Math.max(minDeviceModelCatalogCacheTtlSeconds, rawTtlSeconds),
    )
    return { cacheTtlSeconds: clamped, ttlMs: clamped * 1000 }
  }
  return { cacheTtlSeconds: null, ttlMs: deviceModelCatalogCacheTtlMs }
}

export function parseDeviceModelCatalogEnvelope(value: unknown): ParsedDeviceModelCatalogEnvelope {
  const payload = value as { items?: unknown; cache_ttl_seconds?: unknown } | null
  const items = parseDeviceModelCatalog(value)
  const { cacheTtlSeconds, ttlMs } = resolveCatalogCacheTtl(payload?.cache_ttl_seconds)
  return { items, cacheTtlSeconds, ttlMs }
}

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

export async function fetchDeviceModelCatalogEnvelope(client: RelayClient): Promise<ParsedDeviceModelCatalogEnvelope> {
  if (client.session) {
    try {
      return parseDeviceModelCatalogEnvelope(
        await client.request<unknown>('GET', deviceModelCatalogEndpoint, undefined, true),
      )
    } catch (error) {
      if (client.session && !(error instanceof RelayError && error.status === 401)) throw error
    }
  }
  return parseDeviceModelCatalogEnvelope(
    await client.request<unknown>('GET', deviceModelCatalogEndpoint, undefined, false),
  )
}

export async function fetchDeviceModelCatalog(client: RelayClient): Promise<CatalogDeviceModel[]> {
  return (await fetchDeviceModelCatalogEnvelope(client)).items
}

export function readCachedDeviceModelCatalog(
  storage: CatalogCacheStorage | undefined,
  now = Date.now(),
): { items: CatalogDeviceModel[]; fresh: boolean; cacheTtlSeconds: number | null; expiresAt: number } | null {
  const memory = storage ? memoryCacheByStorage.get(storage) : fallbackMemoryCache
  if (memory) {
    return {
      items: memory.items,
      fresh: memory.expiresAt > now,
      cacheTtlSeconds: memory.cacheTtlSeconds,
      expiresAt: memory.expiresAt,
    }
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
    const cacheTtlSeconds =
      typeof parsed.cacheTtlSeconds === 'number' && Number.isFinite(parsed.cacheTtlSeconds)
        ? parsed.cacheTtlSeconds
        : null
    const entry: CatalogCacheEntry = { expiresAt: parsed.expiresAt, cacheTtlSeconds, items }
    memoryCacheByStorage.set(storage, entry)
    return {
      items,
      fresh: entry.expiresAt > now,
      cacheTtlSeconds: entry.cacheTtlSeconds,
      expiresAt: entry.expiresAt,
    }
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
  cacheTtlSeconds?: number | null,
) {
  const resolved = resolveCatalogCacheTtl(cacheTtlSeconds)
  const entry: CatalogCacheEntry = {
    expiresAt: now + resolved.ttlMs,
    cacheTtlSeconds: resolved.cacheTtlSeconds,
    items,
  }
  if (storage) {
    memoryCacheByStorage.set(storage, entry)
    try {
      storage.removeItem(legacyCatalogCacheKey)
    } catch {
      /* Legacy key cleanup is best-effort. */
    }
    try {
      storage.setItem(catalogCacheKey, JSON.stringify(entry))
    } catch {
      // QuotaExceededError fallback: strip SVG bodies on built-in models (which have bundled SVGs)
      // while preserving cloud-only SVGs and keeping the full entry in memoryCacheByStorage.
      try {
        const compact: CatalogCacheEntry = {
          ...entry,
          items: items.map(item => {
            if (!isBuiltinDeviceKind(item.code) || !item.svg) return item
            const { svg: _svg, ...rest } = item
            return rest
          }),
        }
        storage.setItem(catalogCacheKey, JSON.stringify(compact))
      } catch {
        /* Local storage can be full or unavailable; memory cache still serves this session. */
      }
    }
  } else {
    fallbackMemoryCache = entry
  }
  notifyDeviceModelCatalogListeners()
}

export function clearDeviceModelCatalogCache(storage?: CatalogCacheStorage) {
  if (storage) {
    memoryCacheByStorage.delete(storage)
    try {
      storage.removeItem(catalogCacheKey)
      storage.removeItem(legacyCatalogCacheKey)
    } catch {
      /* Ignore storage failure. */
    }
  } else {
    fallbackMemoryCache = null
  }
  notifyDeviceModelCatalogListeners()
}

export function extractCatalogRuntimeDescriptors(items: readonly CatalogDeviceModel[]): {
  packages: DeviceSupportPackage[]
  cloudDescriptors: CloudDescriptorSvgPayload[]
} {
  const packages: DeviceSupportPackage[] = []
  const cloudDescriptors: CloudDescriptorSvgPayload[] = []
  const seenKinds = new Set<string>()
  for (const item of items) {
    const kind = item.code.trim()
    if (!kind || kind === 'mouse' || !validModelCodePattern.test(kind) || seenKinds.has(kind)) continue
    if (typeof item.svg !== 'string' || !item.svg.trim()) continue
    const parsed = tryParseRuntimeDescriptorSvg(item.svg, {
      kind,
      name: item.name,
      model: item.model,
    })
    if (!parsed) continue
    seenKinds.add(kind)
    packages.push(parsed.supportPackage)
    cloudDescriptors.push({ kind, svg: item.svg.trim() })
  }
  return { packages, cloudDescriptors }
}

export function activateCatalogDeviceDescriptors(
  items: readonly CatalogDeviceModel[],
  syncPackages: (packages: readonly DeviceSupportPackage[]) => boolean = setRuntimeSupportPackages,
) {
  const { packages, cloudDescriptors } = extractCatalogRuntimeDescriptors(items)
  const changed = syncPackages(packages)
  return { packages, cloudDescriptors, changed }
}

export function buildOfflineFallbackCatalog(
  expiredItems?: readonly CatalogDeviceModel[] | null,
  retainedKinds?: Iterable<string>,
): CatalogDeviceModel[] {
  const bundled = getBundledDeviceModelCatalog()
  if (!expiredItems?.length || !retainedKinds) return bundled
  const retainedSet = new Set<string>()
  for (const kind of retainedKinds) {
    const trimmed = kind.trim()
    if (trimmed && trimmed !== 'mouse' && !isBuiltinDeviceKind(trimmed)) {
      retainedSet.add(trimmed)
    }
  }
  if (retainedSet.size === 0) return bundled
  const existingCodes = new Set(bundled.map(item => item.code))
  for (const item of expiredItems) {
    if (!retainedSet.has(item.code) || existingCodes.has(item.code)) continue
    if (typeof item.svg === 'string' && tryParseRuntimeDescriptorSvg(item.svg, { kind: item.code })) {
      existingCodes.add(item.code)
      bundled.push(item)
    }
  }
  return bundled
}

export async function loadDeviceModelCatalog(
  client: RelayClient,
  storage: CatalogCacheStorage | undefined,
  now?: number,
  options: LoadDeviceModelCatalogOptions = {},
): Promise<CatalogDeviceModel[]> {
  const shouldActivate = options.activateDescriptors !== false
  const syncPackages = options.syncPackages ?? setRuntimeSupportPackages
  const cached = readCachedDeviceModelCatalog(storage, now ?? Date.now())
  if (!options.forceRefresh && cached?.fresh) {
    if (shouldActivate) activateCatalogDeviceDescriptors(cached.items, syncPackages)
    return cached.items
  }
  let pending = inFlightByClient.get(client)
  if (!pending) {
    pending = fetchDeviceModelCatalogEnvelope(client).finally(() => {
      inFlightByClient.delete(client)
    })
    inFlightByClient.set(client, pending)
  }
  try {
    const envelope = await pending
    writeCachedDeviceModelCatalog(envelope.items, storage, now ?? Date.now(), envelope.cacheTtlSeconds)
    if (shouldActivate) activateCatalogDeviceDescriptors(envelope.items, syncPackages)
    return envelope.items
  } catch {
    const fallback = cached?.fresh ? cached.items : buildOfflineFallbackCatalog(cached?.items, options.retainedKinds)
    if (shouldActivate) activateCatalogDeviceDescriptors(fallback, syncPackages)
    return fallback
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
  const extra: Partial<Pick<CatalogDeviceModel, 'has_svg' | 'svg_sha256' | 'svg'>> = {}
  if (typeof candidate.has_svg === 'boolean') {
    extra.has_svg = candidate.has_svg
  }
  if (candidate.svg_sha256 === null) {
    extra.svg_sha256 = null
  } else if (typeof candidate.svg_sha256 === 'string' && /^[0-9a-f]{64}$/i.test(candidate.svg_sha256.trim())) {
    extra.svg_sha256 = candidate.svg_sha256.trim().toLowerCase()
  }
  if (candidate.svg === null) {
    extra.svg = null
  } else if (typeof candidate.svg === 'string' && candidate.svg.trim()) {
    extra.svg = candidate.svg
  }
  return { id, code, name, model, brand_id, brand_name, description, tags, links, ...extra }
}

const previewLocalDevicesKey = 'axonkey.local-custom-devices.v1'
let currentLocalEntries: readonly LocalCustomDeviceEntry[] = Object.freeze([])
let initializedPreviewLocalEntries = false
const localCustomListeners = new Set<() => void>()

export function subscribeLocalCustomDevices(listener: () => void): () => void {
  localCustomListeners.add(listener)
  return () => {
    localCustomListeners.delete(listener)
  }
}

export function getLocalCustomDevices(): readonly LocalCustomDeviceEntry[] {
  return currentLocalEntries
}

export function applyLocalCustomDevices(entries: readonly LocalCustomDeviceEntry[]): boolean {
  const packages: DeviceSupportPackage[] = []
  const validEntries: LocalCustomDeviceEntry[] = []
  const seenKinds = new Set<string>()

  for (const entry of entries) {
    const kind = entry.kind?.trim()
    if (!kind || seenKinds.has(kind)) continue
    const parsed = tryParseRuntimeDescriptorSvg(entry.svg, {
      kind,
      name: entry.name,
      model: entry.model,
    })
    if (!parsed) continue
    seenKinds.add(kind)
    validEntries.push(entry)
    packages.push(parsed.supportPackage)
  }

  const sameList =
    validEntries.length === currentLocalEntries.length &&
    validEntries.every((item, index) => {
      const prev = currentLocalEntries[index]
      return (
        prev.kind === item.kind &&
        prev.name === item.name &&
        prev.model === item.model &&
        prev.vendor === item.vendor &&
        prev.filePath === item.filePath &&
        prev.svg === item.svg
      )
    })

  setLocalCustomSupportPackages(packages)
  if (sameList) return false
  currentLocalEntries = Object.freeze(validEntries)
  for (const listener of localCustomListeners) listener()
  return true
}

export function hydratePreviewLocalCustomDevices(storage?: CatalogCacheStorage): LocalCustomDeviceEntry[] {
  if (initializedPreviewLocalEntries) return [...currentLocalEntries]
  initializedPreviewLocalEntries = true
  if (!storage) return [...currentLocalEntries]
  try {
    const raw = storage.getItem(previewLocalDevicesKey)
    if (!raw) return [...currentLocalEntries]
    const parsed = JSON.parse(raw)
    if (!Array.isArray(parsed)) return [...currentLocalEntries]
    const valid = parsed.filter((item): item is LocalCustomDeviceEntry =>
      Boolean(
        item &&
        typeof item === 'object' &&
        typeof item.kind === 'string' &&
        typeof item.deviceId === 'string' &&
        typeof item.name === 'string' &&
        typeof item.model === 'string' &&
        typeof item.vendor === 'string' &&
        typeof item.svg === 'string' &&
        typeof item.filePath === 'string',
      ),
    )
    if (valid.length > 0) applyLocalCustomDevices(valid)
  } catch {
    /* Preview storage is best-effort. */
  }
  return [...currentLocalEntries]
}

export function upsertLocalCustomDevice(
  entry: LocalCustomDeviceEntry,
  persistPreviewStorage?: CatalogCacheStorage,
): LocalCustomDeviceEntry {
  const merged = [...currentLocalEntries.filter(item => item.kind !== entry.kind), entry]
  if (persistPreviewStorage) {
    try {
      persistPreviewStorage.setItem(previewLocalDevicesKey, JSON.stringify(merged))
    } catch {
      /* Preview storage is best-effort. */
    }
  }
  applyLocalCustomDevices(merged)
  return entry
}

export function buildPreviewLocalCustomDeviceEntry(svgContent: string): LocalCustomDeviceEntry {
  const trimmed = svgContent.trim()
  const deviceTag = trimmed.match(/<(?:ak:)?device\b[^>]*>/i)?.[0] ?? ''
  const readAttr = (attrName: string) => {
    const m = deviceTag.match(new RegExp(`\\b${attrName}\\s*=\\s*["']([^"']*)["']`, 'i'))
    return m?.[1]?.trim() ?? ''
  }
  const deviceId = readAttr('id') || 'custom-device'
  const vendor = readAttr('vendor') || 'Unknown'
  const model = readAttr('model') || deviceId
  const displayName =
    readAttr('display-name') ||
    (vendor && vendor !== 'Unknown' && !model.startsWith(vendor) ? `${vendor} ${model}` : model)
  const kind = deriveDeviceKindFromId(deviceId)
  if (!kind) {
    throw new Error(`无法从设备 ID「${deviceId}」推导合法型号标识`)
  }
  parseRuntimeDescriptorSvg(trimmed, { kind, name: displayName, model })
  const safeStem = deviceId.replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^[.-]+|[.-]+$/g, '') || 'custom-device'
  return {
    kind,
    deviceId,
    name: displayName,
    model,
    vendor,
    svg: trimmed,
    filePath: `custom-devices/${safeStem}.svg`,
  }
}

export function localCustomDeviceToCatalogModel(entry: LocalCustomDeviceEntry): CatalogDeviceModel {
  const parsed = tryParseRuntimeDescriptorSvg(entry.svg, {
    kind: entry.kind,
    name: entry.name,
    model: entry.model,
  })
  const inputCount = parsed?.supportPackage.inputs.length ?? 0
  const hasVoice = Boolean(parsed?.supportPackage.remoteView?.voice)
  const tags: string[] = ['本机测试']
  if (inputCount > 0) tags.push(`${inputCount} 键`)
  if (parsed?.supportPackage.remoteView?.usesVendorUsbHid) {
    tags.push('USB-C 免驱')
  } else if (/transport\s*=\s*["']usb-hid["']/i.test(entry.svg)) {
    tags.push('USB HID')
  } else if (/transport\s*=\s*["']bluetooth/i.test(entry.svg)) {
    tags.push('蓝牙 HID')
  }
  if (!hasVoice) tags.push('仅按键映射')

  const brandName = entry.vendor && entry.vendor !== 'Unknown' ? entry.vendor : '本机适配'
  return {
    id: `local:${entry.kind}`,
    code: entry.kind,
    name: entry.name,
    model: entry.model,
    brand_id: null,
    brand_name: brandName,
    description: `已放入本机可用目录进行实机联调测试。\n\n- 文件路径：\`${entry.filePath}\``,
    tags,
    links: [],
    has_svg: true,
    svg: entry.svg,
  }
}

export function mergeCatalogWithLocalCustomDevices(
  catalogItems: readonly CatalogDeviceModel[],
  localDevices: readonly LocalCustomDeviceEntry[],
): CatalogDeviceModel[] {
  if (localDevices.length === 0) return [...catalogItems]
  const localModels = localDevices.map(localCustomDeviceToCatalogModel)
  const localByCode = new Map(localModels.map(item => [item.code, item]))
  const merged: CatalogDeviceModel[] = catalogItems.map(item => localByCode.get(item.code) ?? item)
  const existingCodes = new Set(catalogItems.map(item => item.code))
  for (const localItem of localModels) {
    if (!existingCodes.has(localItem.code)) {
      merged.unshift(localItem)
    }
  }
  return merged
}

export function resetLocalCustomDevicesForTest() {
  currentLocalEntries = Object.freeze([])
  initializedPreviewLocalEntries = false
  setLocalCustomSupportPackages([])
  for (const listener of localCustomListeners) listener()
}
