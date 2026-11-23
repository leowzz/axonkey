import type { RemoteButton } from '../../appTypes'
import { parseRuntimeDescriptorSvg } from '../shared/descriptorSvg.ts'
import type { DeviceSupportPackage } from '../types.ts'

export type TileMode = 'gesture' | 'hold'
export type TileAccent = 'slate' | 'blue' | 'emerald' | 'amber' | 'rose' | 'violet'
export type PageLayout = 'remote' | 'grid'
export type DeckZoneKind = 'bento-grid' | 'dpad-3x3' | 'pointer-pad'
export type EmbeddedPointerMode = 'trackpad' | 'relative'

export interface MobileTile {
  id: string
  label: string
  subtitle?: string
  actionSummary?: string
  icon: string
  accent: TileAccent
  colSpan: 1 | 2
  rowSpan?: 1 | 2
  mode: TileMode
  hasDoubleClick?: boolean
  hasLongPress?: boolean
}

export interface MobileDeckZone {
  id: string
  kind: DeckZoneKind
  columns?: 2 | 3 | 4
  pointerMode?: EmbeddedPointerMode
  tileIds: string[]
}

export interface MobileDeckPage {
  id: string
  name: string
  layout?: PageLayout
  columns: 2 | 3 | 4
  tiles: MobileTile[]
  zones?: MobileDeckZone[]
}

export interface DeckSnapshot {
  version: number
  activePageId: string
  trackpadSplit: number
  pointerSensitivity: number
  scrollSensitivity: number
  doubleClickWindowMs: number
  longPressWindowMs: number
  voiceBindingSummary?: string | null
  pages: MobileDeckPage[]
}

export interface PackedBentoTile {
  tile: MobileTile
  col: number
  row: number
  colSpan: 1 | 2
  rowSpan: 1 | 2
}

export interface PackedBentoGrid {
  columns: 2 | 3 | 4
  totalRows: number
  items: PackedBentoTile[]
}

const VOICE_KEY_ID = 'mobile.voice'

const CLASSIC_TOP_IDS = ['remote.esc', 'remote.menu', 'remote.home'] as const
const CLASSIC_DPAD_SLOTS = [
  'remote.back',
  'remote.up',
  'remote.vol_up',
  'remote.left',
  'remote.ok',
  'remote.right',
  'remote.mute',
  'remote.down',
  'remote.vol_down',
] as const

const ACCENT_PALETTE: Record<
  TileAccent,
  { fill: string; stroke: string; labelFill: string; subFill: string; badgeBg: string }
> = {
  slate: {
    fill: '#182030',
    stroke: '#2e3c56',
    labelFill: '#e2e8f0',
    subFill: '#94a3b8',
    badgeBg: '#253147',
  },
  blue: {
    fill: '#15233b',
    stroke: '#2d4e82',
    labelFill: '#bfdbfe',
    subFill: '#60a5fa',
    badgeBg: '#1e3559',
  },
  emerald: {
    fill: '#112721',
    stroke: '#235949',
    labelFill: '#a7f3d0',
    subFill: '#34d399',
    badgeBg: '#193b32',
  },
  amber: {
    fill: '#261e13',
    stroke: '#594322',
    labelFill: '#fde68a',
    subFill: '#fbbf24',
    badgeBg: '#382c1a',
  },
  rose: {
    fill: '#28161e',
    stroke: '#5e2b3d',
    labelFill: '#fecdd3',
    subFill: '#fb7185',
    badgeBg: '#3b202c',
  },
  violet: {
    fill: '#1e1732',
    stroke: '#463375',
    labelFill: '#ddd6fe',
    subFill: '#a78bfa',
    badgeBg: '#2d224a',
  },
}

function clampColumns(columns?: number): 2 | 3 | 4 {
  if (columns === 2 || columns === 3 || columns === 4) return columns
  if (typeof columns === 'number' && Number.isFinite(columns)) {
    const clamped = Math.max(2, Math.min(4, Math.round(columns)))
    return clamped as 2 | 3 | 4
  }
  return 3
}

export function escapeXml(raw: string | null | undefined): string {
  if (!raw) return ''
  let cleaned = ''
  for (let i = 0; i < raw.length; i++) {
    const code = raw.charCodeAt(i)
    if (code === 0x09 || code === 0x0a || code === 0x0d || code >= 0x20) {
      cleaned += raw[i]
    }
  }
  return cleaned
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;')
}

export function mapMobileIconToRemoteIcon(mobileIcon: string | undefined, tileId?: string): RemoteButton['icon'] {
  if (tileId === 'remote.vol_down') return 'volumeDown'
  switch ((mobileIcon ?? '').trim().toLowerCase()) {
    case 'power':
    case 'esc':
      return 'power'
    case 'search':
    case 'menu':
    case 'layout':
      return 'menu'
    case 'command':
    case 'home':
      return 'home'
    case 'undo':
    case 'back':
      return 'back'
    case 'arrow-up':
    case 'up':
      return 'up'
    case 'arrow-down':
    case 'down':
      return 'down'
    case 'arrow-left':
    case 'left':
      return 'left'
    case 'arrow-right':
    case 'right':
      return 'right'
    case 'volume-up':
    case 'volumeup':
      return 'volumeUp'
    case 'volume-down':
    case 'volumedown':
      return 'volumeDown'
    case 'volume-mute':
    case 'mute':
      return 'mute'
    case 'mic':
      return 'mic'
    case 'sparkles':
    case 'zap':
    case 'plus':
    case 'refresh':
    case 'mouse':
    case 'locate':
      return 'locate'
    case 'play':
    case 'pause':
    case 'skip-back':
    case 'skip-forward':
    case 'tv':
      return 'tv'
    case 'settings':
      return 'settings'
    case 'delete':
      return 'delete'
    case 'number':
      return 'number'
    case 'terminal':
    case 'code':
    case 'keyboard':
    case 'm':
      return 'm'
    case 'enter':
    case 'check':
    case 'send':
    case 'copy':
    case 'clipboard':
    case 'save':
    case 'folder':
    case 'center':
    default:
      return 'center'
  }
}

export function normalizePageZones(page: MobileDeckPage): MobileDeckZone[] {
  const validTileIds = page.tiles.map(t => t.id.trim()).filter(id => Boolean(id) && id !== VOICE_KEY_ID)
  const tileIdSet = new Set(validTileIds)
  const defaultCols = clampColumns(page.columns)

  if (page.zones && page.zones.length > 0) {
    const zones: MobileDeckZone[] = page.zones.map((zone, idx) => ({
      id: zone.id?.trim() || `${page.id}-zone-${idx + 1}`,
      kind:
        zone.kind === 'dpad-3x3' || zone.kind === 'pointer-pad' || zone.kind === 'bento-grid'
          ? zone.kind
          : 'bento-grid',
      ...(zone.columns !== undefined ? { columns: clampColumns(zone.columns) } : {}),
      ...(zone.pointerMode !== undefined ? { pointerMode: zone.pointerMode } : {}),
      tileIds: Array.isArray(zone.tileIds) ? zone.tileIds.map(id => (typeof id === 'string' ? id.trim() : '')) : [],
    }))

    const referenced = new Set<string>()
    for (const zone of zones) {
      if (zone.kind === 'pointer-pad') continue
      const limit = zone.kind === 'dpad-3x3' ? 9 : zone.tileIds.length
      for (let i = 0; i < limit && i < zone.tileIds.length; i++) {
        const id = zone.tileIds[i]
        if (id) referenced.add(id)
      }
    }

    const orphans = validTileIds.filter(id => !referenced.has(id))
    if (orphans.length > 0) {
      let lastBentoIdx = -1
      for (let i = zones.length - 1; i >= 0; i--) {
        if (zones[i].kind === 'bento-grid') {
          lastBentoIdx = i
          break
        }
      }
      if (lastBentoIdx >= 0) {
        zones[lastBentoIdx] = {
          ...zones[lastBentoIdx],
          tileIds: [...zones[lastBentoIdx].tileIds, ...orphans],
        }
      } else {
        zones.push({
          id: `${page.id}-overflow`,
          kind: 'bento-grid',
          columns: defaultCols,
          tileIds: orphans,
        })
      }
    }

    return zones
  }

  if (page.layout === 'remote' || page.id === 'classic-remote') {
    const topIds = CLASSIC_TOP_IDS.filter(id => tileIdSet.has(id))
    const hasDpadTiles = CLASSIC_DPAD_SLOTS.some(id => tileIdSet.has(id))
    const dpadSlots = CLASSIC_DPAD_SLOTS.map(id => (tileIdSet.has(id) ? id : ''))
    const used = new Set<string>([...topIds, ...dpadSlots.filter(Boolean)])
    const remaining = validTileIds.filter(id => !used.has(id))

    const synthesized: MobileDeckZone[] = []
    if (topIds.length > 0) {
      synthesized.push({
        id: `${page.id}-top`,
        kind: 'bento-grid',
        columns: 3,
        tileIds: [...topIds],
      })
    }
    if (hasDpadTiles) {
      synthesized.push({
        id: `${page.id}-dpad`,
        kind: 'dpad-3x3',
        tileIds: dpadSlots,
      })
    }
    if (remaining.length > 0) {
      synthesized.push({
        id: `${page.id}-bottom`,
        kind: 'bento-grid',
        columns: 2,
        tileIds: remaining,
      })
    }
    if (synthesized.length > 0) return synthesized
  }

  return [
    {
      id: `${page.id}-grid`,
      kind: 'bento-grid',
      columns: defaultCols,
      tileIds: validTileIds,
    },
  ]
}

export function packBentoTiles(tiles: readonly MobileTile[], columns: 2 | 3 | 4): PackedBentoGrid {
  const cols = clampColumns(columns)
  const occupied: boolean[][] = []
  const items: PackedBentoTile[] = []

  const ensureRow = (r: number) => {
    while (occupied.length <= r) {
      occupied.push(new Array<boolean>(cols).fill(false))
    }
  }

  const canPlace = (row: number, col: number, w: number, h: number): boolean => {
    if (col + w > cols) return false
    for (let r = row; r < row + h; r++) {
      ensureRow(r)
      for (let c = col; c < col + w; c++) {
        if (occupied[r][c]) return false
      }
    }
    return true
  }

  const markOccupied = (row: number, col: number, w: number, h: number) => {
    for (let r = row; r < row + h; r++) {
      ensureRow(r)
      for (let c = col; c < col + w; c++) {
        occupied[r][c] = true
      }
    }
  }

  for (const tile of tiles) {
    const rawW = Math.max(1, Math.min(2, Math.round(tile.colSpan ?? 1)))
    const w = Math.min(cols, rawW) as 1 | 2
    const h = Math.max(1, Math.min(2, Math.round(tile.rowSpan ?? 1))) as 1 | 2

    let row = 0
    for (;;) {
      let placed = false
      for (let col = 0; col <= cols - w; col++) {
        if (canPlace(row, col, w, h)) {
          markOccupied(row, col, w, h)
          items.push({ tile, col, row, colSpan: w, rowSpan: h })
          placed = true
          break
        }
      }
      if (placed) break
      row += 1
    }
  }

  const totalRows = items.reduce((max, item) => Math.max(max, item.row + item.rowSpan), 1)
  return { columns: cols, totalRows, items }
}

function fmt(value: number): string {
  const rounded = Math.round(value * 100) / 100
  return Number.isInteger(rounded) ? String(rounded) : rounded.toFixed(2).replace(/\.?0+$/, '')
}

function roundedRectPath(x: number, y: number, w: number, h: number, r: number): string {
  const rx = Math.max(0, Math.min(r, w / 2, h / 2))
  return `M ${fmt(x + rx)} ${fmt(y)} H ${fmt(x + w - rx)} A ${fmt(rx)} ${fmt(rx)} 0 0 1 ${fmt(x + w)} ${fmt(y + rx)} V ${fmt(y + h - rx)} A ${fmt(rx)} ${fmt(rx)} 0 0 1 ${fmt(x + w - rx)} ${fmt(y + h)} H ${fmt(x + rx)} A ${fmt(rx)} ${fmt(rx)} 0 0 1 ${fmt(x)} ${fmt(y + h - rx)} V ${fmt(y + rx)} A ${fmt(rx)} ${fmt(rx)} 0 0 1 ${fmt(x + rx)} ${fmt(y)} Z`
}

function sanitizeDomId(rawId: string, usedIds: Set<string>): string {
  const slug = rawId
    .trim()
    .replace(/[^A-Za-z0-9_-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48)
  const base = `key-${slug || 'tile'}`
  let candidate = base
  let suffix = 2
  while (usedIds.has(candidate)) {
    candidate = `${base}-${suffix}`
    suffix += 1
  }
  usedIds.add(candidate)
  return candidate
}

function charVisualUnits(ch: string): number {
  const code = ch.codePointAt(0) ?? 0
  if (code <= 0x7f) return 0.58
  return 1.0
}

function fitSvgText(raw: string, maxPx: number, fontSize: number): string {
  const text = raw.trim()
  if (!text) return ''
  const maxUnits = Math.max(2, maxPx / fontSize)
  const chars = Array.from(text)
  let total = 0
  for (const ch of chars) total += charVisualUnits(ch)
  if (total <= maxUnits) return text

  let acc = 0
  let out = ''
  const budget = Math.max(1.2, maxUnits - 0.85)
  for (const ch of chars) {
    const w = charVisualUnits(ch)
    if (acc + w > budget && out.length > 0) break
    out += ch
    acc += w
  }
  return `${out}…`
}

function deriveShortLabel(tile: MobileTile, safeLabel: string): string {
  switch (tile.id) {
    case 'remote.ok':
      return 'OK'
    case 'remote.vol_up':
      return '音量+'
    case 'remote.vol_down':
      return '音量-'
    case 'remote.q1':
      return 'Q1'
    case 'remote.q2':
      return 'Q2'
    case 'remote.q3':
      return 'Q3'
    case 'remote.q4':
      return 'Q4'
    default: {
      const compact = Array.from(safeLabel).slice(0, 6).join('').trim()
      return compact || '按键'
    }
  }
}

interface SynthesizedInputRecord {
  id: string
  domId: string
  label: string
  short: string
  icon: RemoteButton['icon']
  anchorX: number
  anchorY: number
  regionPath: string
}

export function synthesizeMobileDescriptorSvg(snapshot: DeckSnapshot, targetPageId?: string): string {
  const requestedPageId = targetPageId?.trim() || snapshot.activePageId
  const selectedPage: MobileDeckPage = snapshot.pages.find(p => p.id === requestedPageId) ??
    snapshot.pages[0] ?? {
      id: 'default-page',
      name: '默认面板',
      layout: 'grid',
      columns: 3,
      tiles: [],
    }

  const zones = normalizePageZones(selectedPage)
  const tileById = new Map<string, MobileTile>()
  for (const tile of selectedPage.tiles) {
    const id = tile.id?.trim()
    if (id && id !== VOICE_KEY_ID && !tileById.has(id)) {
      tileById.set(id, tile)
    }
  }

  const usedDomIds = new Set<string>(['key-voice', 'axonkey-mobile-title', 'axonkey-mobile-desc'])
  const renderedInputIds = new Set<string>([VOICE_KEY_ID])
  const inputRecords: SynthesizedInputRecord[] = []
  const bodyFragments: string[] = []

  const contentX = 34
  const contentWidth = 252
  const zoneGap = 12
  let cursorY = 52

  const isClassicRemote =
    (selectedPage.layout === 'remote' || selectedPage.id === 'classic-remote') &&
    (!selectedPage.zones || selectedPage.zones.length === 0)

  zones.forEach((zone, zoneIdx) => {
    if (zoneIdx > 0) cursorY += zoneGap

    if (zone.kind === 'pointer-pad') {
      const padH = 124
      const padTitle = zone.pointerMode === 'relative' ? '内嵌体感空鼠区' : '内嵌触控板区'
      const padSub = zone.pointerMode === 'relative' ? '按住离合挥动 · 轻点左键' : '单指移动 · 双指滚轮 · 轻点左键'
      const cx = contentX + contentWidth / 2
      bodyFragments.push(
        `  <g class="am-pointer-pad">`,
        `    <rect x="${contentX}" y="${fmt(cursorY)}" width="${contentWidth}" height="${padH}" rx="18" fill="url(#am-pad)" stroke="#293852" stroke-width="1.25" />`,
        `    <rect x="${contentX + 10}" y="${fmt(cursorY + 10)}" width="${contentWidth - 20}" height="${padH - 42}" rx="12" fill="none" stroke="#1e293b" stroke-width="1" stroke-dasharray="3 3" />`,
        `    <text x="${fmt(cx)}" y="${fmt(cursorY + 46)}" fill="#cbd5e1" font-size="12.5" font-weight="600" text-anchor="middle">${escapeXml(padTitle)}</text>`,
        `    <text x="${fmt(cx)}" y="${fmt(cursorY + 65)}" fill="#64748b" font-size="10" text-anchor="middle">${escapeXml(padSub)}</text>`,
        `    <line x1="${contentX + 14}" y1="${fmt(cursorY + padH - 24)}" x2="${contentX + contentWidth - 14}" y2="${fmt(cursorY + padH - 24)}" stroke="#1e293b" stroke-width="1" />`,
        `    <line x1="${fmt(cx)}" y1="${fmt(cursorY + padH - 21)}" x2="${fmt(cx)}" y2="${fmt(cursorY + padH - 7)}" stroke="#1e293b" stroke-width="1" />`,
        `    <text x="${fmt(contentX + contentWidth * 0.26)}" y="${fmt(cursorY + padH - 10)}" fill="#64748b" font-size="9.5" text-anchor="middle">左键</text>`,
        `    <text x="${fmt(contentX + contentWidth * 0.74)}" y="${fmt(cursorY + padH - 10)}" fill="#64748b" font-size="9.5" text-anchor="middle">右键</text>`,
        `  </g>`,
      )
      cursorY += padH
      return
    }

    if (zone.kind === 'dpad-3x3') {
      const wellX = 32
      const wellW = 256
      const wellH = 256
      const padStart = 40
      const cell = 76
      const gap = 6
      const rx = 14

      bodyFragments.push(
        `  <rect x="${wellX}" y="${fmt(cursorY)}" width="${wellW}" height="${wellH}" rx="20" fill="#121723" stroke="#232e44" stroke-width="1.2" />`,
      )

      for (let slot = 0; slot < 9; slot++) {
        const r = Math.floor(slot / 3)
        const c = slot % 3
        const x = padStart + c * (cell + gap)
        const y = cursorY + 8 + r * (cell + gap)
        const cx = x + cell / 2
        const cy = y + cell / 2
        const rawId = zone.tileIds[slot]?.trim() ?? ''
        const tile = rawId ? tileById.get(rawId) : undefined

        if (!tile || renderedInputIds.has(tile.id)) {
          bodyFragments.push(
            `  <rect x="${fmt(x)}" y="${fmt(y)}" width="${cell}" height="${cell}" rx="${rx}" fill="#0f1420" stroke="#1b2436" stroke-width="1" stroke-dasharray="3 3" opacity="0.55" />`,
          )
          continue
        }

        renderedInputIds.add(tile.id)
        const domId = sanitizeDomId(tile.id, usedDomIds)
        const safeLabel = tile.label?.trim() || tile.id
        const silkscreen = (tile.actionSummary?.trim() || tile.subtitle?.trim() || '').trim()
        const palette = ACCENT_PALETTE[tile.accent] ?? ACCENT_PALETTE.slate
        const isCenterOk = slot === 4 && (tile.id === 'remote.ok' || tile.accent === 'blue')
        const isCardinalArrow =
          (slot === 1 && (tile.icon === 'arrow-up' || tile.id === 'remote.up')) ||
          (slot === 3 && (tile.icon === 'arrow-left' || tile.id === 'remote.left')) ||
          (slot === 5 && (tile.icon === 'arrow-right' || tile.id === 'remote.right')) ||
          (slot === 7 && (tile.icon === 'arrow-down' || tile.id === 'remote.down'))

        const capFill = isCenterOk ? 'url(#am-ok)' : isCardinalArrow ? 'url(#am-dpad-cap)' : palette.fill
        const capStroke = isCenterOk ? '#4f8ff7' : isCardinalArrow ? '#3d4e70' : palette.stroke
        const capStrokeW = isCenterOk ? '1.6' : '1.25'

        bodyFragments.push(`  <g id="${domId}" data-ak-key="${escapeXml(tile.id)}" data-ak-role="input">`)
        bodyFragments.push(
          `    <rect x="${fmt(x)}" y="${fmt(y)}" width="${cell}" height="${cell}" rx="${rx}" fill="${capFill}" stroke="${capStroke}" stroke-width="${capStrokeW}" />`,
        )

        if (isCardinalArrow) {
          const arrowY = silkscreen ? cy - 5 : cy
          if (slot === 1) {
            bodyFragments.push(
              `    <path d="M${fmt(cx)} ${fmt(arrowY - 8)}L${fmt(cx + 8)} ${fmt(arrowY + 4)}H${fmt(cx - 8)}Z" fill="#f8fafc" />`,
            )
          } else if (slot === 7) {
            bodyFragments.push(
              `    <path d="M${fmt(cx)} ${fmt(arrowY + 8)}L${fmt(cx + 8)} ${fmt(arrowY - 4)}H${fmt(cx - 8)}Z" fill="#f8fafc" />`,
            )
          } else if (slot === 3) {
            bodyFragments.push(
              `    <path d="M${fmt(cx - 8)} ${fmt(arrowY)}L${fmt(cx + 4)} ${fmt(arrowY - 8)}V${fmt(arrowY + 8)}Z" fill="#f8fafc" />`,
            )
          } else if (slot === 5) {
            bodyFragments.push(
              `    <path d="M${fmt(cx + 8)} ${fmt(arrowY)}L${fmt(cx - 4)} ${fmt(arrowY - 8)}V${fmt(arrowY + 8)}Z" fill="#f8fafc" />`,
            )
          }
          if (silkscreen) {
            bodyFragments.push(
              `    <text x="${fmt(cx)}" y="${fmt(y + cell - 12)}" fill="#94a3b8" font-size="9.5" text-anchor="middle">${escapeXml(fitSvgText(silkscreen, cell - 12, 9.5))}</text>`,
            )
          }
        } else {
          const displayTitle = isCenterOk && tile.id === 'remote.ok' ? 'OK' : fitSvgText(safeLabel, cell - 12, 12.5)
          const titleY = silkscreen ? cy - 2 : cy + 5
          const titleColor = isCenterOk ? '#ffffff' : palette.labelFill
          const titleSize = isCenterOk && displayTitle === 'OK' ? '15' : '12.5'
          bodyFragments.push(
            `    <text x="${fmt(cx)}" y="${fmt(titleY)}" fill="${titleColor}" font-size="${titleSize}" font-weight="650" text-anchor="middle">${escapeXml(displayTitle)}</text>`,
          )
          if (silkscreen) {
            const subColor = isCenterOk ? '#bfdbfe' : palette.subFill
            bodyFragments.push(
              `    <text x="${fmt(cx)}" y="${fmt(titleY + 16)}" fill="${subColor}" font-size="9.5" text-anchor="middle">${escapeXml(fitSvgText(silkscreen, cell - 12, 9.5))}</text>`,
            )
          }
        }
        bodyFragments.push(`  </g>`)

        inputRecords.push({
          id: tile.id,
          domId,
          label: safeLabel,
          short: deriveShortLabel(tile, safeLabel),
          icon: mapMobileIconToRemoteIcon(tile.icon, tile.id),
          anchorX: cx,
          anchorY: cy,
          regionPath: roundedRectPath(x, y, cell, cell, rx),
        })
      }

      cursorY += wellH
      return
    }

    // Default: 'bento-grid'
    const cols = clampColumns(zone.columns ?? selectedPage.columns)
    const zoneTiles: MobileTile[] = []
    for (const rawId of zone.tileIds) {
      const id = rawId?.trim()
      if (!id || renderedInputIds.has(id)) continue
      const tile = tileById.get(id)
      if (!tile) continue
      renderedInputIds.add(id)
      zoneTiles.push(tile)
    }

    if (zoneTiles.length === 0) {
      const emptyH = 68
      const cx = contentX + contentWidth / 2
      bodyFragments.push(
        `  <g class="am-empty-grid">`,
        `    <rect x="${contentX}" y="${fmt(cursorY)}" width="${contentWidth}" height="${emptyH}" rx="14" fill="#111724" stroke="#1e293b" stroke-width="1.1" stroke-dasharray="4 4" />`,
        `    <text x="${fmt(cx)}" y="${fmt(cursorY + 38)}" fill="#64748b" font-size="11" text-anchor="middle">空白网格区块（可在手机端添加按键）</text>`,
        `  </g>`,
      )
      cursorY += emptyH
      return
    }

    const packed = packBentoTiles(zoneTiles, cols)
    const gap = 8
    const cellW = (contentWidth - gap * (cols - 1)) / cols
    const isCompactUtilityRow = isClassicRemote && zoneIdx === 0 && packed.totalRows === 1
    const cellH = isCompactUtilityRow ? 50 : 62
    const rx = isCompactUtilityRow ? 12 : 14

    for (const item of packed.items) {
      const { tile, col, row, colSpan, rowSpan } = item
      const x = contentX + col * (cellW + gap)
      const y = cursorY + row * (cellH + gap)
      const w = cellW * colSpan + gap * (colSpan - 1)
      const h = cellH * rowSpan + gap * (rowSpan - 1)
      const cx = x + w / 2
      const cy = y + h / 2

      const domId = sanitizeDomId(tile.id, usedDomIds)
      const safeLabel = tile.label?.trim() || tile.id
      const silkscreen = (tile.actionSummary?.trim() || tile.subtitle?.trim() || '').trim()
      const palette = ACCENT_PALETTE[tile.accent] ?? ACCENT_PALETTE.slate

      const labelFontSize = rowSpan === 2 && colSpan === 2 ? 14 : cols === 4 && colSpan === 1 ? 11 : 12.5
      const subFontSize = cols === 4 && colSpan === 1 ? 8.5 : 9.5
      const fittedLabel = fitSvgText(safeLabel, w - 14, labelFontSize)
      const fittedSub = silkscreen ? fitSvgText(silkscreen, w - 14, subFontSize) : ''

      bodyFragments.push(`  <g id="${domId}" data-ak-key="${escapeXml(tile.id)}" data-ak-role="input">`)
      bodyFragments.push(
        `    <rect x="${fmt(x)}" y="${fmt(y)}" width="${fmt(w)}" height="${fmt(h)}" rx="${rx}" fill="${palette.fill}" stroke="${palette.stroke}" stroke-width="1.25" />`,
      )

      if (tile.mode === 'hold' && w >= 68) {
        const badgeW = 30
        const badgeX = x + w - badgeW - 6
        const badgeY = y + 6
        bodyFragments.push(
          `    <rect x="${fmt(badgeX)}" y="${fmt(badgeY)}" width="${badgeW}" height="13" rx="4" fill="${palette.badgeBg}" />`,
          `    <text x="${fmt(badgeX + badgeW / 2)}" y="${fmt(badgeY + 9.5)}" fill="${palette.labelFill}" font-size="7.5" font-weight="700" text-anchor="middle">HOLD</text>`,
        )
      }

      if (rowSpan === 2) {
        // Tall 1x2 strip or 2x2 hero pad: spacious centered hardware typography
        const spanTag = `${colSpan}×${rowSpan}`
        bodyFragments.push(
          `    <text x="${fmt(x + 9)}" y="${fmt(y + 16)}" fill="${palette.subFill}" font-size="8.5" font-weight="600" opacity="0.8">${spanTag}</text>`,
        )
        const mainY = fittedSub ? cy + 1 : cy + 5
        bodyFragments.push(
          `    <text x="${fmt(cx)}" y="${fmt(mainY)}" fill="${palette.labelFill}" font-size="${labelFontSize}" font-weight="650" text-anchor="middle">${escapeXml(fittedLabel)}</text>`,
        )
        if (fittedSub) {
          bodyFragments.push(
            `    <text x="${fmt(cx)}" y="${fmt(mainY + 18)}" fill="${palette.subFill}" font-size="${subFontSize}" text-anchor="middle">${escapeXml(fittedSub)}</text>`,
          )
        }
      } else if (fittedSub) {
        bodyFragments.push(
          `    <text x="${fmt(cx)}" y="${fmt(cy - 2)}" fill="${palette.labelFill}" font-size="${labelFontSize}" font-weight="600" text-anchor="middle">${escapeXml(fittedLabel)}</text>`,
          `    <text x="${fmt(cx)}" y="${fmt(cy + 13)}" fill="${palette.subFill}" font-size="${subFontSize}" text-anchor="middle">${escapeXml(fittedSub)}</text>`,
        )
      } else {
        bodyFragments.push(
          `    <text x="${fmt(cx)}" y="${fmt(cy + 4.5)}" fill="${palette.labelFill}" font-size="${labelFontSize}" font-weight="600" text-anchor="middle">${escapeXml(fittedLabel)}</text>`,
        )
      }

      bodyFragments.push(`  </g>`)

      inputRecords.push({
        id: tile.id,
        domId,
        label: safeLabel,
        short: deriveShortLabel(tile, safeLabel),
        icon: mapMobileIconToRemoteIcon(tile.icon, tile.id),
        anchorX: cx,
        anchorY: cy,
        regionPath: roundedRectPath(x, y, w, h, rx),
      })
    }

    const gridHeight = packed.totalRows * cellH + Math.max(0, packed.totalRows - 1) * gap
    cursorY += gridHeight
  })

  // Dedicated bottom Voice Key (mobile.voice)
  const voiceY = cursorY + 14
  const voiceH = 52
  const voiceRx = 15
  const voiceCx = contentX + contentWidth / 2
  const voiceCy = voiceY + voiceH / 2
  const voiceSummary = snapshot.voiceBindingSummary?.trim() ?? ''
  const voiceDisplayLabel = voiceSummary
    ? `语音键 · 按住说话 (${fitSvgText(voiceSummary, 72, 11)})`
    : '语音键 · 按住说话'

  bodyFragments.push(
    `  <g id="key-voice" data-ak-key="${VOICE_KEY_ID}" data-ak-role="input">`,
    `    <rect x="${contentX}" y="${fmt(voiceY)}" width="${contentWidth}" height="${voiceH}" rx="${voiceRx}" fill="url(#am-voice)" stroke="#2d6a7d" stroke-width="1.4" />`,
    `    <g transform="translate(${fmt(voiceSummary ? 68 : 96)} ${fmt(voiceY + 16)})" stroke="#5eead4" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">`,
    `      <rect x="5" y="1" width="6" height="10" rx="3" />`,
    `      <path d="M2 8.5a6 6 0 0 0 12 0" />`,
    `      <path d="M8 14.5v3.5" />`,
    `      <path d="M5.5 18h5" />`,
    `    </g>`,
    `    <text x="${fmt(voiceSummary ? 170 : 172)}" y="${fmt(voiceCy + 4.5)}" fill="#ccfbf1" font-size="12.5" font-weight="600" text-anchor="middle">${escapeXml(voiceDisplayLabel)}</text>`,
    `  </g>`,
  )

  inputRecords.push({
    id: VOICE_KEY_ID,
    domId: 'key-voice',
    label: '语音键（按住说话）',
    short: '语音',
    icon: 'mic',
    anchorX: voiceCx,
    anchorY: voiceCy,
    regionPath: roundedRectPath(contentX, voiceY, contentWidth, voiceH, voiceRx),
  })

  const homePillY = voiceY + voiceH + 12
  const totalHeight = Math.max(360, Math.ceil(homePillY + 24))
  const safePageName = selectedPage.name?.trim() || '自定义面板'

  const metadataInputsXml = inputRecords
    .map(
      (rec, index) =>
        `        <ak:input id="${escapeXml(rec.id)}" label="${escapeXml(rec.label)}" short="${escapeXml(rec.short)}" icon="${rec.icon}" kind="button" target="#${rec.domId}" order="${index + 1}">\n` +
        `          <ak:source report="mobile" engine="mobile-wss" />\n` +
        `        </ak:input>`,
    )
    .join('\n')

  const regionsXml = inputRecords
    .map(
      rec =>
        `    <path data-ak-region="${escapeXml(rec.id)}" data-ak-anchor="${fmt(rec.anchorX)} ${fmt(rec.anchorY)}" d="${rec.regionPath}" />`,
    )
    .join('\n')

  return [
    `<?xml version="1.0" encoding="UTF-8"?>`,
    `<svg xmlns="http://www.w3.org/2000/svg"`,
    `     xmlns:ak="urn:axonkey:device:1"`,
    `     width="320" height="${totalHeight}" viewBox="0 0 320 ${totalHeight}" fill="none"`,
    `     class="axonkey-mobile-svg"`,
    `     font-family="system-ui, -apple-system, 'Segoe UI', 'PingFang SC', 'Microsoft YaHei', sans-serif"`,
    `     role="img" aria-labelledby="axonkey-mobile-title axonkey-mobile-desc"`,
    `     data-ak-schema="axonkey.device/1"`,
    `     data-ak-device="axonkey.mobile"`,
    `     data-ak-revision="1">`,
    `  <title id="axonkey-mobile-title">Axonkey Mobile · ${escapeXml(safePageName)}</title>`,
    `  <desc id="axonkey-mobile-desc">手机端动态按键布局示意图（${escapeXml(safePageName)}）</desc>`,
    `  <metadata>`,
    `    <ak:device schema="axonkey.device/1" id="axonkey.mobile" revision="1"`,
    `               vendor="Axonkey" model="Axonkey Mobile" display-name="Axonkey Mobile · ${escapeXml(safePageName)}">`,
    `      <ak:identity>`,
    `        <ak:match transport="network" vendor-usb-hid="true" />`,
    `      </ak:identity>`,
    `      <ak:reports>`,
    `        <ak:report id="mobile" direction="input" encoding="vendor-state" engine="mobile-wss" />`,
    `      </ak:reports>`,
    `      <ak:inputs>`,
    metadataInputsXml,
    `      </ak:inputs>`,
    `      <ak:voice id="axonkey.mobile.mic" trigger-key="${VOICE_KEY_ID}" engine="axonkey-mobile.pcm" transport="network" trigger-modes="hold click" />`,
    `    </ak:device>`,
    `  </metadata>`,
    `  <defs>`,
    `    <linearGradient id="am-body" x1="0" y1="0" x2="0" y2="1">`,
    `      <stop offset="0%" stop-color="#22293a" />`,
    `      <stop offset="100%" stop-color="#111622" />`,
    `    </linearGradient>`,
    `    <linearGradient id="am-dpad-cap" x1="0" y1="0" x2="0" y2="1">`,
    `      <stop offset="0%" stop-color="#242e45" />`,
    `      <stop offset="100%" stop-color="#182032" />`,
    `    </linearGradient>`,
    `    <linearGradient id="am-ok" x1="0" y1="0" x2="0" y2="1">`,
    `      <stop offset="0%" stop-color="#2f5699" />`,
    `      <stop offset="100%" stop-color="#1d3561" />`,
    `    </linearGradient>`,
    `    <linearGradient id="am-pad" x1="0" y1="0" x2="0" y2="1">`,
    `      <stop offset="0%" stop-color="#151d2c" />`,
    `      <stop offset="100%" stop-color="#0f1522" />`,
    `    </linearGradient>`,
    `    <linearGradient id="am-voice" x1="0" y1="0" x2="1" y2="1">`,
    `      <stop offset="0%" stop-color="#143340" />`,
    `      <stop offset="50%" stop-color="#152b44" />`,
    `      <stop offset="100%" stop-color="#17243b" />`,
    `    </linearGradient>`,
    `  </defs>`,
    `  <rect x="14" y="8" width="292" height="${totalHeight - 16}" rx="34" fill="url(#am-body)" stroke="#3b4963" stroke-width="2" />`,
    `  <rect x="24" y="18" width="272" height="${totalHeight - 36}" rx="26" fill="#0d111a" stroke="#1e293b" stroke-width="1.2" />`,
    `  <rect x="128" y="25" width="64" height="5" rx="2.5" fill="#1e293b" />`,
    `  <text x="160" y="42" fill="#64748b" font-size="10" font-weight="600" text-anchor="middle">${escapeXml(fitSvgText(safePageName, 220, 10))}</text>`,
    ...bodyFragments,
    `  <rect x="124" y="${fmt(homePillY)}" width="72" height="4" rx="2" fill="#1e293b" />`,
    `  <g data-ak-regions="true" fill="transparent" pointer-events="none">`,
    regionsXml,
    `  </g>`,
    `</svg>`,
  ].join('\n')
}

export function buildDynamicMobileSupportPackage(snapshot: DeckSnapshot, targetPageId?: string): DeviceSupportPackage {
  const svg = synthesizeMobileDescriptorSvg(snapshot, targetPageId)
  return parseRuntimeDescriptorSvg(svg, {
    kind: 'axonkeyMobile',
    name: 'Axonkey Mobile',
    model: 'Axonkey Mobile',
  }).supportPackage
}
