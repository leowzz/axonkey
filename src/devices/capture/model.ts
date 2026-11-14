import { invoke } from '@tauri-apps/api/core'
import { listen } from '@tauri-apps/api/event'

export const CAPTURE_EVENT_NAME = 'axonkey-device-capture'

export type CaptureSafetyTier = 'safe' | 'caution' | 'blocked'

export type CaptureTransport = 'bluetooth-le' | 'bluetooth-hid' | 'usb-hid' | 'hid'

export type CaptureGattInfo = {
  manufacturer: string | null
  modelNumber: string | null
  softwareRevision: string | null
  bluetoothAddress: string | null
}

export type CaptureCandidate = {
  targetId: string
  displayName: string
  transport: CaptureTransport | string
  instanceId: string
  vid: number | null
  pid: number | null
  usagePage: number | null
  usage: number | null
  boundToQuarbor: boolean
  recoveryActive: boolean
  registeredKind: string | null
  safetyTier: CaptureSafetyTier
  safetyReason: string | null
  gattInfo: CaptureGattInfo | null
}

export type CaptureDriverActionResult = {
  ok: boolean
  instanceId: string
  boundToQuarbor: boolean
  rebootRequired: boolean
  cancelledByUser: boolean
  installationState: string | null
  message: string | null
}

export type CaptureDraftInputItem = {
  id: string
  label: string
  icon: string | null
  binding: string
  pressHex: string | null
  releaseHex: string | null
}

export type ParsedCaptureDraft = {
  deviceId: string
  displayName: string
  vendor: string | null
  model: string | null
  status: string
  inputs: CaptureDraftInputItem[]
}

export type CaptureSessionStatus = {
  active: boolean
  targetId: string | null
  instanceId: string | null
  transportMode: string
  driverVersion: string | null
  supportsKeysend: boolean
  supportsResetInput: boolean
  frameCount: number
  streamingReportIds: number[]
}

export type CapturedKeySample = {
  inputId: string
  reportId: number
  pressHex: string
  releaseHex: string
  pressLength: number
  releaseLength: number
  holdCount: number
  durationMs: number
}

export type CaptureCollisionWarning = {
  firstInputId: string
  secondInputId: string
  reportId: number
  pressHex: string
}

export type CompiledCaptureResult = {
  svgContent: string
  markdownSummary: string
  adaptedCount: number
  pendingCount: number
  collisions: CaptureCollisionWarning[]
  validated: boolean
}

export type CaptureEventPayload =
  | {
      kind: 'status'
      connected: boolean
      frameCount: number
      streamingReportIds: number[]
      message: string | null
    }
  | {
      kind: 'rawFrame'
      sequence: number
      reportId: number
      hex: string
      isStreamingNoise: boolean
    }
  | {
      kind: 'keyCaptured'
      sample: CapturedKeySample
    }
  | {
      kind: 'liveHit'
      inputId: string
      pressed: boolean
      reportId: number
      hex: string
    }

export type CaptureSvgHotzone = {
  id: string
  label: string
  path: string
  transform?: string
  anchor?: { x: number; y: number }
}

export type SanitizedCaptureSvg = {
  svgContent: string
  artworkDataUrl: string
  viewBox: { x: number; y: number; width: number; height: number }
  hotzones: CaptureSvgHotzone[]
}

export type DiscoveredProbeButton = {
  key: string
  label: string
  reportId: number
  pressHex: string
  releaseHex: string
  pressLength: number
  releaseLength: number
  hitCount: number
  lastSequence: number
}

export function isTauriCaptureRuntime(nativeOverride?: boolean): boolean {
  if (nativeOverride !== undefined) return nativeOverride
  return typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window
}

export async function captureListCandidates(options?: {
  includeGatt?: boolean
  native?: boolean
}): Promise<CaptureCandidate[]> {
  if (!isTauriCaptureRuntime(options?.native)) return []
  return invoke<CaptureCandidate[]>('capture_list_candidates', {
    includeGatt: options?.includeGatt ?? false,
  })
}

export async function captureAttachDriver(
  instanceId: string,
  allowCaution = false,
  native?: boolean,
): Promise<CaptureDriverActionResult> {
  if (!isTauriCaptureRuntime(native)) {
    throw new Error('驱动挂载需在桌面应用中运行')
  }
  return invoke<CaptureDriverActionResult>('capture_attach_driver', {
    instanceId,
    allowCaution,
  })
}

export async function captureDetachDriver(instanceId: string, native?: boolean): Promise<CaptureDriverActionResult> {
  if (!isTauriCaptureRuntime(native)) {
    throw new Error('驱动恢复需在桌面应用中运行')
  }
  return invoke<CaptureDriverActionResult>('capture_detach_driver', { instanceId })
}

export async function captureParseDraftSvg(svgContent: string, native?: boolean): Promise<ParsedCaptureDraft> {
  sanitizeAndExtractSvgStage(svgContent)
  if (isTauriCaptureRuntime(native)) {
    return invoke<ParsedCaptureDraft>('capture_parse_draft_svg', { svgContent })
  }
  return parseCaptureDraftSvgLocal(svgContent)
}

export async function captureStartSession(
  params: {
    targetId: string
    instanceId: string
    passthroughStandardKeys?: boolean
  },
  native?: boolean,
): Promise<CaptureSessionStatus> {
  if (!isTauriCaptureRuntime(native)) {
    throw new Error('实机采集会话需在桌面应用中运行')
  }
  return invoke<CaptureSessionStatus>('capture_start_session', {
    targetId: params.targetId,
    instanceId: params.instanceId,
    passthroughStandardKeys: params.passthroughStandardKeys ?? false,
  })
}

export async function captureStopSession(native?: boolean): Promise<boolean> {
  if (!isTauriCaptureRuntime(native)) return false
  return invoke<boolean>('capture_stop_session')
}

export async function captureArmKey(inputId: string | null, native?: boolean): Promise<boolean> {
  if (!isTauriCaptureRuntime(native)) return true
  return invoke<boolean>('capture_arm_key', { inputId })
}

export async function captureSetLivePreviewSvg(svgContent: string | null, native?: boolean): Promise<boolean> {
  if (!isTauriCaptureRuntime(native)) return false
  return invoke<boolean>('capture_set_live_preview_svg', { svgContent })
}

export async function captureCompileSvg(
  params: {
    draftSvg: string
    candidate: CaptureCandidate | null
    samples: CapturedKeySample[]
    targetStatus?: 'active' | 'draft'
  },
  native?: boolean,
): Promise<CompiledCaptureResult> {
  if (isTauriCaptureRuntime(native)) {
    return invoke<CompiledCaptureResult>('capture_compile_svg', {
      draftSvg: params.draftSvg,
      candidate: params.candidate,
      samples: params.samples,
      targetStatus: params.targetStatus ?? null,
    })
  }
  return compileCaptureSvgLocal(params.draftSvg, params.candidate, params.samples, params.targetStatus)
}

export async function captureSaveExport(
  params: {
    svgPath: string
    svgContent: string
    markdownPath?: string | null
    markdownContent?: string | null
  },
  native?: boolean,
): Promise<boolean> {
  if (!isTauriCaptureRuntime(native)) {
    throw new Error('本地路径写入需在桌面应用中运行')
  }
  return invoke<boolean>('capture_save_export', {
    svgPath: params.svgPath,
    svgContent: params.svgContent,
    markdownPath: params.markdownPath ?? null,
    markdownContent: params.markdownContent ?? null,
  })
}

export async function listenCaptureEvents(
  handler: (payload: CaptureEventPayload) => void,
  native?: boolean,
): Promise<() => void> {
  if (!isTauriCaptureRuntime(native)) return () => {}
  return listen<CaptureEventPayload>(CAPTURE_EVENT_NAME, event => {
    handler(event.payload)
  })
}

export function sanitizeAndExtractSvgStage(rawSvg: string): SanitizedCaptureSvg {
  const svgContent = rawSvg.trim()
  if (!svgContent) throw new Error('SVG 内容为空')
  if (/<!\s*(DOCTYPE|ENTITY)\b/i.test(svgContent)) {
    throw new Error('不支持包含 DOCTYPE 或实体声明的 SVG')
  }
  const rootMatch = svgContent.match(/<svg\b[^>]*>/i)
  if (!rootMatch || !/<\/svg>\s*$/i.test(svgContent)) {
    throw new Error('无效的 SVG 根元素')
  }
  assertSafeSvgMarkup(svgContent)

  const rootAttrs = parseXmlAttributes(rootMatch[0])
  const viewBox = parseSvgViewBox(rootAttrs)
  const labelsById = extractInputLabels(svgContent)
  const hotzones = extractSvgHotzones(svgContent, labelsById)

  return {
    svgContent,
    artworkDataUrl: `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svgContent)}`,
    viewBox,
    hotzones,
  }
}

export function parseCaptureDraftSvgLocal(rawSvg: string): ParsedCaptureDraft {
  const { svgContent, hotzones } = sanitizeAndExtractSvgStage(rawSvg)
  const rootAttrs = parseXmlAttributes(svgContent.match(/<svg\b[^>]*>/i)?.[0] ?? '')
  const deviceAttrs = parseXmlAttributes(svgContent.match(/<ak:device\b[^>]*>/i)?.[0] ?? '')

  const deviceId = deviceAttrs.id || rootAttrs['data-ak-device'] || 'custom-device'
  const displayName =
    deviceAttrs['display-name'] || deviceAttrs.model || extractTextTag(svgContent, 'title') || deviceId
  const status = deviceAttrs.status || rootAttrs['data-ak-status'] || 'draft'

  const inputMatches = [...svgContent.matchAll(/<ak:input\b[^>]*\/>|<ak:input\b[^>]*>[\s\S]*?<\/ak:input>/gi)]
  const inputs: Array<CaptureDraftInputItem & { order: number }> = []
  const seen = new Set<string>()

  inputMatches.forEach((match, index) => {
    const block = match[0]
    const openTag = block.match(/^<ak:input\b[^>]*>/i)?.[0] ?? ''
    const attrs = parseXmlAttributes(openTag)
    const id = attrs.id?.trim()
    if (!id || seen.has(id)) return
    seen.add(id)

    const captureTag = block.match(/<ak:hid-capture\b[^>]*>/i)?.[0]
    const captureAttrs = captureTag ? parseXmlAttributes(captureTag) : {}
    const pressNorm = normalizeHexBytes(captureAttrs.press ?? '')
    const releaseNorm = normalizeHexBytes(captureAttrs.release ?? '')
    const hasSource = /<ak:source\b/i.test(block) || Boolean(attrs.report)
    const binding = attrs.binding || (pressNorm || hasSource ? 'captured' : 'pending')

    inputs.push({
      id,
      label: attrs.label || attrs.short || id,
      icon: attrs.icon ?? null,
      binding,
      pressHex: pressNorm?.hex ?? null,
      releaseHex: releaseNorm?.hex ?? null,
      order: Number.isFinite(Number(attrs.order)) ? Number(attrs.order) : index,
    })
  })

  if (inputs.length === 0 && hotzones.length > 0) {
    hotzones.forEach((zone, index) => {
      inputs.push({
        id: zone.id,
        label: zone.label,
        icon: 'center',
        binding: 'pending',
        pressHex: null,
        releaseHex: null,
        order: index,
      })
    })
  }

  inputs.sort((a, b) => a.order - b.order)

  return {
    deviceId,
    displayName,
    vendor: deviceAttrs.vendor ?? null,
    model: deviceAttrs.model ?? null,
    status,
    inputs: inputs.map(({ order: _order, ...item }) => item),
  }
}

export function compileCaptureSvgLocal(
  draftSvg: string,
  candidate: CaptureCandidate | null,
  samples: CapturedKeySample[],
  targetStatus?: 'active' | 'draft',
): CompiledCaptureResult {
  const draft = parseCaptureDraftSvgLocal(draftSvg)
  const sampleMap = new Map(samples.map(sample => [sample.inputId, sample]))
  const collisions = detectSampleCollisions(sampleMap.values())
  const adaptedCount = draft.inputs.filter(input => sampleMap.has(input.id)).length
  const pendingCount = Math.max(0, draft.inputs.length - adaptedCount)
  const resolvedStatus = targetStatus ?? (pendingCount === 0 && adaptedCount > 0 ? 'active' : 'draft')

  let updatedSvg = draftSvg
  updatedSvg = replaceRootOrDeviceStatus(updatedSvg, resolvedStatus)
  updatedSvg = injectCapturedInputsXml(updatedSvg, sampleMap)
  if (candidate) {
    updatedSvg = injectIdentityIfMissing(updatedSvg, candidate)
  }

  const summaryLines = [
    `# ${draft.displayName} (${draft.deviceId}) 采集记录`,
    '',
    `- 状态：${resolvedStatus}`,
    `- 已适配按键：${adaptedCount} / ${draft.inputs.length}`,
    candidate
      ? `- 采集设备：${candidate.displayName} (${formatVidPid(candidate.vid, candidate.pid)} · ${candidate.instanceId})`
      : '- 采集设备：离线/预览图稿整理',
    '',
    '## 按键报文清单',
    '',
    '| 按键 | 输入 ID | Report ID | 按下报文 | 抬起报文 |',
    '| --- | --- | --- | --- | --- |',
    ...draft.inputs.map(item => {
      const sample = sampleMap.get(item.id)
      if (!sample) {
        return `| ${item.label} | \`${item.id}\` | — | 待采集 | — |`
      }
      return `| ${item.label} | \`${item.id}\` | \`${formatReportIdHex(sample.reportId)}\` | \`${sample.pressHex}\` | \`${sample.releaseHex || '—'}\` |`
    }),
  ]

  if (collisions.length > 0) {
    summaryLines.push('', '## 冲突提示', '')
    for (const collision of collisions) {
      summaryLines.push(
        `- \`${collision.firstInputId}\` 与 \`${collision.secondInputId}\` 在报告 \`${formatReportIdHex(collision.reportId)}\` 上共享相同按下报文 \`${collision.pressHex}\``,
      )
    }
  }

  return {
    svgContent: updatedSvg,
    markdownSummary: summaryLines.join('\n') + '\n',
    adaptedCount,
    pendingCount,
    collisions,
    validated: collisions.length === 0,
  }
}

export function seedSamplesFromDraft(draft: ParsedCaptureDraft): Map<string, CapturedKeySample> {
  const map = new Map<string, CapturedKeySample>()
  for (const input of draft.inputs) {
    if (!input.pressHex) continue
    const press = normalizeHexBytes(input.pressHex)
    if (!press || press.bytes.length === 0) continue
    const release = normalizeHexBytes(input.releaseHex ?? '')
    map.set(input.id, {
      inputId: input.id,
      reportId: press.bytes[0],
      pressHex: press.hex,
      releaseHex: release?.hex ?? '',
      pressLength: press.bytes.length,
      releaseLength: release?.bytes.length ?? 0,
      holdCount: 1,
      durationMs: 0,
    })
  }
  return map
}

export function detectSampleCollisions(samples: Iterable<CapturedKeySample>): CaptureCollisionWarning[] {
  const bySignature = new Map<string, CapturedKeySample>()
  const warnings: CaptureCollisionWarning[] = []
  for (const sample of samples) {
    const norm = normalizeHexBytes(sample.pressHex)
    const canonicalHex = norm?.hex ?? sample.pressHex.trim().toUpperCase()
    if (!canonicalHex) continue
    const key = `${sample.reportId}:${canonicalHex}`
    const existing = bySignature.get(key)
    if (existing && existing.inputId !== sample.inputId) {
      warnings.push({
        firstInputId: existing.inputId,
        secondInputId: sample.inputId,
        reportId: sample.reportId,
        pressHex: canonicalHex,
      })
    } else {
      bySignature.set(key, sample)
    }
  }
  return warnings
}

export function nextPendingInputId(
  inputs: readonly CaptureDraftInputItem[],
  samples: ReadonlyMap<string, CapturedKeySample>,
  afterInputId?: string | null,
  skippedIds?: ReadonlySet<string>,
): string | null {
  if (inputs.length === 0) return null
  const startIndex = afterInputId ? Math.max(0, inputs.findIndex(item => item.id === afterInputId) + 1) : 0

  for (let offset = 0; offset < inputs.length; offset++) {
    const candidate = inputs[(startIndex + offset) % inputs.length]
    if (!samples.has(candidate.id) && !skippedIds?.has(candidate.id)) {
      return candidate.id
    }
  }
  for (let offset = 0; offset < inputs.length; offset++) {
    const candidate = inputs[(startIndex + offset) % inputs.length]
    if (!samples.has(candidate.id)) {
      return candidate.id
    }
  }
  return null
}

export function findUnregisteredBoundCandidates(candidates: readonly CaptureCandidate[]): CaptureCandidate[] {
  return candidates.filter(item => item.boundToQuarbor && !item.registeredKind)
}

export function normalizeHexBytes(value: string): { bytes: number[]; hex: string } | null {
  const trimmed = value.trim()
  if (!trimmed) return null
  const tokens = /^(?:[0-9a-f]{2})+$/i.test(trimmed) ? (trimmed.match(/../g) ?? []) : trimmed.split(/[\s,]+/)
  if (tokens.length === 0 || !tokens.every(token => /^(?:0x)?[0-9a-f]{2}$/i.test(token))) {
    return null
  }
  const bytes = tokens.map(token => Number.parseInt(token.replace(/^0x/i, ''), 16))
  return {
    bytes,
    hex: bytes.map(byte => byte.toString(16).padStart(2, '0').toUpperCase()).join(' '),
  }
}

export function formatHexShort(hex: string | null | undefined, maxBytes = 6): string {
  if (!hex) return ''
  const norm = normalizeHexBytes(hex)
  if (!norm) return hex
  if (norm.bytes.length <= maxBytes) return norm.hex
  return (
    norm.bytes
      .slice(0, maxBytes)
      .map(byte => byte.toString(16).padStart(2, '0').toUpperCase())
      .join(' ') + '…'
  )
}

export function formatVidPid(vid: number | null, pid: number | null): string {
  if (vid === null || pid === null) return 'VID:PID 未知'
  const v = vid.toString(16).padStart(4, '0').toUpperCase()
  const p = pid.toString(16).padStart(4, '0').toUpperCase()
  return `${v}:${p}`
}

export function formatReportIdHex(reportId: number): string {
  return `0x${(reportId & 0xff).toString(16).padStart(2, '0').toUpperCase()}`
}

export function transportLabel(transport: string): string {
  switch (transport) {
    case 'bluetooth-le':
      return 'BLE'
    case 'bluetooth-hid':
      return '蓝牙 HID'
    case 'usb-hid':
      return 'USB'
    case 'hid':
      return 'HID'
    default:
      return transport.toUpperCase()
  }
}

export function safetyBadgeLabel(tier: CaptureSafetyTier): string {
  switch (tier) {
    case 'safe':
      return '安全'
    case 'caution':
      return '副键盘谨慎'
    case 'blocked':
      return '禁止拦截'
  }
}

export function accumulateProbeFrame(
  existing: readonly DiscoveredProbeButton[],
  neutralByReport: Map<number, string>,
  frame: { sequence: number; reportId: number; hex: string; isStreamingNoise: boolean },
): DiscoveredProbeButton[] {
  if (frame.isStreamingNoise) return [...existing]
  const norm = normalizeHexBytes(frame.hex)
  if (!norm || norm.bytes.length === 0) return [...existing]

  const allZeroAfterId = norm.bytes.slice(1).every(byte => byte === 0)
  if (allZeroAfterId) {
    if (!neutralByReport.has(frame.reportId)) {
      neutralByReport.set(frame.reportId, norm.hex)
    }
    return [...existing]
  }
  const neutral = neutralByReport.get(frame.reportId)
  if (neutral === norm.hex) return [...existing]

  const key = `${frame.reportId}:${norm.hex}`
  const index = existing.findIndex(item => item.key === key)
  const releaseHex =
    neutral ??
    [norm.bytes[0], ...norm.bytes.slice(1).map(() => 0)]
      .map(byte => byte.toString(16).padStart(2, '0').toUpperCase())
      .join(' ')

  if (index >= 0) {
    const next = [...existing]
    next[index] = {
      ...next[index],
      releaseHex,
      releaseLength: norm.bytes.length,
      hitCount: next[index].hitCount + 1,
      lastSequence: frame.sequence,
    }
    return next
  }

  return [
    ...existing,
    {
      key,
      label: `探针按键 ${existing.length + 1}`,
      reportId: frame.reportId,
      pressHex: norm.hex,
      releaseHex,
      pressLength: norm.bytes.length,
      releaseLength: norm.bytes.length,
      hitCount: 1,
      lastSequence: frame.sequence,
    },
  ]
}

function assertSafeSvgMarkup(svgContent: string) {
  const forbiddenTag = svgContent.match(/<\s*\/?\s*(script|foreignObject|iframe|object|embed|audio|video)\b/i)
  if (forbiddenTag) {
    throw new Error(`SVG 包含不允许的标签：<${forbiddenTag[1]}>`)
  }
  for (const tagMatch of svgContent.matchAll(/<[a-zA-Z][\w:-]*(?:\s+[^<>]*?)?>/g)) {
    const attrs = parseXmlAttributes(tagMatch[0])
    for (const [name, value] of Object.entries(attrs)) {
      const local = name.includes(':') ? name.split(':').pop()! : name
      if (/^on/i.test(local)) {
        throw new Error(`SVG 不能包含事件处理属性：${name}`)
      }
      if ((local === 'href' || name === 'xlink:href') && value.trim() && !value.trim().startsWith('#')) {
        throw new Error('SVG 不能引用外部资源链接')
      }
      if (/javascript\s*:/i.test(value)) {
        throw new Error('SVG 包含不安全协议引用')
      }
      assertInternalUrlRefs(value)
    }
  }
  for (const styleMatch of svgContent.matchAll(/<style\b[^>]*>([\s\S]*?)<\/style>/gi)) {
    if (/@import/i.test(styleMatch[1])) {
      throw new Error('SVG 样式不能使用 @import')
    }
    assertInternalUrlRefs(styleMatch[1])
  }
}

function assertInternalUrlRefs(text: string) {
  for (const match of text.matchAll(/url\(\s*['"]?([^)'"\s]+)/gi)) {
    if (!match[1].startsWith('#')) {
      throw new Error('SVG 样式或属性不能加载外部 url() 资源')
    }
  }
}

function parseSvgViewBox(rootAttrs: Record<string, string>) {
  const rawViewBox = rootAttrs.viewBox?.trim()
  if (rawViewBox) {
    const parts = rawViewBox.split(/[\s,]+/).map(Number)
    if (parts.length === 4 && parts.every(Number.isFinite) && parts[2] > 0 && parts[3] > 0) {
      return { x: parts[0], y: parts[1], width: parts[2], height: parts[3] }
    }
  }
  const width = Number.parseFloat(rootAttrs.width ?? '')
  const height = Number.parseFloat(rootAttrs.height ?? '')
  if (Number.isFinite(width) && width > 0 && Number.isFinite(height) && height > 0) {
    return { x: 0, y: 0, width, height }
  }
  throw new Error('SVG 缺少有效的 viewBox 或宽高尺寸')
}

function extractInputLabels(svgContent: string): Map<string, string> {
  const labels = new Map<string, string>()
  for (const match of svgContent.matchAll(/<ak:input\b[^>]*>/gi)) {
    const attrs = parseXmlAttributes(match[0])
    if (attrs.id) {
      labels.set(attrs.id, attrs.label || attrs.short || attrs.id)
    }
  }
  return labels
}

function extractSvgHotzones(svgContent: string, labelsById: ReadonlyMap<string, string>): CaptureSvgHotzone[] {
  const zones: CaptureSvgHotzone[] = []
  const seen = new Set<string>()

  for (const match of svgContent.matchAll(/<path\b[^>]*\bdata-ak-region\s*=[^>]*>/gi)) {
    const attrs = parseXmlAttributes(match[0])
    const id = attrs['data-ak-region']?.trim()
    const d = attrs.d?.trim()
    if (!id || !d || seen.has(id)) continue
    seen.add(id)
    const anchorParts = (attrs['data-ak-anchor'] ?? '')
      .trim()
      .split(/[\s,]+/)
      .map(Number)
    const anchor =
      anchorParts.length === 2 && anchorParts.every(Number.isFinite)
        ? { x: anchorParts[0], y: anchorParts[1] }
        : undefined
    zones.push({
      id,
      label: labelsById.get(id) ?? attrs['aria-label'] ?? id,
      path: d,
      ...(attrs.transform ? { transform: attrs.transform } : {}),
      ...(anchor ? { anchor } : {}),
    })
  }

  if (zones.length > 0) return zones

  for (const match of svgContent.matchAll(/<g\b[^>]*\bdata-ak-key\s*=[^>]*>([\s\S]*?)<\/g>/gi)) {
    const openTag = match[0].match(/^<g\b[^>]*>/i)?.[0] ?? ''
    const attrs = parseXmlAttributes(openTag)
    const id = attrs['data-ak-key']?.trim()
    if (!id || seen.has(id)) continue
    const synthesized = synthesizeShapePath(match[1])
    if (!synthesized) continue
    seen.add(id)
    zones.push({
      id,
      label: labelsById.get(id) ?? attrs['aria-label'] ?? id,
      path: synthesized,
      ...(attrs.transform ? { transform: attrs.transform } : {}),
    })
  }

  return zones
}

function synthesizeShapePath(innerMarkup: string): string | null {
  const pathTag = innerMarkup.match(/<path\b[^>]*>/i)?.[0]
  if (pathTag) {
    const d = parseXmlAttributes(pathTag).d?.trim()
    if (d) return d
  }
  const circleTag = innerMarkup.match(/<circle\b[^>]*>/i)?.[0]
  if (circleTag) {
    const c = parseXmlAttributes(circleTag)
    const cx = Number(c.cx)
    const cy = Number(c.cy)
    const r = Number(c.r)
    if ([cx, cy, r].every(Number.isFinite) && r > 0) {
      return `M ${cx - r} ${cy} A ${r} ${r} 0 1 0 ${cx + r} ${cy} A ${r} ${r} 0 1 0 ${cx - r} ${cy} Z`
    }
  }
  const rectTag = innerMarkup.match(/<rect\b[^>]*>/i)?.[0]
  if (rectTag) {
    const r = parseXmlAttributes(rectTag)
    const x = Number(r.x ?? 0)
    const y = Number(r.y ?? 0)
    const w = Number(r.width)
    const h = Number(r.height)
    if ([x, y, w, h].every(Number.isFinite) && w > 0 && h > 0) {
      return `M ${x} ${y} H ${x + w} V ${y + h} H ${x} Z`
    }
  }
  return null
}

function parseXmlAttributes(tag: string): Record<string, string> {
  return Object.fromEntries(
    [...tag.matchAll(/([\w:-]+)\s*=\s*(["'])(.*?)\2/gs)].map(match => [match[1], decodeXmlEntities(match[3])]),
  )
}

function decodeXmlEntities(value: string): string {
  return value.replace(/&(?:amp|lt|gt|quot|apos|#\d+|#x[0-9a-f]+);/gi, entity => {
    const known: Record<string, string> = {
      '&amp;': '&',
      '&lt;': '<',
      '&gt;': '>',
      '&quot;': '"',
      '&apos;': "'",
    }
    return (
      known[entity] ??
      String.fromCodePoint(
        entity[2].toLowerCase() === 'x' ? Number.parseInt(entity.slice(3, -1), 16) : Number(entity.slice(2, -1)),
      )
    )
  })
}

function escapeXmlAttr(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}

function extractTextTag(svgContent: string, tagName: string): string | null {
  const re = new RegExp(`<${tagName}\\b[^>]*>([\\s\\S]*?)<\\/${tagName}>`, 'i')
  const match = svgContent.match(re)
  return match ? decodeXmlEntities(match[1].trim()) : null
}

function replaceRootOrDeviceStatus(svg: string, status: string): string {
  let next = svg.replace(/(<svg\b[^>]*?\bdata-ak-status\s*=\s*["'])[^"']*(['"])/i, `$1${status}$2`)
  next = next.replace(/(<ak:device\b[^>]*?\bstatus\s*=\s*["'])[^"']*(['"])/i, `$1${status}$2`)
  return next
}

function injectCapturedInputsXml(svg: string, sampleMap: ReadonlyMap<string, CapturedKeySample>): string {
  return svg.replace(/<ak:input\b[^>]*\/>|<ak:input\b[^>]*>[\s\S]*?<\/ak:input>/gi, block => {
    const openTag = block.match(/^<ak:input\b[^>]*>/i)?.[0] ?? ''
    const attrs = parseXmlAttributes(openTag)
    const sample = attrs.id ? sampleMap.get(attrs.id) : undefined
    if (!sample) return block

    let updatedOpen = openTag.replace(/\/\s*>$/, '>')
    if (/\bbinding\s*=/i.test(updatedOpen)) {
      updatedOpen = updatedOpen.replace(/(\bbinding\s*=\s*["'])[^"']*(['"])/i, '$1captured$2')
    } else {
      updatedOpen = updatedOpen.replace(/>$/, ' binding="captured">')
    }

    const inner = block.endsWith('/>')
      ? ''
      : block
          .slice(openTag.length, block.lastIndexOf('</ak:input>'))
          .replace(/<ak:hid-capture\b[^>]*\/?>/gi, '')
          .trim()

    const releaseAttrs = sample.releaseHex
      ? ` release="${escapeXmlAttr(sample.releaseHex)}" release-length="${sample.releaseLength}"`
      : ''
    const captureTag = `<ak:hid-capture version="1" press="${escapeXmlAttr(sample.pressHex)}" press-length="${sample.pressLength}"${releaseAttrs}/>`

    return `${updatedOpen}${inner}${captureTag}</ak:input>`
  })
}

function injectIdentityIfMissing(svg: string, candidate: CaptureCandidate): string {
  if (/<ak:identity\b/i.test(svg)) return svg
  const vid = `0x${(candidate.vid ?? 0).toString(16).padStart(4, '0').toUpperCase()}`
  const pid = `0x${(candidate.pid ?? 0).toString(16).padStart(4, '0').toUpperCase()}`
  const prefixAttr = candidate.instanceId.toUpperCase().startsWith('BTHLEDEVICE\\')
    ? ' windows-prefix="BTHLEDEVICE"'
    : ''
  const modelAttr = candidate.gattInfo?.modelNumber
    ? ` information-required="true" model-contains="${escapeXmlAttr(candidate.gattInfo.modelNumber)}"`
    : ''
  const identityBlock = `\n      <ak:identity>\n        <ak:match vid="${vid}" pid="${pid}"${prefixAttr}${modelAttr}/>\n      </ak:identity>`
  return svg.replace(/(<ak:device\b[^>]*>)/i, `$1${identityBlock}`)
}
