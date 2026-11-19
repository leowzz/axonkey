import type { MappingInput, Platform } from '../../appTypes.ts'
import { triggerTypes } from '../../behaviorModel.ts'
import type { Behavior, TriggerBehaviors } from '../../behaviorModel.ts'
import { behaviorSummary, triggerLabels } from '../../behaviorSummary.ts'

export type RailOverviewItem = {
  input: MappingInput<string>
  summary: string
  short?: string
  warning?: string
  groups: { label: string; behaviors: Behavior[] }[]
  hasAbbreviatedDetails: boolean
}

/** Exclude non-button controls (analog sticks, triggers, screens) from key overview. */
export function isOverviewButton(
  input: MappingInput<string> & { kind?: string },
  viewButtons?: readonly { id: string; kind?: string }[],
): boolean {
  const kind = input.kind ?? viewButtons?.find(button => button.id === input.id)?.kind
  return kind === undefined || kind === 'button' || kind === 'hat'
}

export function isButtonConfigured(sequences: TriggerBehaviors | undefined): boolean {
  return Boolean(sequences && triggerTypes.some(trigger => (sequences[trigger]?.length ?? 0) > 0))
}

export function summarizeRailButton(sequences: TriggerBehaviors | undefined, platform: Platform): string {
  if (!sequences) return ''
  const parts: string[] = []
  for (const trigger of triggerTypes) {
    const list = sequences[trigger] ?? []
    if (list.length === 0) continue
    const label = triggerLabels[trigger]
    const active = list.filter(behavior => behavior.enabled)
    if (active.length === 0) {
      parts.push(`${label}: 已停用`)
      continue
    }
    const head = behaviorSummary(active[0], platform)
    parts.push(`${label}: ${head}${active.length > 1 ? ` 等${active.length}步` : ''}`)
  }
  return parts.join(' · ')
}

export function railKeyGlyphText(input: MappingInput<string>, short?: string): string | null {
  if (input.icon !== 'center') return null
  if (short === '确认' || input.id === 'confirm' || input.id.endsWith('.confirm')) return 'OK'
  return short ?? null
}

export function buildRailOverviewItems(
  inputs: readonly MappingInput<string>[],
  behaviors: Record<string, TriggerBehaviors>,
  platform: Platform,
  viewButtons?: readonly { id: string; kind?: string; short?: string }[],
  warnings?: Readonly<Record<string, string>>,
): RailOverviewItem[] {
  const items: RailOverviewItem[] = []
  for (const input of inputs) {
    if (!isOverviewButton(input, viewButtons)) continue
    const sequences = behaviors[input.id]
    const warning = warnings?.[input.id]
    if (!isButtonConfigured(sequences) && !warning) continue
    const groups = triggerTypes.flatMap(trigger => {
      const list = sequences?.[trigger] ?? []
      return list.length > 0 ? [{ label: triggerLabels[trigger], behaviors: list }] : []
    })
    const totalBehaviors = groups.reduce((count, group) => count + group.behaviors.length, 0)
    const hasAbbreviatedDetails =
      totalBehaviors > 1 ||
      groups.some(group =>
        group.behaviors.some(
          behavior => (behavior.type === 'paste' || behavior.type === 'typeText') && behavior.text.length > 12,
        ),
      )
    const baseSummary = summarizeRailButton(sequences, platform)
    items.push({
      input,
      summary: baseSummary ? (warning ? `${baseSummary} · ${warning}` : baseSummary) : (warning ?? ''),
      short: viewButtons?.find(button => button.id === input.id)?.short,
      ...(warning ? { warning } : {}),
      groups,
      hasAbbreviatedDetails,
    })
  }
  return items
}

export function shouldOpenRailSummaryPopover(anchor: HTMLElement, hasAbbreviatedDetails: boolean): boolean {
  if (hasAbbreviatedDetails) return true
  const summary = anchor.querySelector?.<HTMLElement>('.rail-keymap-summary')
  return Boolean(summary && summary.scrollWidth > summary.clientWidth + 1)
}
