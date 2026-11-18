import type { MappingInput, Platform } from '../appTypes.ts'
import { triggerTypes } from '../behaviorModel.ts'
import type { Behavior, TriggerBehaviors, TriggerType } from '../behaviorModel.ts'
import { behaviorSummary, keyDisplayName, textAndEnterValue, triggerLabels } from '../behaviorSummary.ts'
import { macosShortcutPresets } from '../macosShortcutPresets.ts'
import { mouseInputIds, mouseInputParts } from '../devices/index.ts'
import type { MouseControlId, MouseInputId } from '../devices/index.ts'
import { packageFor } from '../devices/integration/model.ts'
import { isOverviewButton } from '../devices/integration/railOverview.ts'
import type { DeviceScreenRegion, RemoteView } from '../devices/types.ts'

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
}

export type QuickOverlayTriggerPreview = {
  trigger: TriggerType
  triggerLabel: string
  showTriggerTag: boolean
  kind: 'prompt' | 'action' | 'sequence'
  badge?: string
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

export type QuickOverlayTargetAnchor = { kind: 'remote'; id: string } | { kind: 'mouse'; controlId: MouseControlId }

export type QuickOverlayCalloutItem = {
  inputId: string
  label: string
  contextLabel?: string
  short?: string
  icon: MappingInput['icon']
  side: 'left' | 'right'
  nx: number
  ny: number
  isExitTrigger: boolean
  target: QuickOverlayTargetAnchor
  triggers: QuickOverlayTriggerPreview[]
}

export type QuickOverlayKeypadSlot = {
  inputId: string
  short: string
  label: string
  row: number
  col: number
  status: 'configured' | 'trigger' | 'idle'
  triggers: QuickOverlayTriggerPreview[]
}

export type QuickOverlayPoint = {
  x: number
  y: number
}

function segmentIntersection(
  a1: QuickOverlayPoint,
  a2: QuickOverlayPoint,
  b1: QuickOverlayPoint,
  b2: QuickOverlayPoint,
): { t: number; point: QuickOverlayPoint } | null {
  const dax = a2.x - a1.x
  const day = a2.y - a1.y
  const dbx = b2.x - b1.x
  const dby = b2.y - b1.y
  const denom = dax * dby - day * dbx
  if (Math.abs(denom) < 1e-7) return null
  const ox = b1.x - a1.x
  const oy = b1.y - a1.y
  const t = (ox * dby - oy * dbx) / denom
  const u = (ox * day - oy * dax) / denom
  if (t < 0 || t > 1 || u < -1e-4 || u > 1 + 1e-4) return null
  return {
    t,
    point: { x: a1.x + t * dax, y: a1.y + t * day },
  }
}

function minDistanceSqToSiblings(pt: QuickOverlayPoint, siblings: readonly QuickOverlayPoint[][]): number {
  let minSq = Number.POSITIVE_INFINITY
  for (const poly of siblings) {
    for (const other of poly) {
      const dx = pt.x - other.x
      const dy = pt.y - other.y
      const dSq = dx * dx + dy * dy
      if (dSq < minSq) minSq = dSq
    }
  }
  return minSq
}

export function pickPerimeterAttachment(
  elbowPt: QuickOverlayPoint,
  centerPt: QuickOverlayPoint,
  outlinePts: readonly QuickOverlayPoint[],
  siblingOutlines: readonly QuickOverlayPoint[][] = [],
): QuickOverlayPoint | null {
  const n = outlinePts.length
  if (n < 3) return null

  const siblingDistsSq =
    siblingOutlines.length > 0 ? outlinePts.map(pt => minDistanceSqToSiblings(pt, siblingOutlines)) : null

  const buildEligibleMask = (minGapPx: number): boolean[] => {
    if (!siblingDistsSq) return outlinePts.map(() => true)
    const thresholdSq = minGapPx * minGapPx
    return siblingDistsSq.map(dSq => dSq > thresholdSq)
  }

  let eligible = buildEligibleMask(9)
  if (eligible.filter(Boolean).length < 8) eligible = buildEligibleMask(4.5)
  if (eligible.filter(Boolean).length < 6) eligible = buildEligibleMask(2)
  if (eligible.filter(Boolean).length < 4) eligible = outlinePts.map(() => true)

  let bestHit: { t: number; point: QuickOverlayPoint } | null = null
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n
    if (!eligible[i] || !eligible[j]) continue
    const hit = segmentIntersection(elbowPt, centerPt, outlinePts[i], outlinePts[j])
    if (hit && (!bestHit || hit.t < bestHit.t)) {
      bestHit = hit
    }
  }

  let chosen = bestHit?.point ?? null
  if (!chosen) {
    let bestDistSq = Number.POSITIVE_INFINITY
    for (let i = 0; i < n; i++) {
      if (!eligible[i]) continue
      const p = outlinePts[i]
      const dx = p.x - elbowPt.x
      const dy = p.y - elbowPt.y
      const dSq = dx * dx + dy * dy
      if (dSq < bestDistSq) {
        bestDistSq = dSq
        chosen = p
      }
    }
  }

  if (!chosen) return null
  const outX = elbowPt.x - chosen.x
  const outY = elbowPt.y - chosen.y
  const outLen = Math.hypot(outX, outY)
  if (outLen > 1) {
    return {
      x: chosen.x + (outX / outLen) * 0.4,
      y: chosen.y + (outY / outLen) * 0.4,
    }
  }
  return chosen
}

export type QuickOverlayViewModel = {
  layoutMode: 'callout' | 'keypad'
  isMouse: boolean
  isWideDiagram: boolean
  deviceName: string
  profileName: string
  triggerInputId: string
  triggerLabel: string | null
  remoteView?: RemoteView
  screenRegion?: DeviceScreenRegion
  mappedIds: string[]
  pressedIds: string[]
  items: QuickOverlayCardItem[]
  leftCallouts: QuickOverlayCalloutItem[]
  rightCallouts: QuickOverlayCalloutItem[]
  keypadSlots: QuickOverlayKeypadSlot[]
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

const mouseControlSpatialMap: Record<MouseControlId, { side: 'left' | 'right'; nx: number; ny: number }> = {
  buttonLeft: { side: 'left', nx: 0.26, ny: 0.16 },
  buttonRight: { side: 'right', nx: 0.74, ny: 0.16 },
  buttonForward: { side: 'left', nx: 0.16, ny: 0.44 },
  buttonBack: { side: 'left', nx: 0.16, ny: 0.62 },
  up: { side: 'right', nx: 0.58, ny: 0.42 },
  left: { side: 'left', nx: 0.42, ny: 0.64 },
  buttonMiddle: { side: 'right', nx: 0.58, ny: 0.62 },
  right: { side: 'right', nx: 0.76, ny: 0.66 },
  down: { side: 'right', nx: 0.58, ny: 0.84 },
}

const mouseScopeOrder: Record<string, number> = {
  global: 0,
  left: 1,
  top: 2,
  right: 3,
}

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

function resolveCanonicalInputId(rawKey: string, deviceKind: string): string {
  const trimmed = rawKey.trim()
  if (!trimmed || deviceKind === 'mouse') return trimmed
  const pkg = packageFor(deviceKind)
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
    return {
      trigger,
      triggerLabel: label,
      showTriggerTag,
      kind: 'prompt',
      badge: '粘贴并发送',
      text: enterPrompt || '（空文本）',
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
      (step.type === 'paste' || step.type === 'typeText') && step.text.trim().length > 0,
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

function buildCalloutSides(
  items: readonly QuickOverlayCardItem[],
  triggerInputId: string,
  triggerMeta: MappingInput<string> | undefined,
  triggerShort: string | undefined,
  isMouse: boolean,
  remoteView: RemoteView | undefined,
): { leftCallouts: QuickOverlayCalloutItem[]; rightCallouts: QuickOverlayCalloutItem[] } {
  type DraftCallout = Omit<QuickOverlayCalloutItem, 'side'> & {
    preferredSide: 'left' | 'right' | 'center'
    sortTie: number
  }

  const drafts: DraftCallout[] = []

  const addDraft = (
    inputId: string,
    label: string,
    contextLabel: string | undefined,
    short: string | undefined,
    icon: MappingInput['icon'],
    isExitTrigger: boolean,
    triggers: QuickOverlayTriggerPreview[],
    index: number,
  ) => {
    if (isMouse) {
      if (!(mouseInputIds as readonly string[]).includes(inputId)) return
      const { scope, control } = mouseInputParts(inputId as MouseInputId)
      const pos = mouseControlSpatialMap[control.id]
      const scopeOffset = (mouseScopeOrder[scope.id] ?? 0) * 0.015
      drafts.push({
        inputId,
        label,
        contextLabel,
        short,
        icon,
        nx: pos.nx,
        ny: pos.ny + scopeOffset,
        isExitTrigger,
        target: { kind: 'mouse', controlId: control.id },
        triggers,
        preferredSide: pos.side,
        sortTie: index,
      })
      return
    }

    const region = remoteView?.keyRegions[inputId]
    const viewBox = remoteView?.viewBox
    const nx = region && viewBox && viewBox.width > 0 ? region.anchor.x / viewBox.width : 0.5
    const ny = region && viewBox && viewBox.height > 0 ? region.anchor.y / viewBox.height : 0.5
    const preferredSide = nx < 0.43 ? 'left' : nx > 0.57 ? 'right' : 'center'
    drafts.push({
      inputId,
      label,
      contextLabel,
      short,
      icon,
      nx,
      ny,
      isExitTrigger,
      target: { kind: 'remote', id: inputId },
      triggers,
      preferredSide,
      sortTie: index,
    })
  }

  items.forEach((item, index) => {
    addDraft(item.inputId, item.label, item.contextLabel, item.short, item.icon, false, item.triggers, index)
  })

  if (triggerInputId && (isMouse || Boolean(remoteView?.keyRegions[triggerInputId]))) {
    addDraft(
      triggerInputId,
      triggerMeta?.label ?? triggerInputId,
      triggerMeta?.contextLabel,
      triggerShort,
      triggerMeta?.icon ?? 'center',
      true,
      [],
      items.length + 1,
    )
  }

  const leftCallouts: QuickOverlayCalloutItem[] = []
  const rightCallouts: QuickOverlayCalloutItem[] = []

  for (const draft of drafts) {
    if (draft.preferredSide === 'left') {
      leftCallouts.push({ ...draft, side: 'left' })
    } else if (draft.preferredSide === 'right') {
      rightCallouts.push({ ...draft, side: 'right' })
    }
  }

  const centerDrafts = drafts
    .filter(draft => draft.preferredSide === 'center')
    .sort((a, b) => a.ny - b.ny || a.nx - b.nx || a.sortTie - b.sortTie)

  centerDrafts.forEach((draft, idx) => {
    const side: 'left' | 'right' =
      leftCallouts.length < rightCallouts.length
        ? 'left'
        : rightCallouts.length < leftCallouts.length
          ? 'right'
          : draft.nx < 0.495
            ? 'left'
            : draft.nx > 0.505
              ? 'right'
              : idx % 2 === 0
                ? 'left'
                : 'right'
    if (side === 'left') leftCallouts.push({ ...draft, side: 'left' })
    else rightCallouts.push({ ...draft, side: 'right' })
  })

  leftCallouts.sort((a, b) => a.ny - b.ny || a.nx - b.nx)
  rightCallouts.sort((a, b) => a.ny - b.ny || b.nx - a.nx)

  return { leftCallouts, rightCallouts }
}

function buildK18KeypadSlots(
  inputs: readonly MappingInput<string>[],
  viewButtons: readonly { id: string; short?: string }[] | undefined,
  itemById: ReadonlyMap<string, QuickOverlayCardItem>,
  triggerInputId: string,
): QuickOverlayKeypadSlot[] {
  return inputs.slice(0, 18).map((input, index) => {
    const row = index < 3 ? 1 : Math.floor((index - 3) / 5) + 2
    const col = index < 3 ? index + 3 : ((index - 3) % 5) + 1
    const configured = itemById.get(input.id)
    const isTrigger = input.id === triggerInputId
    const short = viewButtons?.find(btn => btn.id === input.id)?.short ?? input.label
    return {
      inputId: input.id,
      short,
      label: input.label,
      row,
      col,
      status: isTrigger ? 'trigger' : configured ? 'configured' : 'idle',
      triggers: configured?.triggers ?? [],
    }
  })
}

export function buildQuickOverlayView(session: QuickOverlaySessionPayload, platform: Platform): QuickOverlayViewModel {
  const isMouse = session.deviceKind === 'mouse'
  const pkg = isMouse ? null : packageFor(session.deviceKind)
  const inputs: readonly MappingInput<string>[] = isMouse ? mouseOverlayInputs : (pkg?.inputs ?? [])
  const viewButtons = pkg?.remoteView?.buttons

  const normalizedBehaviors = new Map<string, TriggerBehaviors>()
  if (session.behaviors && typeof session.behaviors === 'object') {
    for (const [rawKey, rawValue] of Object.entries(session.behaviors)) {
      const id = resolveCanonicalInputId(rawKey, session.deviceKind)
      if (!id) continue
      normalizedBehaviors.set(id, coerceTriggerBehaviors(rawValue))
    }
  }

  const triggerInputId = resolveCanonicalInputId(session.triggerInput, session.deviceKind)
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
    if (meta && !isMouse && !isOverviewButton(meta, viewButtons)) return
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

  const pressedIds = (session.pressed ?? []).map(id => resolveCanonicalInputId(id, session.deviceKind)).filter(Boolean)
  const layoutMode: 'callout' | 'keypad' =
    session.deviceKind === 'kivoK18Lite' && inputs.length >= 18 ? 'keypad' : 'callout'
  const viewBox = pkg?.remoteView?.viewBox
  const isWideDiagram = isMouse || Boolean(viewBox && viewBox.width / Math.max(1, viewBox.height) >= 0.85)

  const itemById = new Map(items.map(item => [item.inputId, item]))
  const keypadSlots = layoutMode === 'keypad' ? buildK18KeypadSlots(inputs, viewButtons, itemById, triggerInputId) : []
  const { leftCallouts, rightCallouts } =
    layoutMode === 'callout'
      ? buildCalloutSides(items, triggerInputId, triggerMeta, triggerShort, isMouse, pkg?.remoteView)
      : { leftCallouts: [], rightCallouts: [] }

  return {
    layoutMode,
    isMouse,
    isWideDiagram,
    deviceName: session.deviceName || (isMouse ? '系统鼠标' : (pkg?.name ?? '设备')),
    profileName: session.profileName || '快捷交互配置',
    triggerInputId,
    triggerLabel,
    remoteView: pkg?.remoteView,
    screenRegion: pkg?.screenRegion,
    mappedIds: items.map(item => item.inputId),
    pressedIds,
    items,
    leftCallouts,
    rightCallouts,
    keypadSlots,
  }
}
