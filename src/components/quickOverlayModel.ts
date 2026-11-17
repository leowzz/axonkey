import type { MappingInput, Platform } from '../appTypes.ts'
import { triggerTypes } from '../behaviorModel.ts'
import type { Behavior, TriggerBehaviors, TriggerType } from '../behaviorModel.ts'
import { behaviorSummary, textAndEnterValue, triggerLabels } from '../behaviorSummary.ts'
import { mouseInputIds, mouseInputParts } from '../devices/index.ts'
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

export type QuickOverlayViewModel = {
  isMouse: boolean
  deviceName: string
  profileName: string
  triggerInputId: string
  triggerLabel: string | null
  remoteView?: RemoteView
  screenRegion?: DeviceScreenRegion
  mappedIds: string[]
  pressedIds: string[]
  items: QuickOverlayCardItem[]
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

export function summarizeQuickTrigger(
  trigger: TriggerType,
  behaviors: Behavior[],
  platform: Platform,
  customClickLabel?: string,
): QuickOverlayTriggerPreview | null {
  const active = behaviors.filter(item => item.enabled !== false)
  if (active.length === 0) return null
  const label = trigger === 'click' && customClickLabel ? customClickLabel : triggerLabels[trigger]

  const enterPrompt = textAndEnterValue(active)
  if (enterPrompt !== null) {
    return {
      trigger,
      triggerLabel: label,
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
        kind: 'prompt',
        badge: '粘贴',
        text: step.text || '（空文本）',
      }
    }
    if (step.type === 'typeText') {
      return {
        trigger,
        triggerLabel: label,
        kind: 'prompt',
        badge: '输入',
        text: step.text || '（空文本）',
      }
    }
    return {
      trigger,
      triggerLabel: label,
      kind: 'action',
      text: behaviorSummary(step, platform),
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
      return behaviorSummary(step, platform)
    })
    .join(' → ')

  if (promptStep) {
    return {
      trigger,
      triggerLabel: label,
      kind: 'sequence',
      badge: `${active.length} 步序列`,
      text: promptStep.text,
      stepsSummary,
    }
  }

  return {
    trigger,
    triggerLabel: label,
    kind: 'sequence',
    badge: `${active.length} 步`,
    text: stepsSummary,
  }
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

  return {
    isMouse,
    deviceName: session.deviceName || (isMouse ? '系统鼠标' : (pkg?.name ?? '设备')),
    profileName: session.profileName || '快捷交互配置',
    triggerInputId,
    triggerLabel,
    remoteView: pkg?.remoteView,
    screenRegion: pkg?.screenRegion,
    mappedIds: items.map(item => item.inputId),
    pressedIds,
    items,
  }
}
