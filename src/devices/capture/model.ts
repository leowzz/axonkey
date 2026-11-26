import { invoke } from '@tauri-apps/api/core'
import { listen } from '@tauri-apps/api/event'

export const CAPTURE_EVENT_NAME = 'axonkey-device-capture'
export const HID_EVENT_DRAG_MIME = 'application/x-axonkey-hid-event'

export type CaptureSafetyTier = 'safe' | 'caution' | 'blocked'

export type CaptureTransport = 'bluetooth-le' | 'bluetooth-hid' | 'usb-hid' | 'hid'

export type CaptureGattInfo = {
  manufacturer: string | null
  modelNumber: string | null
  softwareRevision: string | null
  bluetoothAddress: string | null
}

export type CaptureAncestorNode = {
  id: string
  label: string
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
  ancestors?: CaptureAncestorNode[]
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
  sourceTargetId?: string | null
  sourceInstanceId?: string | null
  sourceDeviceName?: string | null
  sourceVid?: number | null
  sourcePid?: number | null
}

export type PairedHidEventSource = {
  targetId: string | null
  instanceId: string | null
  deviceName: string | null
  vid: number | null
  pid: number | null
}

export type PairedHidEventItem = {
  id: string
  reportId: number
  pressHex: string
  pressLength: number
  releaseHex: string
  releaseLength: number
  hasObservedRelease: boolean
  isPressed: boolean
  hitCount: number
  firstSequence: number
  lastSequence: number
  source: PairedHidEventSource
}

export type HidPairTrackerState = {
  neutralByReportKey: Map<string, string>
  idleCandidateByReportKey: Map<string, { hex: string; count: number }>
  activeEventIdByReportKey: Map<string, string>
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

export type InstalledLocalCustomDevice = {
  kind: string
  deviceId: string
  name: string
  model: string
  vendor: string
  svg: string
  filePath: string
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

export async function captureSetWorkbenchActive(active: boolean, native?: boolean): Promise<boolean> {
  if (!isTauriCaptureRuntime(native)) return false
  return invoke<boolean>('capture_set_workbench_active', { active })
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

export async function captureInstallLocalDevice(
  params: {
    svgContent: string
    markdownContent?: string | null
  },
  native?: boolean,
): Promise<InstalledLocalCustomDevice> {
  if (!isTauriCaptureRuntime(native)) {
    throw new Error('本机目录安装需在桌面应用中运行')
  }
  return invoke<InstalledLocalCustomDevice>('install_local_custom_device', {
    svgContent: params.svgContent,
    markdownContent: params.markdownContent ?? null,
  })
}

export async function captureOpenLocalDevicesDir(highlightFile?: string | null, native?: boolean): Promise<string> {
  if (!isTauriCaptureRuntime(native)) {
    throw new Error('打开本机设备目录需在桌面应用中运行')
  }
  return invoke<string>('open_local_custom_devices_dir', {
    highlightFile: highlightFile ?? null,
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
  const adaptedCount = draft.inputs.filter(input => isInputDefined(input, sampleMap)).length
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
    '| 按键 | 输入 ID | 来源设备 | Report ID | 按下报文 | 抬起报文 |',
    '| --- | --- | --- | --- | --- | --- |',
    ...draft.inputs.map(item => {
      const sample = sampleMap.get(item.id)
      if (!sample) {
        return `| ${item.label} | \`${item.id}\` | — | — | 待采集 | — |`
      }
      const sourceLabel = sample.sourceDeviceName || candidate?.displayName || '—'
      return `| ${item.label} | \`${item.id}\` | ${sourceLabel} | \`${formatReportIdHex(sample.reportId)}\` | \`${sample.pressHex}\` | \`${sample.releaseHex || '—'}\` |`
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

export function isInputDefined(
  input: Pick<CaptureDraftInputItem, 'id' | 'binding'>,
  samples: ReadonlyMap<string, CapturedKeySample>,
): boolean {
  return samples.has(input.id) || input.binding === 'captured'
}

export function clearSvgKeyDefinitions(svgContent: string, targetInputIds?: ReadonlySet<string>): string {
  let clearedAny = false
  let nextSvg = svgContent.replace(/<ak:input\b[^>]*\/>|<ak:input\b[^>]*>[\s\S]*?<\/ak:input>/gi, block => {
    const openTag = block.match(/^<ak:input\b[^>]*>/i)?.[0] ?? ''
    const attrs = parseXmlAttributes(openTag)
    const id = attrs.id?.trim()
    const shouldClear = !targetInputIds || (Boolean(id) && targetInputIds.has(id!))
    if (!shouldClear) return block

    clearedAny = true
    let cleanedOpen = openTag
      .replace(/\/\s*>$/, '>')
      .replace(/\s+(?:report|page|usage|engine|field|offset|bit|width|equals)\s*=\s*(["']).*?\1/gis, '')

    if (/\bbinding\s*=/i.test(cleanedOpen)) {
      cleanedOpen = cleanedOpen.replace(/(\bbinding\s*=\s*(["']))[^"']*(\2)/i, '$1pending$3')
    } else {
      cleanedOpen = cleanedOpen.replace(/>$/, ' binding="pending">')
    }

    const inner = block.endsWith('/>')
      ? ''
      : block
          .slice(openTag.length, block.lastIndexOf('</ak:input>'))
          .replace(/<ak:source\b[^>]*>[\s\S]*?<\/ak:source>|<ak:source\b[^>]*\/?>/gi, '')
          .replace(/<ak:hid-capture\b[^>]*>[\s\S]*?<\/ak:hid-capture>|<ak:hid-capture\b[^>]*\/?>/gi, '')
          .trim()

    return inner ? `${cleanedOpen}${inner}</ak:input>` : cleanedOpen.replace(/>$/, '/>')
  })

  if (!clearedAny) return svgContent

  const hasRemainingInputSources = [
    ...nextSvg.matchAll(/<ak:input\b[^>]*\/>|<ak:input\b[^>]*>[\s\S]*?<\/ak:input>/gi),
  ].some(match => {
    const block = match[0]
    const openTag = block.match(/^<ak:input\b[^>]*>/i)?.[0] ?? ''
    const attrs = parseXmlAttributes(openTag)
    return Boolean(attrs.report) || /<ak:(?:source|hid-capture)\b/i.test(block)
  })

  if (!hasRemainingInputSources) {
    const voiceReportIds = new Set<string>()
    for (const voiceMatch of nextSvg.matchAll(/<ak:voice\b[^>]*>/gi)) {
      const vAttrs = parseXmlAttributes(voiceMatch[0])
      for (const key of ['audio-report', 'control-report', 'start-report', 'stop-report', 'sync-report']) {
        if (vAttrs[key]) voiceReportIds.add(vAttrs[key])
      }
    }
    nextSvg = nextSvg.replace(/<ak:reports\b[^>]*>([\s\S]*?)<\/ak:reports>/gi, (_full, body: string) => {
      const keptReports: string[] = []
      for (const repMatch of body.matchAll(/<ak:report\b[^>]*\/?>/gi)) {
        const repAttrs = parseXmlAttributes(repMatch[0])
        const id = repAttrs.id ?? ''
        const direction = repAttrs.direction ?? 'input'
        const encoding = repAttrs.encoding ?? ''
        if (direction !== 'input' || encoding === 'gatt-stream' || voiceReportIds.has(id)) {
          keptReports.push(`        ${repMatch[0].trim()}`)
        }
      }
      return keptReports.length > 0
        ? `<ak:reports>\n${keptReports.join('\n')}\n      </ak:reports>`
        : '<ak:reports>\n      </ak:reports>'
    })
  }

  return replaceRootOrDeviceStatus(nextSvg, 'draft')
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
    if (!isInputDefined(candidate, samples) && !skippedIds?.has(candidate.id)) {
      return candidate.id
    }
  }
  for (let offset = 0; offset < inputs.length; offset++) {
    const candidate = inputs[(startIndex + offset) % inputs.length]
    if (!isInputDefined(candidate, samples)) {
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

/** 将常见 HID UsagePage/Usage 转换为简短的功能分类标签。 */
export function formatHidUsageRole(usagePage: number | null, usage: number | null): string | null {
  if (usagePage === null) return null
  if (usagePage === 0x01) {
    switch (usage) {
      case 0x01:
        return '指针设备'
      case 0x02:
        return '鼠标'
      case 0x04:
        return '摇杆'
      case 0x05:
        return '游戏手柄'
      case 0x06:
        return '键盘'
      case 0x07:
        return '小键盘'
      case 0x0c:
        return '无线射频控制'
      case 0x80:
        return '系统控制'
      default:
        return null
    }
  }
  if (usagePage === 0x05) return '游戏控制'
  if (usagePage === 0x0c) return '多媒体 / 功能键'
  if (usagePage === 0x0d) return '触控 / 数位板'
  if (usagePage >= 0xff00) return '厂商自定义'
  return null
}

export function accumulateProbeFrame(
  existing: readonly DiscoveredProbeButton[],
  neutralByReport: Map<number, string>,
  frame: { sequence: number; reportId: number; hex: string; isStreamingNoise: boolean },
  maxItems = 256,
): DiscoveredProbeButton[] {
  if (frame.isStreamingNoise) return existing as DiscoveredProbeButton[]
  const norm = normalizeHexBytes(frame.hex)
  if (!norm || norm.bytes.length === 0) return existing as DiscoveredProbeButton[]

  const allZeroAfterId = norm.bytes.slice(1).every(byte => byte === 0)
  if (allZeroAfterId) {
    if (!neutralByReport.has(frame.reportId)) {
      neutralByReport.set(frame.reportId, norm.hex)
    }
    return existing as DiscoveredProbeButton[]
  }
  const neutral = neutralByReport.get(frame.reportId)
  if (neutral === norm.hex) return existing as DiscoveredProbeButton[]

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

  if (existing.length >= maxItems) return existing as DiscoveredProbeButton[]

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

const EMPTY_HID_SOURCE: PairedHidEventSource = {
  targetId: null,
  instanceId: null,
  deviceName: null,
  vid: null,
  pid: null,
}

export function createHidPairTrackerState(): HidPairTrackerState {
  return {
    neutralByReportKey: new Map(),
    idleCandidateByReportKey: new Map(),
    activeEventIdByReportKey: new Map(),
  }
}

/** 将连续 HID 原始帧配对为包含「按下 + 抬起」与来源设备的单条可拖拽事件。 */
export function accumulatePairedHidEvent(
  existing: readonly PairedHidEventItem[],
  tracker: HidPairTrackerState,
  frame: { sequence: number; reportId: number; hex: string; isStreamingNoise: boolean },
  source: PairedHidEventSource = EMPTY_HID_SOURCE,
  maxItems = 60,
): PairedHidEventItem[] {
  if (frame.isStreamingNoise) return existing as PairedHidEventItem[]
  const norm = normalizeHexBytes(frame.hex)
  if (!norm || norm.bytes.length === 0) return existing as PairedHidEventItem[]

  const sourceKey = source.targetId || source.instanceId || 'default'
  const reportKey = `${sourceKey}:${frame.reportId}`
  const allZeroAfterId = norm.bytes.length <= 1 || norm.bytes.slice(1).every(byte => byte === 0)

  if (allZeroAfterId) {
    tracker.neutralByReportKey.set(reportKey, norm.hex)
  } else if (!tracker.activeEventIdByReportKey.has(reportKey) && !tracker.neutralByReportKey.has(reportKey)) {
    const idleCand = tracker.idleCandidateByReportKey.get(reportKey)
    if (idleCand && idleCand.hex === norm.hex) {
      const nextCount = idleCand.count + 1
      tracker.idleCandidateByReportKey.set(reportKey, { hex: norm.hex, count: nextCount })
      if (nextCount >= 3) {
        tracker.neutralByReportKey.set(reportKey, norm.hex)
      }
    } else {
      tracker.idleCandidateByReportKey.set(reportKey, { hex: norm.hex, count: 1 })
    }
  }

  const knownNeutral = tracker.neutralByReportKey.get(reportKey)
  const isReleaseFrame = allZeroAfterId || (knownNeutral !== undefined && norm.hex === knownNeutral)

  if (isReleaseFrame) {
    const activeEventId = tracker.activeEventIdByReportKey.get(reportKey)
    if (!activeEventId) return existing as PairedHidEventItem[]
    tracker.activeEventIdByReportKey.delete(reportKey)
    const idx = existing.findIndex(item => item.id === activeEventId)
    if (idx < 0) return existing as PairedHidEventItem[]
    const next = [...existing]
    next[idx] = {
      ...next[idx],
      releaseHex: norm.hex,
      releaseLength: norm.bytes.length,
      hasObservedRelease: true,
      isPressed: false,
      lastSequence: frame.sequence,
    }
    return next
  }

  const fallbackReleaseHex =
    knownNeutral ??
    [norm.bytes[0], ...norm.bytes.slice(1).map(() => 0)]
      .map(byte => byte.toString(16).padStart(2, '0').toUpperCase())
      .join(' ')

  const eventId = `${sourceKey}:${frame.reportId}:${norm.hex}`
  const prevActiveId = tracker.activeEventIdByReportKey.get(reportKey)
  const isHoldRepeat = prevActiveId === eventId
  tracker.activeEventIdByReportKey.set(reportKey, eventId)

  const list =
    prevActiveId && !isHoldRepeat
      ? existing.map(item => (item.id === prevActiveId ? { ...item, isPressed: false } : item))
      : [...existing]

  const existingIndex = list.findIndex(item => item.id === eventId)
  if (existingIndex >= 0) {
    const current = list[existingIndex]
    const updated: PairedHidEventItem = {
      ...current,
      releaseHex: current.hasObservedRelease ? current.releaseHex : fallbackReleaseHex,
      releaseLength: current.hasObservedRelease ? current.releaseLength : norm.bytes.length,
      isPressed: true,
      hitCount: isHoldRepeat ? current.hitCount : current.hitCount + 1,
      lastSequence: frame.sequence,
      source: source.targetId || source.instanceId ? source : current.source,
    }
    if (isHoldRepeat || existingIndex === 0) {
      list[existingIndex] = updated
      return list
    }
    list.splice(existingIndex, 1)
    return [updated, ...list].slice(0, maxItems)
  }

  const created: PairedHidEventItem = {
    id: eventId,
    reportId: frame.reportId,
    pressHex: norm.hex,
    pressLength: norm.bytes.length,
    releaseHex: fallbackReleaseHex,
    releaseLength: norm.bytes.length,
    hasObservedRelease: false,
    isPressed: true,
    hitCount: 1,
    firstSequence: frame.sequence,
    lastSequence: frame.sequence,
    source,
  }
  return [created, ...list].slice(0, maxItems)
}

/** 在测试阶段将原始 HID 报文与已采集样本比对，返回触发按下和抬起的输入 ID。 */
export function matchSamplesAgainstRawFrame(
  samples: Iterable<CapturedKeySample>,
  currentlyPressedIds: ReadonlySet<string>,
  frame: { reportId: number; hex: string; isStreamingNoise?: boolean },
): { pressedIds: string[]; releasedIds: string[] } {
  if (frame.isStreamingNoise) return { pressedIds: [], releasedIds: [] }
  const norm = normalizeHexBytes(frame.hex)
  if (!norm || norm.bytes.length === 0) return { pressedIds: [], releasedIds: [] }

  const allZeroAfterId = norm.bytes.length <= 1 || norm.bytes.slice(1).every(byte => byte === 0)
  const pressedIds: string[] = []
  const releasedIds: string[] = []

  for (const sample of samples) {
    if (sample.reportId !== frame.reportId) continue
    const pressHex = normalizeHexBytes(sample.pressHex)?.hex ?? sample.pressHex.trim().toUpperCase()
    const releaseHex = normalizeHexBytes(sample.releaseHex)?.hex ?? sample.releaseHex.trim().toUpperCase()

    if (pressHex && norm.hex === pressHex) {
      if (!currentlyPressedIds.has(sample.inputId)) {
        pressedIds.push(sample.inputId)
      }
    } else if (currentlyPressedIds.has(sample.inputId)) {
      if ((releaseHex && norm.hex === releaseHex) || allZeroAfterId || norm.hex !== pressHex) {
        releasedIds.push(sample.inputId)
      }
    }
  }

  return { pressedIds, releasedIds }
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

export const CAPTURE_TEMP_SNAPSHOT_TTL_MS = 15 * 60 * 1000

export type CaptureSnapshotEntry = {
  targetId: string
  instanceId: string
  displayName: string
  transport: string
  vid: number | null
  pid: number | null
  usagePage: number | null
  usage: number | null
  ancestors: CaptureAncestorNode[]
}

export type CaptureDeviceSnapshot = {
  version: 1
  savedAtMs: number
  entries: CaptureSnapshotEntry[]
}

export type CaptureSnapshotDiff = {
  addedIds: Set<string>
  removedEntries: CaptureSnapshotEntry[]
  unchangedCount: number
}

export type CaptureTreeLeafItem =
  | {
      kind: 'live'
      key: string
      diff: 'added' | 'unchanged'
      displayName: string
      transport: string
      vid: number | null
      pid: number | null
      usagePage: number | null
      usage: number | null
      ancestors: CaptureAncestorNode[]
      candidate: CaptureCandidate
    }
  | {
      kind: 'removed'
      key: string
      diff: 'removed'
      displayName: string
      transport: string
      vid: number | null
      pid: number | null
      usagePage: number | null
      usage: number | null
      ancestors: CaptureAncestorNode[]
      entry: CaptureSnapshotEntry
    }

export type CaptureTreeFolderNode = {
  id: string
  label: string
  kind: 'bus' | 'device'
  children: CaptureTreeFolderNode[]
  items: CaptureTreeLeafItem[]
  totalCount: number
  addedCount: number
  removedCount: number
}

let tempCaptureSnapshotCache: CaptureDeviceSnapshot | null = null

/** 从当前候选列表生成用于短期对比新出现/消失设备的内存快照。 */
export function createCaptureSnapshot(
  candidates: readonly CaptureCandidate[],
  savedAtMs = Date.now(),
): CaptureDeviceSnapshot {
  return {
    version: 1,
    savedAtMs,
    entries: candidates.map(c => ({
      targetId: c.targetId,
      instanceId: c.instanceId,
      displayName: c.displayName,
      transport: c.transport,
      vid: c.vid,
      pid: c.pid,
      usagePage: c.usagePage,
      usage: c.usage,
      ancestors: (c.ancestors ?? []).map(a => ({ id: a.id, label: a.label })),
    })),
  }
}

export function getTempCaptureSnapshot(nowMs = Date.now()): CaptureDeviceSnapshot | null {
  if (!tempCaptureSnapshotCache) return null
  if (nowMs - tempCaptureSnapshotCache.savedAtMs > CAPTURE_TEMP_SNAPSHOT_TTL_MS) {
    tempCaptureSnapshotCache = null
    return null
  }
  return tempCaptureSnapshotCache
}

export function setTempCaptureSnapshot(
  candidates: readonly CaptureCandidate[],
  nowMs = Date.now(),
): CaptureDeviceSnapshot {
  const snapshot = createCaptureSnapshot(candidates, nowMs)
  tempCaptureSnapshotCache = snapshot
  return snapshot
}

export function clearTempCaptureSnapshot(): void {
  tempCaptureSnapshotCache = null
}

export function diffCandidatesWithSnapshot(
  candidates: readonly CaptureCandidate[],
  snapshot: CaptureDeviceSnapshot | null,
): CaptureSnapshotDiff {
  if (!snapshot) {
    return {
      addedIds: new Set<string>(),
      removedEntries: [],
      unchangedCount: candidates.length,
    }
  }
  const snapshotTargets = new Set(snapshot.entries.map(entry => entry.targetId))
  const liveTargets = new Set(candidates.map(candidate => candidate.targetId))
  const addedIds = new Set(
    candidates.filter(candidate => !snapshotTargets.has(candidate.targetId)).map(candidate => candidate.targetId),
  )
  const removedEntries = snapshot.entries.filter(entry => !liveTargets.has(entry.targetId))
  return {
    addedIds,
    removedEntries,
    unchangedCount: candidates.length - addedIds.size,
  }
}

type MutableTreeFolder = {
  id: string
  label: string
  kind: 'bus' | 'device'
  childMap: Map<string, MutableTreeFolder>
  children: MutableTreeFolder[]
  items: CaptureTreeLeafItem[]
}

const BUS_META: Record<string, { id: string; label: string; order: number }> = {
  'usb-hid': { id: 'bus:usb-hid', label: 'USB 总线', order: 0 },
  'bluetooth-le': { id: 'bus:bluetooth-le', label: '低功耗蓝牙 (BLE)', order: 1 },
  'bluetooth-hid': { id: 'bus:bluetooth-hid', label: '经典蓝牙 (HID)', order: 2 },
}

function getBusMeta(transport: string) {
  return BUS_META[transport] ?? { id: 'bus:hid-other', label: '其他 HID 接口', order: 3 }
}

function createMutableFolder(id: string, label: string, kind: 'bus' | 'device'): MutableTreeFolder {
  return { id, label, kind, childMap: new Map(), children: [], items: [] }
}

function finalizeTreeFolder(node: MutableTreeFolder): CaptureTreeFolderNode {
  const children: CaptureTreeFolderNode[] = []
  const items: CaptureTreeLeafItem[] = [...node.items]

  for (const child of node.children) {
    const finalizedChild = finalizeTreeFolder(child)
    // Collapse single-child Bluetooth/device container whose name duplicates its only child leaf.
    const canUnwrapRedundantSingle =
      finalizedChild.kind === 'device' &&
      finalizedChild.children.length === 0 &&
      finalizedChild.items.length === 1 &&
      finalizedChild.label.trim().toLowerCase() === finalizedChild.items[0].displayName.trim().toLowerCase()
    if (canUnwrapRedundantSingle) {
      items.push(finalizedChild.items[0])
    } else {
      children.push(finalizedChild)
    }
  }

  let totalCount = items.length
  let addedCount = items.filter(item => item.diff === 'added').length
  let removedCount = items.filter(item => item.diff === 'removed').length
  for (const child of children) {
    totalCount += child.totalCount
    addedCount += child.addedCount
    removedCount += child.removedCount
  }

  return {
    id: node.id,
    label: node.label,
    kind: node.kind,
    children,
    items,
    totalCount,
    addedCount,
    removedCount,
  }
}

/** 按传输总线与 Windows PnP 父级设备树构建文件目录式层级树。 */
export function buildCaptureDeviceTree(items: readonly CaptureTreeLeafItem[]): CaptureTreeFolderNode[] {
  const busFolders = new Map<string, { order: number; folder: MutableTreeFolder }>()

  for (const item of items) {
    const busMeta = getBusMeta(item.transport)
    let busEntry = busFolders.get(busMeta.id)
    if (!busEntry) {
      busEntry = {
        order: busMeta.order,
        folder: createMutableFolder(busMeta.id, busMeta.label, 'bus'),
      }
      busFolders.set(busMeta.id, busEntry)
    }

    let cursor = busEntry.folder
    for (const ancestor of item.ancestors) {
      const normalizedId = ancestor.id.trim().toUpperCase() || ancestor.label.trim()
      const childKey = `${cursor.id}::${normalizedId}`
      let next = cursor.childMap.get(childKey)
      if (!next) {
        next = createMutableFolder(childKey, ancestor.label, 'device')
        cursor.childMap.set(childKey, next)
        cursor.children.push(next)
      }
      cursor = next
    }
    cursor.items.push(item)
  }

  return [...busFolders.values()].sort((a, b) => a.order - b.order).map(entry => finalizeTreeFolder(entry.folder))
}
