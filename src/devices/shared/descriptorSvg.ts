import type { RemoteButton } from '../../appTypes'
import { deviceDescriptors } from '../generatedDescriptors.ts'
import type { DeviceKind, DeviceSupportPackage, RemoteKeyRegion, RemoteView } from '../types.ts'

type DescriptorName = keyof typeof deviceDescriptors
export type DescriptorInputId<Name extends DescriptorName> = (typeof deviceDescriptors)[Name]['inputs'][number]['id']

const svgNamespace = 'http://www.w3.org/2000/svg'
const akNamespace = 'urn:axonkey:device:1'
const akSchema = 'axonkey.device/1'
export const maxRuntimeDescriptorSvgBytes = 768 * 1024

const forbiddenElementNames = new Set([
  'script',
  'foreignobject',
  'iframe',
  'object',
  'embed',
  'applet',
  'audio',
  'video',
  'canvas',
  'link',
  'meta',
  'base',
  'animate',
  'animatemotion',
  'animatetransform',
  'set',
  'mpath',
  'a',
  'feimage',
])

const cssUrlAttributes = new Set([
  'style',
  'fill',
  'stroke',
  'filter',
  'clip-path',
  'mask',
  'marker-start',
  'marker-mid',
  'marker-end',
])

const supportedReportEncodings = new Set([
  'boot-keyboard',
  'le-u16-slots',
  'le-u16-single',
  'bit-field',
  'axis-u16',
  'hat-8',
  'vendor-state',
  'gatt-stream',
])

export type RuntimeDescriptorOptions = {
  kind?: DeviceKind
  name?: string
  model?: string
}

export type ParsedRuntimeDescriptor = {
  id: string
  vendor: string
  model: string
  name: string
  artworkUrl: string
  remoteView: RemoteView<string>
  supportPackage: DeviceSupportPackage
}

type RawInputEntry = {
  attrs: Record<string, string>
  sources: Record<string, string>[]
  orderFallback: number
}

export function createDescriptorView<Name extends DescriptorName>(name: Name): RemoteView<DescriptorInputId<Name>> {
  const descriptor = deviceDescriptors[name]
  const buttons = descriptor.inputs.map(input => ({
    id: input.id as DescriptorInputId<Name>,
    label: input.label,
    short: input.short,
    icon: input.icon as RemoteButton['icon'],
    kind: input.kind,
    threshold: input.threshold,
    releaseThreshold: input.releaseThreshold,
    side: input.anchor.x < descriptor.viewBox.width / 2 ? ('left' as const) : ('right' as const),
    x: (input.anchor.x / descriptor.viewBox.width) * 100,
    y: (input.anchor.y / descriptor.viewBox.height) * 100,
  }))
  return {
    buttons,
    identities: descriptor.identities,
    voice: descriptor.voice,
    viewBox: descriptor.viewBox,
    keyRegions: Object.fromEntries(
      descriptor.inputs.map(input => [
        input.id,
        {
          path: input.path,
          anchor: input.anchor,
          ...('transform' in input ? { transform: input.transform } : {}),
        },
      ]),
    ),
    artworkUrl: descriptor.artworkUrl,
    ariaLabel: descriptor.ariaLabel,
  }
}

export function parseRuntimeDescriptorSvg(
  svg: string,
  options: RuntimeDescriptorOptions = {},
): ParsedRuntimeDescriptor {
  if (typeof svg !== 'string') throw new Error('SVG 描述符必须是字符串')
  const trimmed = svg.trim()
  if (!trimmed) throw new Error('SVG 描述符不能为空')
  if (new TextEncoder().encode(trimmed).byteLength > maxRuntimeDescriptorSvgBytes) {
    throw new Error('SVG 描述符体积超出限制')
  }
  if (/<!DOCTYPE\b/i.test(trimmed)) throw new Error('SVG 描述符不允许包含 DOCTYPE')
  if (/<!ENTITY\b/i.test(trimmed)) throw new Error('SVG 描述符不允许包含 ENTITY')

  let rootAttrs: Record<string, string> | null = null
  let deviceAttrs: Record<string, string> | null = null
  const matchTags: Record<string, string>[] = []
  const reportIds = new Set<string>()
  const voiceTags: Record<string, string>[] = []
  const rawInputs: RawInputEntry[] = []
  const regions = new Map<string, RemoteKeyRegion>()
  const svgIds = new Set<string>()
  const stack: string[] = []
  let rootSeen = false
  let openInput: RawInputEntry | null = null
  let styleBuffer: string | null = null

  let cursor = 0
  while (cursor < trimmed.length) {
    const lt = trimmed.indexOf('<', cursor)
    if (lt < 0) {
      const tail = trimmed.slice(cursor)
      if (tail.trim() && !rootSeen) throw new Error('SVG 根元素前存在非法文本')
      decodeXmlEntities(tail)
      break
    }
    if (lt > cursor) {
      const textChunk = trimmed.slice(cursor, lt)
      if (stack.length === 0 && textChunk.trim()) throw new Error('SVG 根元素外存在非法文本')
      const decoded = decodeXmlEntities(textChunk)
      if (styleBuffer !== null) styleBuffer += decoded
    }

    if (trimmed.startsWith('<!--', lt)) {
      const endComment = trimmed.indexOf('-->', lt + 4)
      if (endComment < 0) throw new Error('SVG 注释未闭合')
      cursor = endComment + 3
      continue
    }
    if (trimmed.startsWith('<![CDATA[', lt)) {
      if (stack.length === 0) throw new Error('SVG 根元素外不允许出现 CDATA')
      const endCdata = trimmed.indexOf(']]>', lt + 9)
      if (endCdata < 0) throw new Error('SVG CDATA 未闭合')
      if (styleBuffer !== null) styleBuffer += trimmed.slice(lt + 9, endCdata)
      cursor = endCdata + 3
      continue
    }
    if (trimmed.startsWith('<?', lt)) {
      const endPi = trimmed.indexOf('?>', lt + 2)
      if (endPi < 0) throw new Error('XML 处理指令未闭合')
      cursor = endPi + 2
      continue
    }
    if (trimmed.startsWith('<!', lt)) {
      throw new Error('SVG 包含不支持的 XML 声明')
    }

    const tagEnd = findTagEnd(trimmed, lt + 1)
    if (tagEnd < 0) throw new Error('SVG 标签未闭合')
    const rawTagBody = trimmed.slice(lt + 1, tagEnd)
    cursor = tagEnd + 1

    if (rawTagBody.startsWith('/')) {
      const closeMatch = rawTagBody
        .slice(1)
        .trim()
        .match(/^([A-Za-z_][\w:.-]*)$/)
      if (!closeMatch) throw new Error('SVG 闭合标签格式无效')
      const closeName = closeMatch[1]
      const expected = stack.pop()
      if (expected !== closeName) throw new Error(`SVG 标签不匹配：${closeName}`)
      if (closeName === 'ak:input') openInput = null
      if (localTagName(closeName) === 'style' && styleBuffer !== null) {
        assertSafeCssValue(styleBuffer)
        styleBuffer = null
      }
      continue
    }

    const selfClosing = rawTagBody.endsWith('/')
    const bodyWithoutSlash = selfClosing ? rawTagBody.slice(0, -1) : rawTagBody
    const nameMatch = bodyWithoutSlash.match(/^([A-Za-z_][\w:.-]*)([\s\S]*)$/)
    if (!nameMatch) throw new Error('SVG 元素名称无效')
    const tagName = nameMatch[1]
    const localName = localTagName(tagName)
    if (forbiddenElementNames.has(localName) || forbiddenElementNames.has(tagName.toLowerCase())) {
      throw new Error(`SVG 不允许使用危险元素：<${tagName}>`)
    }

    const attrs = parseStrictAttributes(nameMatch[2])
    if (attrs.id) svgIds.add(attrs.id)

    if (stack.length === 0) {
      if (rootSeen || tagName !== 'svg') throw new Error('SVG 根元素必须是单个 <svg>')
      rootSeen = true
      rootAttrs = attrs
    } else if (tagName.startsWith('ak:')) {
      switch (localName) {
        case 'device':
          if (deviceAttrs) throw new Error('重复的 ak:device 声明')
          deviceAttrs = attrs
          break
        case 'match':
          matchTags.push(attrs)
          break
        case 'report': {
          const reportId = requiredAttr(attrs, 'id', 'ak:report')
          const direction = requiredAttr(attrs, 'direction', 'ak:report')
          const encoding = requiredAttr(attrs, 'encoding', 'ak:report')
          if (direction !== 'input' && direction !== 'output') {
            throw new Error(`不支持的报文方向：${direction}`)
          }
          if (!supportedReportEncodings.has(encoding)) {
            throw new Error(`不支持的报文编码：${encoding}`)
          }
          if (reportIds.has(reportId)) throw new Error(`重复的报文 ID：${reportId}`)
          reportIds.add(reportId)
          break
        }
        case 'voice':
          voiceTags.push(attrs)
          break
        case 'input': {
          const entry: RawInputEntry = {
            attrs,
            sources: attrs.report ? [attrs] : [],
            orderFallback: rawInputs.length,
          }
          rawInputs.push(entry)
          if (!selfClosing) openInput = entry
          break
        }
        case 'source':
          if (openInput) openInput.sources.push(attrs)
          break
      }
    } else if (localName === 'path' && 'data-ak-region' in attrs) {
      const regionId = attrs['data-ak-region']?.trim() ?? ''
      const anchorParts = (attrs['data-ak-anchor'] ?? '').trim().split(/\s+/).map(Number)
      if (
        !regionId ||
        regions.has(regionId) ||
        !attrs.d?.trim() ||
        anchorParts.length !== 2 ||
        !anchorParts.every(Number.isFinite)
      ) {
        throw new Error(`无效或重复的按键热区：${regionId || 'unknown'}`)
      }
      regions.set(regionId, {
        path: attrs.d,
        anchor: { x: anchorParts[0], y: anchorParts[1] },
        ...(attrs.transform ? { transform: attrs.transform } : {}),
      })
    }

    if (!selfClosing) {
      stack.push(tagName)
      if (localName === 'style') styleBuffer = ''
    }
  }

  if (!rootSeen || !rootAttrs || stack.length > 0) {
    throw new Error('SVG XML 结构不完整')
  }
  if (rootAttrs.xmlns !== svgNamespace || rootAttrs['xmlns:ak'] !== akNamespace) {
    throw new Error('SVG 命名空间声明无效')
  }
  if (rootAttrs['data-ak-schema'] !== akSchema) {
    throw new Error('缺少或不支持 data-ak-schema="axonkey.device/1"')
  }
  if ((rootAttrs['data-ak-status'] ?? '').trim().toLowerCase() === 'draft') {
    throw new Error('不支持加载待采集草稿（draft）SVG 描述符')
  }
  const rootDeviceId = requiredAttr(rootAttrs, 'data-ak-device', 'svg')
  const rootRevision = parsePositiveInt(requiredAttr(rootAttrs, 'data-ak-revision', 'svg'), 'data-ak-revision')

  const box = (rootAttrs.viewBox ?? '').trim().split(/\s+/).map(Number)
  if (
    box.length !== 4 ||
    box[0] !== 0 ||
    box[1] !== 0 ||
    !box.slice(2).every(value => Number.isFinite(value) && value > 0)
  ) {
    throw new Error('SVG viewBox 必须从 0 0 开始且宽高为正数')
  }
  const viewBox = { width: box[2], height: box[3] }

  if (!deviceAttrs) throw new Error('缺少 ak:device 元数据')
  if ((deviceAttrs.status ?? '').trim().toLowerCase() === 'draft') {
    throw new Error('不支持加载待采集草稿（draft）SVG 描述符')
  }
  const deviceSchema = requiredAttr(deviceAttrs, 'schema', 'ak:device')
  const deviceId = requiredAttr(deviceAttrs, 'id', 'ak:device')
  const vendor = requiredAttr(deviceAttrs, 'vendor', 'ak:device')
  const rawModel = requiredAttr(deviceAttrs, 'model', 'ak:device')
  const deviceRevision = parsePositiveInt(requiredAttr(deviceAttrs, 'revision', 'ak:device'), 'revision')
  if (deviceSchema !== akSchema || deviceId !== rootDeviceId || deviceRevision !== rootRevision) {
    throw new Error('SVG 根节点与 ak:device 元数据不一致')
  }

  if (matchTags.length === 0) throw new Error('ak:identity 至少需要包含一条 ak:match')
  let everyIdentityVendorUsbHid = true
  const identities = matchTags.map(identity => {
    const vendorIds = parseIdentityNumbers(identity.vid)
    const productIds = parseIdentityNumbers(identity.pid)
    if (vendorIds.length === 0 || productIds.length === 0) {
      throw new Error('ak:match 必须声明有效的 vid 与 pid')
    }
    if (vendorIds.every(v => v === 0) && productIds.every(p => p === 0)) {
      throw new Error('ak:match 不能使用 0x0000:0x0000 占位硬件标识')
    }
    const usagePages = parseIdentityNumbers(identity['usage-page'])
    if (
      identity.transport?.trim() !== 'usb-hid' ||
      usagePages.length === 0 ||
      !usagePages.every(page => page >= 0xff00 && page <= 0xffff)
    ) {
      everyIdentityVendorUsbHid = false
    }
    return {
      vendorIds,
      productIds,
      softwareContains: identity['software-contains'] ?? '',
      softwareFallback: identity['software-fallback'] === 'true',
      windowsPrefix: identity['windows-prefix'] ?? '',
      informationRequired: identity['information-required'] === 'true',
      modelContains: identity['model-contains'] ?? '',
      manufacturerContains: identity['manufacturer-contains'] ?? '',
    }
  })

  if (reportIds.size === 0) throw new Error('缺少 ak:report 报文定义')

  const rawInputIds = new Set<string>()
  const seenButtonIds = new Set<string>()
  const parsedInputs: {
    id: string
    label: string
    short: string
    icon: RemoteButton['icon']
    kind: string
    threshold: number
    releaseThreshold: number
    order: number
    region: RemoteKeyRegion
  }[] = []

  for (const entry of rawInputs) {
    const input = entry.attrs
    const stableId = requiredAttr(input, 'id', 'ak:input')
    if (rawInputIds.has(stableId)) throw new Error(`重复的输入 ID：${stableId}`)
    rawInputIds.add(stableId)
    requiredAttr(input, 'label', `ak:input(${stableId})`)
    requiredAttr(input, 'kind', `ak:input(${stableId})`)

    const pending = input.binding === 'pending'
    if (!pending && entry.sources.length === 0) {
      throw new Error(`输入 ${stableId} 缺少报文来源`)
    }
    for (const source of entry.sources) {
      const report = requiredAttr(source, 'report', `ak:source(${stableId})`)
      if (!reportIds.has(report)) {
        throw new Error(`输入 ${stableId} 引用了未知报文 ${report}`)
      }
    }

    if (input.target) {
      if (!input.target.startsWith('#') || input.target.length <= 1 || !svgIds.has(input.target.slice(1))) {
        throw new Error(`输入 ${stableId} 的 target 引用无效：${input.target}`)
      }
    }

    const region = regions.get(stableId)
    if (!input.target && !region) continue
    const buttonId = input['legacy-key']?.trim().split(/\s+/).find(Boolean) ?? stableId
    if (
      !buttonId ||
      seenButtonIds.has(buttonId) ||
      !input.label?.trim() ||
      !input.short?.trim() ||
      !input.icon?.trim() ||
      !region
    ) {
      throw new Error(`输入 ${stableId} 需要唯一按键 ID、label、short、icon 与对应 data-ak-region`)
    }
    seenButtonIds.add(buttonId)

    const thresholdSource = entry.sources.find(
      source => source.threshold !== undefined || source['release-threshold'] !== undefined,
    )
    const threshold = Number(thresholdSource?.threshold ?? 0.55)
    const releaseThreshold = Number(thresholdSource?.['release-threshold'] ?? 0.35)
    const order = Number(input.order ?? entry.orderFallback)
    if (!Number.isFinite(threshold) || !Number.isFinite(releaseThreshold) || !Number.isFinite(order)) {
      throw new Error(`输入 ${stableId} 包含无效数值属性`)
    }

    parsedInputs.push({
      id: buttonId,
      label: input.label,
      short: input.short,
      icon: input.icon as RemoteButton['icon'],
      kind: input.kind,
      threshold,
      releaseThreshold,
      order,
      region,
    })
  }

  if (!rawInputs.some(entry => entry.sources.length > 0)) {
    throw new Error('SVG 描述符尚未包含任何已采集报文来源的按键')
  }
  parsedInputs.sort((left, right) => left.order - right.order)
  if (parsedInputs.length === 0 || parsedInputs.length !== regions.size) {
    throw new Error('按键定义与 data-ak-region 热区数量不一致')
  }

  for (const voiceAttr of voiceTags) {
    requiredAttr(voiceAttr, 'engine', 'ak:voice')
    const triggerKey = requiredAttr(voiceAttr, 'trigger-key', 'ak:voice')
    if (!rawInputIds.has(triggerKey)) {
      throw new Error(`ak:voice 引用了未知按键：${triggerKey}`)
    }
  }
  const primaryVoice = voiceTags[0]
  const voice = primaryVoice?.engine
    ? {
        engine: primaryVoice.engine,
        transport: primaryVoice.transport ?? 'none',
        triggerModes: (primaryVoice['trigger-modes'] ?? '').split(/\s+/).filter(Boolean),
      }
    : null

  const artworkUrl = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(trimmed)}`
  const ariaLabel = deviceAttrs['display-name']?.trim() || options.name?.trim() || rawModel
  const buttons = parsedInputs.map(input => ({
    id: input.id,
    label: input.label,
    short: input.short,
    icon: input.icon,
    kind: input.kind,
    threshold: input.threshold,
    releaseThreshold: input.releaseThreshold,
    side: input.region.anchor.x < viewBox.width / 2 ? ('left' as const) : ('right' as const),
    x: (input.region.anchor.x / viewBox.width) * 100,
    y: (input.region.anchor.y / viewBox.height) * 100,
  }))
  const remoteView: RemoteView<string> = {
    buttons,
    identities,
    voice,
    usesVendorUsbHid: everyIdentityVendorUsbHid,
    viewBox,
    keyRegions: Object.fromEntries(parsedInputs.map(input => [input.id, input.region])),
    artworkUrl,
    ariaLabel,
  }
  const resolvedKind: DeviceKind = options.kind?.trim() || deviceId
  const resolvedName = options.name?.trim() || deviceAttrs['display-name']?.trim() || rawModel
  const resolvedModel = options.model?.trim() || rawModel

  return {
    id: deviceId,
    vendor,
    model: resolvedModel,
    name: resolvedName,
    artworkUrl,
    remoteView,
    supportPackage: {
      kind: resolvedKind,
      name: resolvedName,
      model: resolvedModel,
      artwork: artworkUrl,
      inputs: buttons,
      remoteView,
    },
  }
}

export function tryParseRuntimeDescriptorSvg(
  svg: string,
  options: RuntimeDescriptorOptions = {},
): ParsedRuntimeDescriptor | null {
  try {
    return parseRuntimeDescriptorSvg(svg, options)
  } catch {
    return null
  }
}

function findTagEnd(source: string, start: number): number {
  let quote: '"' | "'" | null = null
  for (let i = start; i < source.length; i++) {
    const ch = source[i]
    if (quote) {
      if (ch === quote) quote = null
    } else if (ch === '"' || ch === "'") {
      quote = ch
    } else if (ch === '>') {
      return i
    } else if (ch === '<') {
      return -1
    }
  }
  return -1
}

function localTagName(tagName: string): string {
  const idx = tagName.lastIndexOf(':')
  return (idx >= 0 ? tagName.slice(idx + 1) : tagName).toLowerCase()
}

function parseStrictAttributes(raw: string): Record<string, string> {
  const result: Record<string, string> = {}
  let rest = raw.trim()
  while (rest.length > 0) {
    const match = rest.match(/^([A-Za-z_:][\w:.-]*)\s*=\s*(["'])([\s\S]*?)\2/)
    if (!match) {
      throw new Error('SVG 属性格式无效或未加引号')
    }
    const key = match[1]
    const lowerKey = key.toLowerCase()
    const lowerLocal = localTagName(key)
    if (lowerKey.startsWith('on') || lowerLocal.startsWith('on')) {
      throw new Error(`SVG 不允许使用事件属性：${key}`)
    }
    const value = decodeXmlEntities(match[3])
    if (lowerKey === 'href' || lowerKey === 'xlink:href' || lowerLocal === 'href') {
      const target = value.trim()
      if (!target.startsWith('#') || target.length <= 1 || /\s/.test(target)) {
        throw new Error(`SVG 不允许外部或非片段引用：${key}`)
      }
    }
    if (cssUrlAttributes.has(lowerKey) || cssUrlAttributes.has(lowerLocal)) {
      assertSafeCssValue(value)
    }
    result[key] = value
    rest = rest.slice(match[0].length).trim()
  }
  return result
}

function assertSafeCssValue(css: string) {
  const normalized = css.replace(/\/\*[\s\S]*?\*\//g, '')
  if (/@import\b|expression\s*\(|javascript\s*:|vbscript\s*:/i.test(normalized)) {
    throw new Error('SVG 样式包含不安全指令')
  }
  for (const match of normalized.matchAll(/url\(\s*([^)]*?)\s*\)/gi)) {
    const rawTarget = match[1]
      .trim()
      .replace(/^(["'])(.*)\1$/, '$2')
      .trim()
    if (!rawTarget.startsWith('#') || rawTarget.length <= 1 || /\s/.test(rawTarget)) {
      throw new Error('SVG 样式不允许引用外部资源')
    }
  }
}

function decodeXmlEntities(value: string): string {
  return value.replace(/&(#x[0-9a-fA-F]+|#\d+|[A-Za-z][\w.-]*|[^;\s]*);?/g, (full, body: string) => {
    if (!full.endsWith(';')) {
      return full
    }
    const known: Record<string, string> = {
      amp: '&',
      lt: '<',
      gt: '>',
      quot: '"',
      apos: "'",
    }
    if (body in known) return known[body]
    if (body.startsWith('#')) {
      const codePoint =
        body[1]?.toLowerCase() === 'x' ? Number.parseInt(body.slice(2), 16) : Number.parseInt(body.slice(1), 10)
      if (!Number.isInteger(codePoint) || codePoint <= 0 || codePoint > 0x10ffff) {
        throw new Error(`无效的 XML 字符实体：${full}`)
      }
      return String.fromCodePoint(codePoint)
    }
    throw new Error(`不支持自定义 XML 实体：${full}`)
  })
}

function requiredAttr(attrs: Record<string, string>, key: string, context: string): string {
  const value = attrs[key]?.trim()
  if (!value) throw new Error(`${context} 缺少必填属性 ${key}`)
  return value
}

function parsePositiveInt(raw: string, key: string): number {
  const num = Number(raw)
  if (!Number.isInteger(num) || num < 1 || num > 0x7fffffff) {
    throw new Error(`属性 ${key} 必须是正整数`)
  }
  return num
}

function parseIdentityNumbers(raw = ''): number[] {
  return raw
    .split(/[\s,|]+/)
    .filter(Boolean)
    .map(token => {
      const num = Number(token)
      if (!Number.isInteger(num) || num < 0 || num > 0xffffffff) {
        throw new Error(`无效的硬件标识数值：${token}`)
      }
      return num & 0xffff
    })
}
