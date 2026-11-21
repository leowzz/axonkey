import type { MappingInput, Platform } from '../appTypes.ts'
import { triggerTypes } from '../behaviorModel.ts'
import type { Behavior, TriggerBehaviors, TriggerType } from '../behaviorModel.ts'
import { behaviorSummary, keyDisplayName, textAndEnterValue, triggerLabels } from '../behaviorSummary.ts'
import { macosShortcutPresets } from '../macosShortcutPresets.ts'
import { mouseInputIds, mouseInputParts } from '../devices/index.ts'
import type { MouseControlId, MouseInputId } from '../devices/index.ts'
import { packageFor } from '../devices/integration/model.ts'
import { tryParseRuntimeDescriptorSvg } from '../devices/shared/descriptorSvg.ts'
import type { DeviceSupportPackage, RemoteKeyRegion, RemoteView } from '../devices/types.ts'

export type QuickOverlaySessionPayload = {
  revision: number
  sourceId: string
  deviceKind: string
  deviceName: string
  profileId: string
  profileName: string
  triggerInput: string
  behaviors: Record<string, unknown> | null
  pressed: string[]
  preview: boolean
  promptMode?: boolean
  descriptorSvg?: string | null
}

export type QuickOverlayTriggerPreview = {
  trigger: TriggerType
  triggerLabel: string
  showTriggerTag: boolean
  kind: 'prompt' | 'action' | 'sequence'
  badge?: string
  title?: string
  autoEnter?: boolean
  inputMethod?: 'paste' | 'typeText'
  text: string
  stepsSummary?: string
}

export type QuickOverlayCardItem = {
  inputId: string
  label: string
  contextLabel?: string
  short?: string
  icon: MappingInput['icon']
  triggers: QuickOverlayTriggerPreview[]
}

export type QuickOverlayScopedEntry = {
  inputId: string
  contextLabel?: string
  isExitTrigger: boolean
  triggers: QuickOverlayTriggerPreview[]
}

export type QuickOverlayKeySlot = {
  slotId: string
  inputId: string
  label: string
  short: string
  icon: MappingInput['icon']
  status: 'configured' | 'trigger' | 'idle'
  primaryKind?: 'prompt' | 'action' | 'sequence'
  contextLabel?: string
  triggers: QuickOverlayTriggerPreview[]
  scopedEntries?: QuickOverlayScopedEntry[]
}

export type QuickOverlayCrossWell = {
  kind: 'cross'
  up?: QuickOverlayKeySlot
  down?: QuickOverlayKeySlot
  left?: QuickOverlayKeySlot
  right?: QuickOverlayKeySlot
  center?: QuickOverlayKeySlot
}

export type QuickOverlayBridgeBlock = {
  kind: 'bridge'
  leftStack: [QuickOverlayKeySlot, QuickOverlayKeySlot]
  center: QuickOverlayKeySlot
  rightStack: [QuickOverlayKeySlot, QuickOverlayKeySlot]
}

export type QuickOverlayRowBlock = {
  kind: 'row'
  columns: 1 | 2 | 3 | 4 | 5
  align?: 'left' | 'center' | 'right'
  slots: QuickOverlayKeySlot[]
}

export type QuickOverlaySurfaceBlock = QuickOverlayRowBlock | QuickOverlayCrossWell | QuickOverlayBridgeBlock

type QuickOverlaySideRail = { side: 'left' | 'right'; slots: QuickOverlayKeySlot[] }

export type QuickOverlaySurfaceLayout =
  | {
      variant: 'matrix'
      rows: number
      cols: number
      oledSpan?: { row: number; colStart: number; colSpan: number }
      cells: (QuickOverlayKeySlot & { row: number; col: number; rowSpan?: number; colSpan?: number })[]
      sideRail?: QuickOverlaySideRail
    }
  | {
      variant: 'controller'
      leftShoulders: QuickOverlayKeySlot[]
      rightShoulders: QuickOverlayKeySlot[]
      centerRow: QuickOverlayKeySlot[]
      leftPod: QuickOverlaySurfaceBlock[]
      rightPod: QuickOverlaySurfaceBlock[]
    }
  | {
      variant: 'mouse'
      thumbStack: QuickOverlayKeySlot[]
      primaryPair: [QuickOverlayKeySlot, QuickOverlayKeySlot]
      wheelWell: QuickOverlayCrossWell
    }
  | {
      variant: 'panel'
      density: 'spacious' | 'regular' | 'compact'
      blocks: QuickOverlaySurfaceBlock[]
      sideRail?: QuickOverlaySideRail
    }

export type QuickOverlayViewModel = {
  isMouse: boolean
  promptMode: boolean
  deviceName: string
  profileName: string
  triggerInputId: string
  triggerLabel: string | null
  mappedIds: string[]
  pressedIds: string[]
  items: QuickOverlayCardItem[]
  surface: QuickOverlaySurfaceLayout
}

type PositionedSlot = {
  slot: QuickOverlayKeySlot
  nx: number
  ny: number
  kindTag: string
  order: number
  bounds?: { left: number; top: number; width: number; height: number }
}

const parsedSessionSvgCache = new Map<string, DeviceSupportPackage>()

function resolveSessionPackage(session: QuickOverlaySessionPayload): DeviceSupportPackage {
  const inlineSvg = typeof session.descriptorSvg === 'string' ? session.descriptorSvg.trim() : ''
  if (inlineSvg) {
    const cacheKey = `${session.deviceKind}\0${inlineSvg}`
    const cached = parsedSessionSvgCache.get(cacheKey)
    if (cached) return cached
    const parsed = tryParseRuntimeDescriptorSvg(inlineSvg, {
      kind: session.deviceKind,
      name: session.deviceName,
    })
    if (parsed) {
      if (parsedSessionSvgCache.size >= 32) {
        const firstKey = parsedSessionSvgCache.keys().next().value
        if (firstKey !== undefined) parsedSessionSvgCache.delete(firstKey)
      }
      parsedSessionSvgCache.set(cacheKey, parsed.supportPackage)
      return parsed.supportPackage
    }
  }
  return packageFor(session.deviceKind)
}

const mouseOverlayInputs: MappingInput<string>[] = mouseInputIds.map(id => {
  const { scope, control } = mouseInputParts(id)
  return {
    id,
    label: control.label,
    icon: control.icon,
    contextLabel: scope.id === 'global' ? undefined : scope.label,
    triggerLabel: control.kind === 'wheel' ? '滚动' : undefined,
  }
})

function coerceBehaviorList(raw: unknown): Behavior[] {
  if (!Array.isArray(raw)) return []
  return raw
    .filter((item): item is Behavior => Boolean(item && typeof item === 'object' && 'type' in item))
    .map(item => ({
      ...item,
      enabled: item.enabled !== false,
    }))
}

function coerceTriggerBehaviors(raw: unknown): TriggerBehaviors {
  if (!raw || typeof raw !== 'object') return { click: [], doubleClick: [], longPress: [] }
  const record = raw as Record<string, unknown>
  return {
    click: coerceBehaviorList(record.click),
    doubleClick: coerceBehaviorList(record.doubleClick),
    longPress: coerceBehaviorList(record.longPress),
  }
}

function resolveCanonicalInputId(rawKey: string, deviceKind: string, pkg: DeviceSupportPackage | null): string {
  const trimmed = rawKey.trim()
  if (!trimmed || deviceKind === 'mouse' || !pkg) return trimmed
  if (pkg.inputs.some(input => input.id === trimmed)) return trimmed
  const matchedButton = pkg.remoteView?.buttons.find(
    button => button.id === trimmed || (button as { rawId?: string }).rawId === trimmed,
  )
  if (matchedButton) return matchedButton.id
  const suffixMatch = pkg.inputs.find(input => trimmed.endsWith(`.${input.id}`))
  return suffixMatch ? suffixMatch.id : trimmed
}

const conciseHudKeyMap: Record<string, string> = {
  Esc: 'Esc',
  Tab: 'Tab',
  Enter: 'Enter',
  Return: 'Enter',
  Space: 'Space',
  Backspace: 'Backspace',
  Delete: 'Delete',
  '[': '[',
  ']': ']',
  '\\': '\\',
  ';': ';',
  "'": "'",
  ',': ',',
  '.': '.',
  '/': '/',
  '-': '-',
  '=': '=',
  '`': '`',
}

function compactKeyName(key: string, platform: Platform): string {
  if (conciseHudKeyMap[key]) return conciseHudKeyMap[key]
  return keyDisplayName(key, platform)
}

function compactActionText(step: Behavior, platform: Platform): string {
  if (step.type === 'key') {
    return step.key ? compactKeyName(step.key, platform) : '未录入'
  }
  if (step.type === 'shortcut') {
    const preset = macosShortcutPresets(platform).find(
      ({ keys }) => keys.length === step.keys.length && keys.every((key, index) => key === step.keys[index]),
    )
    return preset?.name ?? (step.keys.map(key => compactKeyName(key, platform)).join(' + ') || '未录入')
  }
  if (step.type === 'cursorMove') {
    const dir = { up: '光标上移', down: '光标下移', left: '光标左移', right: '光标右移' }[step.direction]
    return `${dir} ${step.distance}px`
  }
  if (step.type === 'openPath') {
    const base = step.path
      .replace(/[\\/]+$/, '')
      .split(/[\\/]/)
      .pop()
    return base ? `打开 ${base}` : behaviorSummary(step, platform)
  }
  if (step.type === 'openApp') {
    const base = step.path
      .replace(/[\\/]+$/, '')
      .split(/[\\/]/)
      .pop()
      ?.replace(/\.(?:app|exe|lnk|com)$/i, '')
    return base ? `打开 ${base}` : behaviorSummary(step, platform)
  }
  if (step.type === 'openWebsite') {
    try {
      const parsed = new URL(step.url)
      const cleanPath = parsed.pathname === '/' ? '' : parsed.pathname.slice(0, 18)
      return `打开 ${parsed.host}${cleanPath}`
    } catch {
      return behaviorSummary(step, platform)
    }
  }
  if (step.type === 'copyText') {
    if (step.title) return `复制：${step.title}`
    return step.text ? `复制：${step.text.slice(0, 14)}` : '写入剪贴板'
  }
  if (step.type === 'runCommand') {
    if (step.title) return step.title
    return step.command ? `命令：${step.command.slice(0, 18)}` : '执行命令'
  }
  if (step.type === 'httpRequest') {
    if (step.title) return `${step.method} ${step.title}`
    try {
      const parsed = new URL(step.url)
      const cleanPath = parsed.pathname === '/' ? '' : parsed.pathname.slice(0, 14)
      return `${step.method} ${parsed.host}${cleanPath}`
    } catch {
      return behaviorSummary(step, platform)
    }
  }
  return behaviorSummary(step, platform)
}

export function summarizeQuickTrigger(
  trigger: TriggerType,
  behaviors: Behavior[],
  platform: Platform,
  customClickLabel?: string,
): QuickOverlayTriggerPreview | null {
  const active = behaviors.filter(item => item.enabled !== false)
  if (active.length === 0) return null
  const label = trigger === 'click' && customClickLabel ? customClickLabel : triggerLabels[trigger]
  const showTriggerTag = trigger !== 'click' || Boolean(customClickLabel)

  const enterPrompt = textAndEnterValue(active)
  if (enterPrompt !== null) {
    const firstPaste = active[0]
    return {
      trigger,
      triggerLabel: label,
      showTriggerTag,
      kind: 'prompt',
      badge: '粘贴并发送',
      ...(firstPaste.type === 'paste' && firstPaste.title ? { title: firstPaste.title } : {}),
      autoEnter: true,
      inputMethod: 'paste',
      text: enterPrompt || '（空文本）',
    }
  }

  // Also treat manually assembled [paste|typeText, (optional delay), Enter] sequences as prompt sends.
  const isEnterKey = (step: Behavior) => step.type === 'key' && (step.key === 'Enter' || step.key === 'Return')
  const firstStep = active[0]
  if (
    (firstStep.type === 'paste' || firstStep.type === 'typeText') &&
    ((active.length === 2 && isEnterKey(active[1])) ||
      (active.length === 3 && active[1].type === 'delay' && isEnterKey(active[2])))
  ) {
    return {
      trigger,
      triggerLabel: label,
      showTriggerTag,
      kind: 'prompt',
      badge: firstStep.type === 'paste' ? '粘贴并发送' : '输入并发送',
      ...(firstStep.title ? { title: firstStep.title } : {}),
      autoEnter: true,
      inputMethod: firstStep.type,
      text: firstStep.text || '（空文本）',
    }
  }

  if (active.length === 1) {
    const step = active[0]
    if (step.type === 'paste') {
      return {
        trigger,
        triggerLabel: label,
        showTriggerTag,
        kind: 'prompt',
        badge: '粘贴',
        ...(step.title ? { title: step.title } : {}),
        autoEnter: false,
        inputMethod: 'paste',
        text: step.text || '（空文本）',
      }
    }
    if (step.type === 'typeText') {
      return {
        trigger,
        triggerLabel: label,
        showTriggerTag,
        kind: 'prompt',
        badge: '输入',
        ...(step.title ? { title: step.title } : {}),
        autoEnter: false,
        inputMethod: 'typeText',
        text: step.text || '（空文本）',
      }
    }
    return {
      trigger,
      triggerLabel: label,
      showTriggerTag,
      kind: 'action',
      text: compactActionText(step, platform),
    }
  }

  const promptStep = active.find(
    (step): step is Extract<Behavior, { type: 'paste' | 'typeText' }> =>
      (step.type === 'paste' || step.type === 'typeText') && (step.text.trim().length > 0 || Boolean(step.title)),
  )
  const stepsSummary = active
    .map(step => {
      if (step.type === 'paste') return '粘贴文本'
      if (step.type === 'typeText') return '输入文本'
      return compactActionText(step, platform)
    })
    .join(' → ')

  if (promptStep) {
    return {
      trigger,
      triggerLabel: label,
      showTriggerTag,
      kind: 'sequence',
      badge: `${active.length} 步序列`,
      ...(promptStep.title ? { title: promptStep.title } : {}),
      text: promptStep.text,
      stepsSummary,
    }
  }

  return {
    trigger,
    triggerLabel: label,
    showTriggerTag,
    kind: 'sequence',
    badge: `${active.length} 步`,
    text: stepsSummary,
  }
}

/* ==========================================================================
   Generic Geometry-Driven Surface Compiler (No Device Hardcoding)
   ========================================================================== */

function cluster1D(values: number[], tol: number): number[] {
  const sorted = [...values].sort((a, b) => a - b)
  const clusters: { sum: number; count: number; last: number }[] = []
  for (const val of sorted) {
    const prev = clusters[clusters.length - 1]
    if (prev && val - prev.last <= tol) {
      prev.sum += val
      prev.count += 1
      prev.last = val
    } else {
      clusters.push({ sum: val, count: 1, last: val })
    }
  }
  return clusters.map(c => c.sum / c.count)
}

function nearestIndex(value: number, centers: readonly number[]): number {
  let bestIdx = 0
  let bestDist = Math.abs(value - centers[0])
  for (let i = 1; i < centers.length; i++) {
    const d = Math.abs(value - centers[i])
    if (d < bestDist) {
      bestDist = d
      bestIdx = i
    }
  }
  return bestIdx
}

function extractSideRail(
  items: PositionedSlot[],
  aspectRatio: number,
): { main: PositionedSlot[]; sideRail?: { side: 'left' | 'right'; slots: QuickOverlayKeySlot[] } } {
  if (items.length < 8 || aspectRatio >= 0.85) return { main: items }
  const byX = [...items].sort((a, b) => a.nx - b.nx)
  let bestGap = 0
  let splitIdx = -1
  for (let i = 1; i < byX.length; i++) {
    const gap = byX[i].nx - byX[i - 1].nx
    if (gap > bestGap) {
      bestGap = gap
      splitIdx = i
    }
  }
  if (bestGap < 0.22 || splitIdx < 1) return { main: items }

  const leftGroup = byX.slice(0, splitIdx)
  const rightGroup = byX.slice(splitIdx)

  const spanOf = (group: PositionedSlot[]) => Math.max(...group.map(g => g.nx)) - Math.min(...group.map(g => g.nx))

  const isSideColumn = (sideGroup: PositionedSlot[], mainGroup: PositionedSlot[]) =>
    sideGroup.length >= 1 &&
    sideGroup.length <= 5 &&
    spanOf(sideGroup) <= 0.045 &&
    mainGroup.length >= 6 &&
    spanOf(mainGroup) >= 0.22

  let railGroup: PositionedSlot[] | null = null
  let mainGroup: PositionedSlot[] | null = null
  let side: 'left' | 'right' = 'right'

  if (isSideColumn(rightGroup, leftGroup)) {
    railGroup = rightGroup
    mainGroup = leftGroup
    side = 'right'
  } else if (isSideColumn(leftGroup, rightGroup)) {
    railGroup = leftGroup
    mainGroup = rightGroup
    side = 'left'
  }

  if (!railGroup || !mainGroup) return { main: items }

  const minMainX = Math.min(...mainGroup.map(g => g.nx))
  const maxMainX = Math.max(...mainGroup.map(g => g.nx))
  const mainSpan = Math.max(0.01, maxMainX - minMainX)

  return {
    main: mainGroup.map(item => ({
      ...item,
      nx: 0.2 + ((item.nx - minMainX) / mainSpan) * 0.6,
    })),
    sideRail: {
      side,
      slots: [...railGroup].sort((a, b) => a.ny - b.ny).map(item => item.slot),
    },
  }
}

type DetectedCross = {
  cross: QuickOverlayCrossWell
  usedIndices: Set<number>
  cx: number
  cy: number
  minNy: number
  maxNy: number
}

function detectCrossClusters(items: PositionedSlot[]): DetectedCross[] {
  type Candidate = DetectedCross & { score: number }
  const candidates: Candidate[] = []

  const iconMatchBonus = (item: PositionedSlot, expected: 'up' | 'down' | 'left' | 'right' | 'center') => {
    let bonus = item.kindTag === 'hat' ? 0.025 : 0
    if (item.slot.icon === expected) bonus += 0.05
    return bonus
  }

  for (let u = 0; u < items.length; u++) {
    const up = items[u]
    for (let d = 0; d < items.length; d++) {
      if (d === u) continue
      const down = items[d]
      const dy = down.ny - up.ny
      if (dy < 0.08 || dy > 0.42) continue
      if (Math.abs(up.nx - down.nx) > 0.065) continue

      const cx = (up.nx + down.nx) / 2
      const cy = (up.ny + down.ny) / 2

      let bestArmScore = -Infinity
      let bestLeftIdx = -1
      let bestRightIdx = -1

      for (let l = 0; l < items.length; l++) {
        if (l === u || l === d) continue
        const left = items[l]
        if (left.nx >= cx - 0.04) continue

        for (let r = 0; r < items.length; r++) {
          if (r === u || r === d || r === l) continue
          const right = items[r]
          if (right.nx <= cx + 0.04) continue

          const dx = right.nx - left.nx
          if (dx < 0.08 || dx > 0.78) continue
          if (Math.abs(left.ny - right.ny) > 0.065) continue

          const armCx = (left.nx + right.nx) / 2
          const armCy = (left.ny + right.ny) / 2
          const centerErr = Math.hypot(armCx - cx, armCy - cy)
          if (centerErr > 0.075) continue

          // Empty-corners invariant: reject regular grids/keypads where keys occupy the 4 corners inside the bounding box.
          const minX = left.nx - 0.035
          const maxX = right.nx + 0.035
          const minY = up.ny - 0.035
          const maxY = down.ny + 0.035

          let centerIdx = -1
          let bestCenterDist = 0.07
          let hasCornerIntruder = false

          for (let k = 0; k < items.length; k++) {
            if (k === u || k === d || k === l || k === r) continue
            const other = items[k]
            if (other.nx >= minX && other.nx <= maxX && other.ny >= minY && other.ny <= maxY) {
              const distToCenter = Math.hypot(other.nx - cx, other.ny - cy)
              if (
                distToCenter <= bestCenterDist &&
                Math.abs(other.nx - cx) <= 0.06 &&
                Math.abs(other.ny - cy) <= 0.06
              ) {
                bestCenterDist = distToCenter
                centerIdx = k
              } else {
                hasCornerIntruder = true
                break
              }
            }
          }
          if (hasCornerIntruder) continue

          const score =
            iconMatchBonus(up, 'up') +
            iconMatchBonus(down, 'down') +
            iconMatchBonus(left, 'left') +
            iconMatchBonus(right, 'right') +
            (centerIdx >= 0 ? iconMatchBonus(items[centerIdx], 'center') + 0.02 : 0) -
            centerErr * 1.5 -
            Math.abs(up.nx - down.nx) -
            Math.abs(left.ny - right.ny)

          if (score > bestArmScore) {
            bestArmScore = score
            bestLeftIdx = l
            bestRightIdx = r
          }
        }
      }

      if (bestLeftIdx < 0 || bestRightIdx < 0) continue

      const left = items[bestLeftIdx]
      const right = items[bestRightIdx]
      const usedIndices = new Set<number>([u, d, bestLeftIdx, bestRightIdx])
      let centerItem: PositionedSlot | undefined
      let bestCenterDist = 0.065

      for (let k = 0; k < items.length; k++) {
        if (usedIndices.has(k)) continue
        const other = items[k]
        if (Math.abs(other.nx - cx) <= 0.06 && Math.abs(other.ny - cy) <= 0.06) {
          const dist = Math.hypot(other.nx - cx, other.ny - cy)
          if (dist < bestCenterDist) {
            bestCenterDist = dist
            centerItem = other
          }
        }
      }
      if (centerItem) {
        const centerIdx = items.indexOf(centerItem)
        if (centerIdx >= 0) usedIndices.add(centerIdx)
      }

      candidates.push({
        cross: {
          kind: 'cross',
          up: up.slot,
          down: down.slot,
          left: left.slot,
          right: right.slot,
          ...(centerItem ? { center: centerItem.slot } : {}),
        },
        usedIndices,
        cx,
        cy,
        minNy: Math.min(up.ny, left.ny, right.ny),
        maxNy: Math.max(down.ny, left.ny, right.ny),
        score: bestArmScore,
      })
    }
  }

  candidates.sort((a, b) => b.score - a.score)
  const chosen: DetectedCross[] = []
  const globallyUsed = new Set<number>()

  for (const cand of candidates) {
    let overlaps = false
    for (const idx of cand.usedIndices) {
      if (globallyUsed.has(idx)) {
        overlaps = true
        break
      }
    }
    if (overlaps) continue
    for (const idx of cand.usedIndices) globallyUsed.add(idx)
    chosen.push({
      cross: cand.cross,
      usedIndices: cand.usedIndices,
      cx: cand.cx,
      cy: cand.cy,
      minNy: cand.minNy,
      maxNy: cand.maxNy,
    })
  }

  return chosen.sort((a, b) => a.cy - b.cy || a.cx - b.cx)
}

function tryBuildMatrixLayout(
  items: PositionedSlot[],
  aspectRatio: number,
  hasCross: boolean,
): QuickOverlaySurfaceLayout | null {
  if (hasCross || items.length < 2) return null
  if (aspectRatio < 0.72 && items.length > 8) return null

  const spanning = tryBuildSpanningMatrixLayout(items)
  if (spanning) return spanning

  const rowCenters = cluster1D(
    items.map(i => i.ny),
    0.055,
  )
  const colCenters = cluster1D(
    items.map(i => i.nx),
    0.065,
  )
  const rows = rowCenters.length
  const cols = colCenters.length
  if (rows < 1 || rows > 6 || cols < 2 || cols > 8) return null
  if (items.length / (rows * cols) < 0.55) return null

  const occupied = new Set<string>()
  const cells: (QuickOverlayKeySlot & { row: number; col: number })[] = []

  for (const item of items) {
    const r = nearestIndex(item.ny, rowCenters) + 1
    const c = nearestIndex(item.nx, colCenters) + 1
    const coord = `${r}:${c}`
    if (occupied.has(coord)) return null
    occupied.add(coord)
    cells.push({ ...item.slot, row: r, col: c })
  }

  let oledSpan: { row: number; colStart: number; colSpan: number } | undefined
  if (rows >= 2 && cols >= 4) {
    let leftEmpty = 0
    for (let c = 1; c <= cols; c++) {
      if (!occupied.has(`1:${c}`)) leftEmpty++
      else break
    }
    if (leftEmpty >= 2 && leftEmpty < cols) {
      oledSpan = { row: 1, colStart: 1, colSpan: leftEmpty }
    } else {
      let rightEmpty = 0
      for (let c = cols; c >= 1; c--) {
        if (!occupied.has(`1:${c}`)) rightEmpty++
        else break
      }
      if (rightEmpty >= 2 && rightEmpty < cols) {
        oledSpan = { row: 1, colStart: cols - rightEmpty + 1, colSpan: rightEmpty }
      }
    }
  }

  cells.sort((a, b) => a.row - b.row || a.col - b.col)
  return {
    variant: 'matrix',
    rows,
    cols,
    ...(oledSpan ? { oledSpan } : {}),
    cells,
  }
}

function tryBuildSpanningMatrixLayout(items: PositionedSlot[]): QuickOverlaySurfaceLayout | null {
  const bounded = items.filter((item): item is PositionedSlot & { bounds: NonNullable<PositionedSlot['bounds']> } =>
    Boolean(item.bounds),
  )
  if (bounded.length !== items.length) return null
  const regular = bounded
    .map(reference =>
      bounded.filter(
        item =>
          Math.abs(item.bounds.width - reference.bounds.width) < reference.bounds.width * 0.05 &&
          Math.abs(item.bounds.height - reference.bounds.height) < reference.bounds.height * 0.05,
      ),
    )
    .sort((a, b) => b.length - a.length)[0]
  if (!regular || regular.length < 4) return null

  const { width, height } = regular[0].bounds
  const columns = cluster1D(
    regular.map(item => item.nx),
    width * 0.1,
  )
  const rows = cluster1D(
    regular.map(item => item.ny),
    height * 0.1,
  )
  if (columns.length < 2 || rows.length < 2) return null
  const pitchX = (columns[columns.length - 1] - columns[0]) / (columns.length - 1)
  const pitchY = (rows[rows.length - 1] - rows[0]) / (rows.length - 1)
  const closeX = (a: number, b: number) => Math.abs(a - b) < width * 0.1
  const closeY = (a: number, b: number) => Math.abs(a - b) < height * 0.1
  if (pitchX < width || pitchY < height) return null
  if (!columns.every((x, index) => closeX(x, columns[0] + index * pitchX))) return null
  if (!rows.every((y, index) => closeY(y, rows[0] + index * pitchY))) return null

  const left = columns[0] - width / 2
  const top = rows[0] - height / 2
  const right = columns[columns.length - 1] + width / 2
  const cells: Extract<QuickOverlaySurfaceLayout, { variant: 'matrix' }>['cells'] = []
  const rail: typeof bounded = []
  const occupied = new Set<string>()
  for (const item of bounded) {
    const bounds = item.bounds
    if (bounds.left >= right || bounds.left + bounds.width <= left) {
      rail.push(item)
      continue
    }
    const col = Math.round((bounds.left - left) / pitchX)
    const row = Math.round((bounds.top - top) / pitchY)
    const colSpan = Math.round((bounds.width + pitchX - width) / pitchX)
    const rowSpan = Math.round((bounds.height + pitchY - height) / pitchY)
    if (col < 0 || row < 0 || colSpan < 1 || rowSpan < 1) return null
    if (col + colSpan > columns.length || row + rowSpan > rows.length) return null
    if (!closeX(bounds.left, left + col * pitchX) || !closeY(bounds.top, top + row * pitchY)) return null
    if (!closeX(bounds.width, (colSpan - 1) * pitchX + width)) return null
    if (!closeY(bounds.height, (rowSpan - 1) * pitchY + height)) return null
    for (let y = row; y < row + rowSpan; y++) {
      for (let x = col; x < col + colSpan; x++) {
        const coordinate = `${y}:${x}`
        if (occupied.has(coordinate)) return null
        occupied.add(coordinate)
      }
    }
    cells.push({
      ...item.slot,
      col: col + 1,
      row: row + 1,
      ...(colSpan > 1 ? { colSpan } : {}),
      ...(rowSpan > 1 ? { rowSpan } : {}),
    })
  }
  if (occupied.size / (columns.length * rows.length) < 0.55) return null
  if (!rail.length && !cells.some(cell => cell.colSpan || cell.rowSpan)) return null
  const side = rail[0]?.nx < columns[0] ? 'left' : 'right'
  if (rail.some(item => !closeX(item.nx, rail[0].nx) || (side === 'left' ? item.nx >= left : item.nx <= right))) {
    return null
  }
  return {
    variant: 'matrix',
    rows: rows.length,
    cols: columns.length,
    cells: cells.sort((a, b) => a.row - b.row || a.col - b.col),
    ...(rail.length ? { sideRail: { side, slots: rail.sort((a, b) => a.ny - b.ny).map(item => item.slot) } } : {}),
  }
}

function keyRegionBounds(region: RemoteKeyRegion): PositionedSlot['bounds'] {
  if (region.transform) return
  const segments = region.path.match(/[a-df-z][^a-df-z]*/gi) ?? []
  let x = 0
  let y = 0
  const xs: number[] = []
  const ys: number[] = []
  for (const segment of segments) {
    const command = segment[0]
    const values = (segment.slice(1).match(/[-+]?(?:\d*\.)?\d+(?:e[-+]?\d+)?/gi) ?? []).map(Number)
    const relative = command === command.toLowerCase()
    const kind = command.toUpperCase()
    const length = kind === 'A' ? 7 : kind === 'M' || kind === 'L' ? 2 : kind === 'H' || kind === 'V' ? 1 : 0
    if (kind === 'Z') continue
    if (!length || !values.length || values.length % length) return
    for (let index = 0; index < values.length; index += length) {
      const args = values.slice(index, index + length)
      const nextX = kind === 'V' ? x : args[kind === 'A' ? 5 : 0] + (relative ? x : 0)
      const nextY = kind === 'H' ? y : args[kind === 'A' ? 6 : kind === 'V' ? 0 : 1] + (relative ? y : 0)
      // Quarter arcs keep rounded-rectangle extrema at their endpoints; other curves use the existing layout fallback.
      if (
        kind === 'A' &&
        (args[2] !== 0 ||
          args[3] !== 0 ||
          Math.abs(Math.abs(nextX - x) - args[0]) > 0.01 ||
          Math.abs(Math.abs(nextY - y) - args[1]) > 0.01)
      )
        return
      x = nextX
      y = nextY
      xs.push(x)
      ys.push(y)
    }
  }
  if (!xs.length) return
  const left = Math.min(...xs)
  const top = Math.min(...ys)
  return { left, top, width: Math.max(...xs) - left, height: Math.max(...ys) - top }
}

function packRowsWithBridge(items: PositionedSlot[]): QuickOverlaySurfaceBlock[] {
  if (items.length === 0) return []
  const sorted = [...items].sort((a, b) => a.ny - b.ny || a.nx - b.nx || a.order - b.order)

  const rows: PositionedSlot[][] = []
  for (const item of sorted) {
    const prevRow = rows[rows.length - 1]
    if (prevRow && item.ny - prevRow[0].ny <= 0.036) {
      prevRow.push(item)
    } else {
      rows.push([item])
    }
  }
  for (const row of rows) row.sort((a, b) => a.nx - b.nx || a.order - b.order)

  const blocks: QuickOverlaySurfaceBlock[] = []
  for (let i = 0; i < rows.length;) {
    const r0 = rows[i]
    const r1 = rows[i + 1]
    const r2 = rows[i + 2]

    if (
      r0 &&
      r1 &&
      r2 &&
      r0.length === 2 &&
      r1.length === 1 &&
      r2.length === 2 &&
      r0[0].nx < 0.4 &&
      r0[1].nx > 0.6 &&
      r1[0].nx >= 0.36 &&
      r1[0].nx <= 0.64 &&
      r2[0].nx < 0.4 &&
      r2[1].nx > 0.6 &&
      r2[0].ny - r0[0].ny <= 0.22
    ) {
      blocks.push({
        kind: 'bridge',
        leftStack: [r0[0].slot, r2[0].slot],
        center: r1[0].slot,
        rightStack: [r0[1].slot, r2[1].slot],
      })
      i += 3
      continue
    }

    if (r0.length > 5) {
      for (let start = 0; start < r0.length; start += 4) {
        const chunk = r0.slice(start, start + 4)
        blocks.push({
          kind: 'row',
          columns: Math.max(1, Math.min(5, chunk.length)) as 1 | 2 | 3 | 4 | 5,
          slots: chunk.map(c => c.slot),
        })
      }
      i += 1
      continue
    }

    if (r0.length === 1) {
      const only = r0[0]
      const align = only.nx < 0.36 ? 'left' : only.nx > 0.64 ? 'right' : 'center'
      blocks.push({
        kind: 'row',
        columns: 1,
        align,
        slots: [only.slot],
      })
      i += 1
      continue
    }

    blocks.push({
      kind: 'row',
      columns: Math.min(5, r0.length) as 2 | 3 | 4 | 5,
      slots: r0.map(item => item.slot),
    })
    i += 1
  }

  return blocks
}

function buildVerticalBlocks(items: PositionedSlot[], crosses: DetectedCross[]): QuickOverlaySurfaceBlock[] {
  const usedByCross = new Set<number>()
  for (const c of crosses) {
    for (const idx of c.usedIndices) usedByCross.add(idx)
  }

  const remaining = items.filter((_, idx) => !usedByCross.has(idx)).sort((a, b) => a.ny - b.ny || a.nx - b.nx)
  if (crosses.length === 0) return packRowsWithBridge(remaining)

  const orderedCrosses = [...crosses].sort((a, b) => a.cy - b.cy)
  const blocks: QuickOverlaySurfaceBlock[] = []
  let cursor = 0

  for (const crossEntry of orderedCrosses) {
    const before: PositionedSlot[] = []
    while (cursor < remaining.length && remaining[cursor].ny < crossEntry.cy - 0.02) {
      before.push(remaining[cursor])
      cursor += 1
    }
    blocks.push(...packRowsWithBridge(before))
    blocks.push(crossEntry.cross)
  }

  if (cursor < remaining.length) {
    blocks.push(...packRowsWithBridge(remaining.slice(cursor)))
  }

  return blocks
}

function tryBuildControllerLayout(
  items: PositionedSlot[],
  crosses: DetectedCross[],
  aspectRatio: number,
): QuickOverlaySurfaceLayout | null {
  if (aspectRatio < 1.05 || items.length < 8) return null
  if (crosses.length < 2 && !(crosses.length >= 1 && items.length >= 10)) return null

  const minCrossTop = crosses.length > 0 ? Math.min(...crosses.map(c => c.minNy)) : 0.35
  const shoulderCutoff = Math.min(0.3, minCrossTop - 0.03)
  const crossMemberSet = new Set<number>()
  for (const c of crosses) {
    for (const idx of c.usedIndices) crossMemberSet.add(idx)
  }

  const leftShoulders: PositionedSlot[] = []
  const rightShoulders: PositionedSlot[] = []
  const centerItems: PositionedSlot[] = []
  const leftItems: { item: PositionedSlot; origIdx: number }[] = []
  const rightItems: { item: PositionedSlot; origIdx: number }[] = []

  items.forEach((item, idx) => {
    const inCross = crossMemberSet.has(idx)
    if (!inCross && item.ny <= shoulderCutoff) {
      if (item.nx < 0.5) leftShoulders.push(item)
      else rightShoulders.push(item)
      return
    }
    if (!inCross && item.nx >= 0.4 && item.nx <= 0.6 && item.ny <= 0.56) {
      centerItems.push(item)
      return
    }
    if (item.nx < 0.5) leftItems.push({ item, origIdx: idx })
    else rightItems.push({ item, origIdx: idx })
  })

  if (leftItems.length === 0 || rightItems.length === 0) return null

  const remapPod = (
    podEntries: { item: PositionedSlot; origIdx: number }[],
    isLeft: boolean,
  ): QuickOverlaySurfaceBlock[] => {
    const podItems = podEntries.map(({ item }) => ({
      ...item,
      nx: isLeft ? Math.min(0.95, Math.max(0.05, item.nx * 2)) : Math.min(0.95, Math.max(0.05, (item.nx - 0.5) * 2)),
    }))
    const podCrosses = detectCrossClusters(podItems)
    return buildVerticalBlocks(podItems, podCrosses)
  }

  return {
    variant: 'controller',
    leftShoulders: leftShoulders.sort((a, b) => a.ny - b.ny || a.nx - b.nx).map(i => i.slot),
    rightShoulders: rightShoulders.sort((a, b) => a.ny - b.ny || a.nx - b.nx).map(i => i.slot),
    centerRow: centerItems.sort((a, b) => a.ny - b.ny || a.nx - b.nx).map(i => i.slot),
    leftPod: remapPod(leftItems, true),
    rightPod: remapPod(rightItems, false),
  }
}

function buildMouseSurfaceLayout(
  normalizedBehaviors: ReadonlyMap<string, TriggerBehaviors>,
  triggerInputId: string,
  platform: Platform,
): QuickOverlaySurfaceLayout {
  const byControl = new Map<MouseControlId, QuickOverlayScopedEntry[]>()
  const metaById = new Map(mouseOverlayInputs.map(item => [item.id, item]))

  for (const id of mouseInputIds) {
    const { scope, control } = mouseInputParts(id)
    const meta = metaById.get(id)
    const isExitTrigger = id === triggerInputId
    const sequences = normalizedBehaviors.get(id)
    const triggers = isExitTrigger
      ? []
      : triggerTypes
          .map(trigger => summarizeQuickTrigger(trigger, sequences?.[trigger] ?? [], platform, meta?.triggerLabel))
          .filter((entry): entry is QuickOverlayTriggerPreview => entry !== null)
    if (!isExitTrigger && triggers.length === 0) continue

    const entries = byControl.get(control.id) ?? []
    entries.push({
      inputId: id,
      contextLabel: scope.id === 'global' ? undefined : scope.label,
      isExitTrigger,
      triggers,
    })
    byControl.set(control.id, entries)
  }

  const slotForControl = (controlId: MouseControlId): QuickOverlayKeySlot => {
    const sampleId = mouseInputIds.find(id => mouseInputParts(id).control.id === controlId)!
    const { control } = mouseInputParts(sampleId)
    const entries = byControl.get(controlId) ?? []
    if (entries.length === 0) {
      return {
        slotId: controlId,
        inputId: sampleId,
        label: control.label,
        short: control.label,
        icon: control.icon,
        status: 'idle',
        triggers: [],
      }
    }
    const primary = entries.find(e => e.isExitTrigger) ?? entries[0]
    const primaryTrigger = primary.triggers[0]
    return {
      slotId: controlId,
      inputId: primary.inputId,
      label: control.label,
      short: control.label,
      icon: control.icon,
      status: primary.isExitTrigger ? 'trigger' : 'configured',
      primaryKind: primaryTrigger?.kind,
      contextLabel: entries.length === 1 ? primary.contextLabel : undefined,
      triggers: primary.triggers,
      ...(entries.length > 1 ? { scopedEntries: entries } : {}),
    }
  }

  return {
    variant: 'mouse',
    thumbStack: [slotForControl('buttonForward'), slotForControl('buttonBack')],
    primaryPair: [slotForControl('buttonLeft'), slotForControl('buttonRight')],
    wheelWell: {
      kind: 'cross',
      up: slotForControl('up'),
      left: slotForControl('left'),
      center: slotForControl('buttonMiddle'),
      right: slotForControl('right'),
      down: slotForControl('down'),
    },
  }
}

function compileGenericSvgSurface(
  pkg: DeviceSupportPackage,
  normalizedBehaviors: ReadonlyMap<string, TriggerBehaviors>,
  itemById: ReadonlyMap<string, QuickOverlayCardItem>,
  triggerInputId: string,
  triggerMeta: MappingInput<string> | undefined,
  triggerShort: string | undefined,
  includeUnconfiguredAxes: boolean,
): QuickOverlaySurfaceLayout {
  const viewBox = pkg.remoteView?.viewBox ?? { width: 420, height: 1000 }
  const aspectRatio = viewBox.width / Math.max(1, viewBox.height)

  const positioned: PositionedSlot[] = []
  const seenIds = new Set<string>()

  const pushInput = (
    input: MappingInput<string> & { kind?: string },
    index: number,
    fallbackPos?: { nx: number; ny: number },
  ) => {
    if (!input.id || seenIds.has(input.id)) return
    const isTrigger = input.id === triggerInputId
    const configured = itemById.get(input.id)
    const viewBtn = pkg.remoteView?.buttons.find(btn => btn.id === input.id)
    const kindTag = input.kind ?? viewBtn?.kind ?? 'button'
    const hasEnabledOrRaw = Boolean(configured || isTrigger || normalizedBehaviors.has(input.id))
    // Keep non-axis hardware buttons on the ceramic chassis so physical shape stays recognizable;
    // omit unconfigured analog stick axis directions to avoid visual clutter.
    if (!includeUnconfiguredAxes && !hasEnabledOrRaw && kindTag === 'axis') return

    const region = pkg.remoteView?.keyRegions[input.id]
    const bounds = region && keyRegionBounds(region)
    let nx = 0.5
    let ny = 0.5
    if (region && viewBox.width > 0 && viewBox.height > 0) {
      nx = region.anchor.x / viewBox.width
      ny = region.anchor.y / viewBox.height
    } else if (viewBtn) {
      nx = viewBtn.x / 100
      ny = viewBtn.y / 100
    } else if (fallbackPos) {
      nx = fallbackPos.nx
      ny = fallbackPos.ny
    } else {
      return
    }

    seenIds.add(input.id)
    const short = viewBtn?.short ?? input.label
    const triggers = configured?.triggers ?? []
    positioned.push({
      slot: {
        slotId: input.id,
        inputId: input.id,
        label: input.label,
        short,
        icon: input.icon,
        status: isTrigger ? 'trigger' : configured ? 'configured' : 'idle',
        ...(configured?.triggers[0]?.kind ? { primaryKind: configured.triggers[0].kind } : {}),
        ...(input.contextLabel ? { contextLabel: input.contextLabel } : {}),
        triggers,
      },
      nx,
      ny,
      kindTag,
      order: index,
      ...(bounds
        ? {
            bounds: {
              left: bounds.left / viewBox.width,
              top: bounds.top / viewBox.height,
              width: bounds.width / viewBox.width,
              height: bounds.height / viewBox.height,
            },
          }
        : {}),
    })
  }

  pkg.inputs.forEach((input, idx) => pushInput(input, idx))

  // Fallback for unknown devices whose SVG is absent or incomplete: arrange configured items into a neat 2-column grid.
  if (positioned.length === 0) {
    const fallbackEntries: MappingInput<string>[] = [...itemById.values()].map(item => ({
      id: item.inputId,
      label: item.label,
      icon: item.icon,
      contextLabel: item.contextLabel,
    }))
    if (triggerInputId && !itemById.has(triggerInputId)) {
      fallbackEntries.unshift({
        id: triggerInputId,
        label: triggerMeta?.label ?? triggerInputId,
        icon: triggerMeta?.icon ?? 'center',
        contextLabel: triggerMeta?.contextLabel,
      })
    }
    fallbackEntries.forEach((entry, idx) => {
      const col = idx % 2
      const row = Math.floor(idx / 2)
      pushInput(entry, idx, {
        nx: col === 0 ? 0.3 : 0.7,
        ny: (row + 0.5) / Math.max(1, Math.ceil(fallbackEntries.length / 2)),
      })
    })
    if (triggerShort && positioned[0]?.slot.inputId === triggerInputId) {
      positioned[0].slot.short = triggerShort
    }
  }

  const { main, sideRail } = extractSideRail(positioned, aspectRatio)
  const crosses = detectCrossClusters(main)
  const matrix = tryBuildMatrixLayout(main, aspectRatio, crosses.length > 0)
  if (matrix) return matrix

  const controller = tryBuildControllerLayout(main, crosses, aspectRatio)
  if (controller) return controller

  const blocks = buildVerticalBlocks(main, crosses)
  const totalCount = main.length + (sideRail?.slots.length ?? 0)
  const density: 'spacious' | 'regular' | 'compact' =
    totalCount <= 10 ? 'spacious' : totalCount <= 18 ? 'regular' : 'compact'

  return {
    variant: 'panel',
    density,
    blocks,
    ...(sideRail ? { sideRail } : {}),
  }
}

export function buildQuickOverlayView(
  session: QuickOverlaySessionPayload,
  platform: Platform,
  { includeUnconfiguredAxes = false } = {},
): QuickOverlayViewModel {
  const isMouse = session.deviceKind === 'mouse'
  const pkg = isMouse ? null : resolveSessionPackage(session)
  const inputs: readonly MappingInput<string>[] = isMouse ? mouseOverlayInputs : (pkg?.inputs ?? [])
  const viewButtons = pkg?.remoteView?.buttons

  const normalizedBehaviors = new Map<string, TriggerBehaviors>()
  if (session.behaviors && typeof session.behaviors === 'object') {
    for (const [rawKey, rawValue] of Object.entries(session.behaviors)) {
      const id = resolveCanonicalInputId(rawKey, session.deviceKind, pkg)
      if (!id) continue
      normalizedBehaviors.set(id, coerceTriggerBehaviors(rawValue))
    }
  }

  const triggerInputId = resolveCanonicalInputId(session.triggerInput, session.deviceKind, pkg)
  const findInputMeta = (id: string): MappingInput<string> | undefined => inputs.find(item => item.id === id)
  const formatInputLabel = (meta: MappingInput<string> | undefined, fallbackId: string): string => {
    if (!meta) return fallbackId
    return meta.contextLabel ? `${meta.contextLabel} · ${meta.label}` : meta.label
  }

  const triggerMeta = triggerInputId ? findInputMeta(triggerInputId) : undefined
  const triggerShort = triggerInputId ? viewButtons?.find(button => button.id === triggerInputId)?.short : undefined
  const triggerLabel = triggerInputId ? formatInputLabel(triggerMeta, triggerInputId) : null

  const items: QuickOverlayCardItem[] = []
  const seenIds = new Set<string>()

  const pushItem = (id: string, meta: MappingInput<string> | undefined) => {
    if (!id || seenIds.has(id) || id === triggerInputId) return
    const sequences = normalizedBehaviors.get(id)
    if (!sequences) return
    const triggers = triggerTypes
      .map(trigger => summarizeQuickTrigger(trigger, sequences[trigger] ?? [], platform, meta?.triggerLabel))
      .filter((entry): entry is QuickOverlayTriggerPreview => entry !== null)
    if (triggers.length === 0) return
    seenIds.add(id)
    items.push({
      inputId: id,
      label: meta?.label ?? id,
      contextLabel: meta?.contextLabel,
      short: viewButtons?.find(button => button.id === id)?.short,
      icon: meta?.icon ?? 'center',
      triggers,
    })
  }

  for (const input of inputs) {
    pushItem(input.id, input)
  }
  for (const id of normalizedBehaviors.keys()) {
    pushItem(id, findInputMeta(id))
  }

  const pressedIds = (session.pressed ?? [])
    .map(id => resolveCanonicalInputId(id, session.deviceKind, pkg))
    .filter(Boolean)

  const itemById = new Map(items.map(item => [item.inputId, item]))
  const surface: QuickOverlaySurfaceLayout = isMouse
    ? buildMouseSurfaceLayout(normalizedBehaviors, triggerInputId, platform)
    : compileGenericSvgSurface(
        pkg!,
        normalizedBehaviors,
        itemById,
        triggerInputId,
        triggerMeta,
        triggerShort,
        includeUnconfiguredAxes,
      )

  return {
    isMouse,
    promptMode: Boolean(session.promptMode),
    deviceName: session.deviceName || (isMouse ? '系统鼠标' : (pkg?.name ?? '设备')),
    profileName: session.profileName || '快捷交互配置',
    triggerInputId,
    triggerLabel,
    mappedIds: items.map(item => item.inputId),
    pressedIds,
    items,
    surface,
  }
}
