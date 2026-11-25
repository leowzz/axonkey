import type { RemoteButton } from '../../appTypes'
import { parseRuntimeDescriptorSvg } from '../shared/descriptorSvg.ts'
import type { DeviceSupportPackage } from '../types.ts'

export type TileMode = 'gesture' | 'hold'
export type TileAccent = 'slate' | 'blue' | 'emerald' | 'amber' | 'rose' | 'violet'
export type PageLayout = 'remote' | 'grid'
export type DeckZoneKind = 'bento-grid' | 'dpad-3x3' | 'pointer-pad' | 'gesture-pad'
export type EmbeddedPointerMode = 'trackpad' | 'relative'
export type EmbeddedPadHeight = 'compact' | 'standard' | 'tall'
export type StarterPresetId = 'daily-remote' | 'vibe-coding' | 'presentation-media' | 'blank-canvas'
export type VoicePresetKind = 'doubao-alt' | 'system-win-h' | 'ctrl-win' | 'pure-mic'

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
  padHeight?: EmbeddedPadHeight
  showButtons?: boolean
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
const CLASSIC_RING_SLOTS = [
  '',
  'remote.up',
  '',
  'remote.left',
  'remote.ok',
  'remote.right',
  '',
  'remote.down',
  '',
] as const
const CLASSIC_MEDIA_IDS = ['remote.back', 'remote.mute', 'remote.vol_down', 'remote.vol_up'] as const
const DPAD_CORNER_INDICES = [0, 2, 6, 8] as const
const DPAD_CARDINAL_INDICES = [1, 3, 4, 5, 7] as const

// Plan B Monolithic Machined Space-Gray Keycap Tokens (Zero Rainbow Soup)
const KEYCAP_FILL = '#1f2025'
const KEYCAP_ELEVATED_FILL = '#272930'
const KEYCAP_STROKE = '#2e3038'
const KEYCAP_ELEVATED_STROKE = '#3a3d47'
const WELL_FILL = '#191a1f'
const WELL_STROKE = '#25272e'
const INK_PRIMARY = '#f2f2f7'
const INK_SECONDARY = '#8e8e93'
const INK_MUTED = '#58585e'

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
    const zones: MobileDeckZone[] = []

    page.zones.forEach((zone, idx) => {
      const zoneId = zone.id?.trim() || `${page.id}-zone-${idx + 1}`
      const kind: DeckZoneKind =
        zone.kind === 'dpad-3x3' ||
        zone.kind === 'pointer-pad' ||
        zone.kind === 'gesture-pad' ||
        zone.kind === 'bento-grid'
          ? zone.kind
          : 'bento-grid'
      const rawTileIds = Array.isArray(zone.tileIds)
        ? zone.tileIds.map(id => (typeof id === 'string' ? id.trim() : ''))
        : []

      if (kind === 'dpad-3x3') {
        const ringSlots = [
          '',
          rawTileIds[1] ?? '',
          '',
          rawTileIds[3] ?? '',
          rawTileIds[4] ?? '',
          rawTileIds[5] ?? '',
          '',
          rawTileIds[7] ?? '',
          '',
        ]
        const inRing = new Set(ringSlots.filter(Boolean))
        const rescuedCorners: string[] = []
        for (const cornerIdx of DPAD_CORNER_INDICES) {
          const cid = rawTileIds[cornerIdx] ?? ''
          if (cid && tileIdSet.has(cid) && !inRing.has(cid) && !rescuedCorners.includes(cid)) {
            rescuedCorners.push(cid)
          }
        }

        zones.push({
          id: zoneId,
          kind: 'dpad-3x3',
          tileIds: ringSlots,
        })

        if (rescuedCorners.length > 0) {
          const cornerCols = rescuedCorners.length === 4 ? 4 : rescuedCorners.length === 3 ? 3 : 2
          zones.push({
            id: `${zoneId}-corners`,
            kind: 'bento-grid',
            columns: cornerCols,
            tileIds: rescuedCorners,
          })
        }
        return
      }

      zones.push({
        id: zoneId,
        kind,
        ...(zone.columns !== undefined ? { columns: clampColumns(zone.columns) } : {}),
        ...(zone.pointerMode !== undefined ? { pointerMode: zone.pointerMode } : {}),
        ...(zone.padHeight === 'compact' || zone.padHeight === 'standard' || zone.padHeight === 'tall'
          ? { padHeight: zone.padHeight }
          : {}),
        ...(typeof zone.showButtons === 'boolean' ? { showButtons: zone.showButtons } : {}),
        tileIds: rawTileIds,
      })
    })

    const referenced = new Set<string>()
    for (const zone of zones) {
      if (zone.kind === 'pointer-pad') continue
      const limit = zone.kind === 'dpad-3x3' ? 9 : zone.kind === 'gesture-pad' ? 6 : zone.tileIds.length
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
    const ringSlots = CLASSIC_RING_SLOTS.map(id => (id && tileIdSet.has(id) ? id : ''))
    const hasRingTiles = ringSlots.some(Boolean)
    const mediaIds = CLASSIC_MEDIA_IDS.filter(id => tileIdSet.has(id))
    const used = new Set<string>([...topIds, ...ringSlots.filter(Boolean), ...mediaIds])
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
    if (hasRingTiles) {
      synthesized.push({
        id: `${page.id}-dpad`,
        kind: 'dpad-3x3',
        tileIds: ringSlots,
      })
    }
    if (mediaIds.length > 0) {
      synthesized.push({
        id: `${page.id}-media`,
        kind: 'bento-grid',
        columns: mediaIds.length === 4 ? 4 : mediaIds.length === 3 ? 3 : 2,
        tileIds: [...mediaIds],
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

function circlePath(cx: number, cy: number, r: number): string {
  return `M ${fmt(cx - r)} ${fmt(cy)} A ${fmt(r)} ${fmt(r)} 0 1 1 ${fmt(cx + r)} ${fmt(cy)} A ${fmt(r)} ${fmt(r)} 0 1 1 ${fmt(cx - r)} ${fmt(cy)} Z`
}

function annularSectorPath(
  cx: number,
  cy: number,
  rInner: number,
  rOuter: number,
  startDeg: number,
  endDeg: number,
): string {
  const toRad = (deg: number) => (deg * Math.PI) / 180
  const a1 = toRad(startDeg)
  const a2 = toRad(endDeg)
  const x1Out = cx + rOuter * Math.cos(a1)
  const y1Out = cy + rOuter * Math.sin(a1)
  const x2Out = cx + rOuter * Math.cos(a2)
  const y2Out = cy + rOuter * Math.sin(a2)
  const x2In = cx + rInner * Math.cos(a2)
  const y2In = cy + rInner * Math.sin(a2)
  const x1In = cx + rInner * Math.cos(a1)
  const y1In = cy + rInner * Math.sin(a1)
  const largeArc = Math.abs(endDeg - startDeg) > 180 ? 1 : 0
  return `M ${fmt(x1Out)} ${fmt(y1Out)} A ${fmt(rOuter)} ${fmt(rOuter)} 0 ${largeArc} 1 ${fmt(x2Out)} ${fmt(y2Out)} L ${fmt(x2In)} ${fmt(y2In)} A ${fmt(rInner)} ${fmt(rInner)} 0 ${largeArc} 0 ${fmt(x1In)} ${fmt(y1In)} Z`
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
  let cursorY = 50

  const isClassicRemote = selectedPage.layout === 'remote' || selectedPage.id === 'classic-remote'

  zones.forEach((zone, zoneIdx) => {
    if (zoneIdx > 0) cursorY += zoneGap

    if (zone.kind === 'pointer-pad') {
      const showButtons = zone.showButtons !== false
      const padH = zone.padHeight === 'compact' ? 96 : zone.padHeight === 'tall' ? 164 : 124
      const innerH = showButtons ? padH - 36 : padH - 16
      const innerCenterY = cursorY + 8 + innerH / 2
      const cx = contentX + contentWidth / 2
      bodyFragments.push(
        `  <g class="am-pointer-pad">`,
        `    <rect x="${contentX}" y="${fmt(cursorY)}" width="${contentWidth}" height="${padH}" rx="18" fill="${WELL_FILL}" stroke="${WELL_STROKE}" stroke-width="1.2" />`,
      )
      if (zone.pointerMode === 'relative') {
        bodyFragments.push(
          `    <text x="${fmt(cx)}" y="${fmt(innerCenterY + 4)}" fill="${INK_SECONDARY}" font-size="11.5" font-weight="500" text-anchor="middle">按住移鼠</text>`,
        )
      } else {
        bodyFragments.push(
          `    <line x1="${fmt(cx - 8)}" y1="${fmt(innerCenterY)}" x2="${fmt(cx + 8)}" y2="${fmt(innerCenterY)}" stroke="${INK_MUTED}" stroke-width="1.2" opacity="0.45" />`,
          `    <line x1="${fmt(cx)}" y1="${fmt(innerCenterY - 8)}" x2="${fmt(cx)}" y2="${fmt(innerCenterY + 8)}" stroke="${INK_MUTED}" stroke-width="1.2" opacity="0.45" />`,
        )
      }
      if (showButtons) {
        bodyFragments.push(
          `    <line x1="${contentX + 14}" y1="${fmt(cursorY + padH - 24)}" x2="${contentX + contentWidth - 14}" y2="${fmt(cursorY + padH - 24)}" stroke="${WELL_STROKE}" stroke-width="1" />`,
          `    <line x1="${fmt(cx)}" y1="${fmt(cursorY + padH - 21)}" x2="${fmt(cx)}" y2="${fmt(cursorY + padH - 7)}" stroke="${WELL_STROKE}" stroke-width="1" />`,
          `    <text x="${fmt(contentX + contentWidth * 0.26)}" y="${fmt(cursorY + padH - 10)}" fill="${INK_SECONDARY}" font-size="9.5" text-anchor="middle">左键</text>`,
          `    <text x="${fmt(contentX + contentWidth * 0.74)}" y="${fmt(cursorY + padH - 10)}" fill="${INK_SECONDARY}" font-size="9.5" text-anchor="middle">右键</text>`,
        )
      }
      bodyFragments.push(`  </g>`)
      cursorY += padH
      return
    }

    if (zone.kind === 'gesture-pad') {
      const wellX = 32
      const wellW = 256
      const rowH = zone.padHeight === 'compact' ? 40 : zone.padHeight === 'tall' ? 52 : 46
      const rowGap = 6
      const topPad = 24
      const yUp = cursorY + topPad
      const yMid = yUp + rowH + rowGap
      const yDown = yMid + rowH + rowGap
      const yTap = yDown + rowH + 8
      const wellH = topPad + rowH * 4 + rowGap * 2 + 8 + 10
      const rx = 12
      const compassCy = yMid + rowH / 2

      const slotSpecs: ReadonlyArray<{
        slot: number
        defaultLabel: string
        glyph: string
        fallbackIcon: RemoteButton['icon']
        x: number
        y: number
        w: number
        h: number
      }> = [
        { slot: 0, defaultLabel: '上滑', glyph: '↑', fallbackIcon: 'up', x: 84, y: yUp, w: 152, h: rowH },
        { slot: 1, defaultLabel: '下滑', glyph: '↓', fallbackIcon: 'down', x: 84, y: yDown, w: 152, h: rowH },
        { slot: 2, defaultLabel: '左滑', glyph: '←', fallbackIcon: 'left', x: 40, y: yMid, w: 98, h: rowH },
        { slot: 3, defaultLabel: '右滑', glyph: '→', fallbackIcon: 'right', x: 182, y: yMid, w: 98, h: rowH },
        { slot: 4, defaultLabel: '轻点', glyph: '●', fallbackIcon: 'locate', x: 40, y: yTap, w: 116, h: rowH },
        { slot: 5, defaultLabel: '双击', glyph: '◎', fallbackIcon: 'center', x: 164, y: yTap, w: 116, h: rowH },
      ]

      bodyFragments.push(
        `  <g class="am-gesture-pad">`,
        `    <rect x="${wellX}" y="${fmt(cursorY)}" width="${wellW}" height="${fmt(wellH)}" rx="20" fill="${WELL_FILL}" stroke="${WELL_STROKE}" stroke-width="1.2" />`,
        `    <text x="160" y="${fmt(cursorY + 16)}" fill="${INK_SECONDARY}" font-size="9.5" font-weight="500" text-anchor="middle">手势垫</text>`,
        `    <circle cx="160" cy="${fmt(compassCy)}" r="12" fill="#141518" stroke="${KEYCAP_STROKE}" stroke-width="1" />`,
        `    <circle cx="160" cy="${fmt(compassCy)}" r="2.5" fill="${INK_MUTED}" />`,
        `  </g>`,
      )

      for (const spec of slotSpecs) {
        const { slot, defaultLabel, glyph, fallbackIcon, x, y, w, h } = spec
        const cx = x + w / 2
        const cy = y + h / 2
        const rawId = zone.tileIds[slot]?.trim() ?? ''
        const tile = rawId ? tileById.get(rawId) : undefined

        if (!tile || renderedInputIds.has(tile.id)) {
          bodyFragments.push(
            `  <g class="am-gesture-slot-empty">`,
            `    <rect x="${fmt(x)}" y="${fmt(y)}" width="${fmt(w)}" height="${fmt(h)}" rx="${rx}" fill="#16171b" stroke="${WELL_STROKE}" stroke-width="1" stroke-dasharray="3 3" opacity="0.65" />`,
            `    <text x="${fmt(cx)}" y="${fmt(cy + 4)}" fill="${INK_MUTED}" font-size="10.5" text-anchor="middle">${escapeXml(`${glyph} ${defaultLabel}`)}</text>`,
            `  </g>`,
          )
          continue
        }

        renderedInputIds.add(tile.id)
        const domId = sanitizeDomId(tile.id, usedDomIds)
        const rawLabel = tile.label?.trim() || defaultLabel
        const capTitle = `${glyph} ${rawLabel}`
        const silkscreen = (tile.actionSummary?.trim() || tile.subtitle?.trim() || '').trim()
        const fittedTitle = fitSvgText(capTitle, w - 12, 11.5)
        const fittedSub = silkscreen ? fitSvgText(silkscreen, w - 12, 9) : ''

        bodyFragments.push(`  <g id="${domId}" data-ak-key="${escapeXml(tile.id)}" data-ak-role="input">`)
        bodyFragments.push(
          `    <rect x="${fmt(x)}" y="${fmt(y)}" width="${fmt(w)}" height="${fmt(h)}" rx="${rx}" fill="${KEYCAP_FILL}" stroke="${KEYCAP_STROKE}" stroke-width="1.15" />`,
        )
        if (fittedSub) {
          bodyFragments.push(
            `    <text x="${fmt(cx)}" y="${fmt(cy - 2)}" fill="${INK_PRIMARY}" font-size="11.5" font-weight="600" text-anchor="middle">${escapeXml(fittedTitle)}</text>`,
            `    <text x="${fmt(cx)}" y="${fmt(cy + 12)}" fill="${INK_SECONDARY}" font-size="9" text-anchor="middle">${escapeXml(fittedSub)}</text>`,
          )
        } else {
          bodyFragments.push(
            `    <text x="${fmt(cx)}" y="${fmt(cy + 4)}" fill="${INK_PRIMARY}" font-size="11.5" font-weight="600" text-anchor="middle">${escapeXml(fittedTitle)}</text>`,
          )
        }
        bodyFragments.push(`  </g>`)

        const inputLabel =
          rawLabel === defaultLabel ? `手势垫 · ${defaultLabel}` : `手势垫 · ${defaultLabel}（${rawLabel}）`
        const mappedIcon = tile.icon?.trim() ? mapMobileIconToRemoteIcon(tile.icon, tile.id) : fallbackIcon
        inputRecords.push({
          id: tile.id,
          domId,
          label: inputLabel,
          short: defaultLabel,
          icon: mappedIcon,
          anchorX: cx,
          anchorY: cy,
          regionPath: roundedRectPath(x, y, w, h, rx),
        })
      }

      cursorY += wellH
      return
    }

    if (zone.kind === 'dpad-3x3') {
      // Plan B Concentric Circular Tactile Clickpad Ring (触控圆盘)
      const ringBlockH = 196
      const cx = 160
      const cy = cursorY + ringBlockH / 2
      const outerR = 88
      const innerOkR = 36
      const sectorRIn = 42
      const sectorROut = 85
      const rMid = (sectorRIn + sectorROut) / 2 // 63.5

      bodyFragments.push(
        `  <g class="am-clickpad-ring">`,
        `    <circle cx="${cx}" cy="${fmt(cy)}" r="92" fill="${WELL_FILL}" stroke="${WELL_STROKE}" stroke-width="1.2" />`,
        `    <circle cx="${cx}" cy="${fmt(cy)}" r="${outerR}" fill="url(#am-ring)" stroke="${KEYCAP_ELEVATED_STROKE}" stroke-width="1.4" />`,
        `    <circle cx="${cx}" cy="${fmt(cy)}" r="40" fill="#141518" stroke="${KEYCAP_STROKE}" stroke-width="1" />`,
        `  </g>`,
      )

      for (const slot of DPAD_CARDINAL_INDICES) {
        const rawId = zone.tileIds[slot]?.trim() ?? ''
        const tile = rawId ? tileById.get(rawId) : undefined

        if (slot === 4) {
          // Center Concave Confirm Circle
          if (!tile || renderedInputIds.has(tile.id)) {
            bodyFragments.push(
              `  <circle cx="${cx}" cy="${fmt(cy)}" r="${innerOkR}" fill="${KEYCAP_FILL}" stroke="${KEYCAP_STROKE}" stroke-width="1.2" />`,
            )
            continue
          }
          renderedInputIds.add(tile.id)
          const domId = sanitizeDomId(tile.id, usedDomIds)
          const safeLabel = tile.label?.trim() || '确定'
          const centerTitle =
            tile.id === 'remote.ok' && (safeLabel === '确认' || safeLabel === '确定')
              ? 'OK'
              : fitSvgText(safeLabel, 54, 12.5)
          const fontSize = centerTitle === 'OK' ? '14.5' : '12'

          bodyFragments.push(
            `  <g id="${domId}" data-ak-key="${escapeXml(tile.id)}" data-ak-role="input">`,
            `    <circle cx="${cx}" cy="${fmt(cy)}" r="${innerOkR}" fill="url(#am-ok)" stroke="${KEYCAP_ELEVATED_STROKE}" stroke-width="1.4" />`,
            `    <text x="${cx}" y="${fmt(cy + 5)}" fill="${INK_PRIMARY}" font-size="${fontSize}" font-weight="650" text-anchor="middle">${escapeXml(centerTitle)}</text>`,
            `  </g>`,
          )

          inputRecords.push({
            id: tile.id,
            domId,
            label: safeLabel,
            short: deriveShortLabel(tile, safeLabel),
            icon: mapMobileIconToRemoteIcon(tile.icon, tile.id),
            anchorX: cx,
            anchorY: cy,
            regionPath: circlePath(cx, cy, innerOkR),
          })
          continue
        }

        // 4 Cardinal Quadrants on the Outer Ring
        const spec =
          slot === 1
            ? { startDeg: -131, endDeg: -49, ax: cx, ay: cy - rMid }
            : slot === 3
              ? { startDeg: 139, endDeg: 221, ax: cx - rMid, ay: cy }
              : slot === 5
                ? { startDeg: -41, endDeg: 41, ax: cx + rMid, ay: cy }
                : { startDeg: 49, endDeg: 131, ax: cx, ay: cy + rMid }

        const chevronPath =
          slot === 1
            ? `M ${fmt(spec.ax - 5.5)} ${fmt(spec.ay + 2.5)} L ${fmt(spec.ax)} ${fmt(spec.ay - 3)} L ${fmt(spec.ax + 5.5)} ${fmt(spec.ay + 2.5)}`
            : slot === 7
              ? `M ${fmt(spec.ax - 5.5)} ${fmt(spec.ay - 2.5)} L ${fmt(spec.ax)} ${fmt(spec.ay + 3)} L ${fmt(spec.ax + 5.5)} ${fmt(spec.ay - 2.5)}`
              : slot === 3
                ? `M ${fmt(spec.ax + 2.5)} ${fmt(spec.ay - 5.5)} L ${fmt(spec.ax - 3)} ${fmt(spec.ay)} L ${fmt(spec.ax + 2.5)} ${fmt(spec.ay + 5.5)}`
                : `M ${fmt(spec.ax - 2.5)} ${fmt(spec.ay - 5.5)} L ${fmt(spec.ax + 3)} ${fmt(spec.ay)} L ${fmt(spec.ax - 2.5)} ${fmt(spec.ay + 5.5)}`

        if (!tile || renderedInputIds.has(tile.id)) {
          bodyFragments.push(
            `  <path d="${chevronPath}" stroke="${INK_MUTED}" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" opacity="0.45" />`,
          )
          continue
        }

        renderedInputIds.add(tile.id)
        const domId = sanitizeDomId(tile.id, usedDomIds)
        const safeLabel = tile.label?.trim() || tile.id
        const regionPath = annularSectorPath(cx, cy, sectorRIn, sectorROut, spec.startDeg, spec.endDeg)

        bodyFragments.push(
          `  <g id="${domId}" data-ak-key="${escapeXml(tile.id)}" data-ak-role="input">`,
          `    <path d="${regionPath}" fill="transparent" />`,
          `    <path d="${chevronPath}" stroke="${INK_PRIMARY}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" />`,
          `  </g>`,
        )

        inputRecords.push({
          id: tile.id,
          domId,
          label: safeLabel,
          short: deriveShortLabel(tile, safeLabel),
          icon: mapMobileIconToRemoteIcon(tile.icon, tile.id),
          anchorX: spec.ax,
          anchorY: spec.ay,
          regionPath,
        })
      }

      cursorY += ringBlockH
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
      const emptyH = 64
      const cx = contentX + contentWidth / 2
      bodyFragments.push(
        `  <g class="am-empty-grid">`,
        `    <rect x="${contentX}" y="${fmt(cursorY)}" width="${contentWidth}" height="${emptyH}" rx="14" fill="${WELL_FILL}" stroke="${WELL_STROKE}" stroke-width="1.1" stroke-dasharray="4 4" />`,
        `    <text x="${fmt(cx)}" y="${fmt(cursorY + 36)}" fill="${INK_SECONDARY}" font-size="11" text-anchor="middle">空白按键网格</text>`,
        `  </g>`,
      )
      cursorY += emptyH
      return
    }

    const packed = packBentoTiles(zoneTiles, cols)
    const gap = 8
    const cellW = (contentWidth - gap * (cols - 1)) / cols
    const isCompactRow = isClassicRemote && packed.totalRows === 1 && (zoneIdx === 0 || cols === 4)
    const cellH = isCompactRow ? 46 : 56
    const rx = isCompactRow ? 12 : 14

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
      const labelFontSize = rowSpan === 2 && colSpan === 2 ? 13.5 : cols === 4 && colSpan === 1 ? 11 : 12
      const fittedLabel = fitSvgText(safeLabel, w - 12, labelFontSize)

      bodyFragments.push(
        `  <g id="${domId}" data-ak-key="${escapeXml(tile.id)}" data-ak-role="input">`,
        `    <rect x="${fmt(x)}" y="${fmt(y)}" width="${fmt(w)}" height="${fmt(h)}" rx="${rx}" fill="${KEYCAP_FILL}" stroke="${KEYCAP_STROKE}" stroke-width="1.15" />`,
        `    <text x="${fmt(cx)}" y="${fmt(cy + 4.5)}" fill="${INK_PRIMARY}" font-size="${labelFontSize}" font-weight="600" text-anchor="middle">${escapeXml(fittedLabel)}</text>`,
        `  </g>`,
      )

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

  // Dedicated bottom Voice Key (mobile.voice) — calm Plan B elevated pill, zero technical jargon
  const voiceY = cursorY + 14
  const voiceH = 50
  const voiceRx = 15
  const voiceCx = contentX + contentWidth / 2
  const voiceCy = voiceY + voiceH / 2

  bodyFragments.push(
    `  <g id="key-voice" data-ak-key="${VOICE_KEY_ID}" data-ak-role="input">`,
    `    <rect x="${contentX}" y="${fmt(voiceY)}" width="${contentWidth}" height="${voiceH}" rx="${voiceRx}" fill="${KEYCAP_ELEVATED_FILL}" stroke="${KEYCAP_ELEVATED_STROKE}" stroke-width="1.3" />`,
    `    <g transform="translate(114 ${fmt(voiceY + 15)})" stroke="${INK_PRIMARY}" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">`,
    `      <rect x="5" y="1" width="6" height="10" rx="3" />`,
    `      <path d="M2 8.5a6 6 0 0 0 12 0" />`,
    `      <path d="M8 14.5v3.5" />`,
    `      <path d="M5.5 18h5" />`,
    `    </g>`,
    `    <text x="168" y="${fmt(voiceCy + 4.5)}" fill="${INK_PRIMARY}" font-size="12.5" font-weight="600" text-anchor="middle">按住说话</text>`,
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
    `      <stop offset="0%" stop-color="#272930" />`,
    `      <stop offset="100%" stop-color="#18191e" />`,
    `    </linearGradient>`,
    `    <linearGradient id="am-ring" x1="0" y1="0" x2="0" y2="1">`,
    `      <stop offset="0%" stop-color="#25272f" />`,
    `      <stop offset="100%" stop-color="#1c1d23" />`,
    `    </linearGradient>`,
    `    <linearGradient id="am-ok" x1="0" y1="0" x2="0" y2="1">`,
    `      <stop offset="0%" stop-color="#2d3039" />`,
    `      <stop offset="100%" stop-color="#21232a" />`,
    `    </linearGradient>`,
    `  </defs>`,
    `  <rect x="14" y="8" width="292" height="${totalHeight - 16}" rx="34" fill="url(#am-body)" stroke="#383b44" stroke-width="1.8" />`,
    `  <rect x="24" y="18" width="272" height="${totalHeight - 36}" rx="26" fill="#141518" stroke="#22242b" stroke-width="1.2" />`,
    `  <rect x="128" y="25" width="64" height="5" rx="2.5" fill="#272930" />`,
    `  <text x="160" y="41" fill="${INK_SECONDARY}" font-size="10" font-weight="500" text-anchor="middle">${escapeXml(fitSvgText(safePageName, 220, 10))}</text>`,
    ...bodyFragments,
    `  <rect x="124" y="${fmt(homePillY)}" width="72" height="4" rx="2" fill="#272930" />`,
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
