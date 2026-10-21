import { useEffect, useRef } from 'react'
import { Check, ChevronDown, Clock3, MousePointer2, MousePointerClick } from 'lucide-react'
import type { Behavior, BehaviorMap, ButtonId, TriggerType } from '../behaviorModel'
import { BehaviorSummaryPopover } from './BehaviorSummaryPopover'
import { iconFor, triggerLabels, triggerSummary } from '../appConfig'
import type { Platform, RemoteButton } from '../appTypes'

const triggerOrder: TriggerType[] = ['click', 'doubleClick', 'longPress']

type MappingKeyGridProps = {
  platform: Platform
  buttons: RemoteButton[]
  behaviors: BehaviorMap
  activeId: ButtonId
  pressedId: ButtonId | null
  rowRefs: { current: Partial<Record<ButtonId, HTMLElement>> }
  onSelect: (buttonId: ButtonId) => void
}

export function MappingKeyGrid({ platform, buttons, behaviors, activeId, pressedId, rowRefs, onSelect }: MappingKeyGridProps) {
  const disclosureRef = useRef<HTMLDetailsElement>(null)
  const summaryRef = useRef<HTMLElement>(null)

  useEffect(() => {
    const dismiss = (event: Event) => {
      const disclosure = disclosureRef.current
      if (!disclosure?.open || (event.target instanceof Node && disclosure.contains(event.target))) return
      disclosure.open = false
    }
    const keydown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || !disclosureRef.current?.open) return
      event.preventDefault()
      disclosureRef.current.open = false
      summaryRef.current?.focus({ preventScroll: true })
    }
    window.addEventListener('pointerdown', dismiss)
    window.addEventListener('focusin', dismiss)
    window.addEventListener('scroll', dismiss, true)
    window.addEventListener('resize', dismiss)
    window.addEventListener('keydown', keydown)
    return () => {
      window.removeEventListener('pointerdown', dismiss)
      window.removeEventListener('focusin', dismiss)
      window.removeEventListener('scroll', dismiss, true)
      window.removeEventListener('resize', dismiss)
      window.removeEventListener('keydown', keydown)
    }
  }, [])

  return <details ref={disclosureRef} className="mapping-key-grid-disclosure">
    <summary ref={summaryRef} aria-label={`选择按键，当前：${buttons.find((button) => button.id === activeId)?.label}`}>
      <span className="mapping-key-grid-selection">{buttons.find((button) => button.id === activeId)?.label}</span>
      <ChevronDown size={16} aria-hidden="true" />
    </summary>
    <div className="mapping-key-grid">
    {buttons.map((button) => {
      const configuredTriggers = triggerOrder.filter((trigger) => behaviors[button.id][trigger].length > 0)
      const active = activeId === button.id
      const pressed = pressedId === button.id

      return <article
        key={button.id}
        ref={(node) => { if (node) rowRefs.current[button.id] = node }}
        className={`mapping-key ${active ? 'active' : ''} ${pressed ? 'pressed' : ''}`}
      >
        <BehaviorSummaryPopover openDelay={500} label={button.label} platform={platform} groups={configuredTriggers.map((trigger) => ({ label: triggerLabels[trigger], behaviors: behaviors[button.id][trigger] }))}>
        <button type="button" aria-pressed={active} onClick={() => {
          if (disclosureRef.current) disclosureRef.current.open = false
          summaryRef.current?.focus({ preventScroll: true })
          onSelect(button.id)
        }}>
          <span className={`row-icon icon-${button.icon}`}>{iconFor(button.icon, 16)}</span>
          <span className="mapping-key-copy"><strong>{button.label}</strong></span>
          {configuredTriggers.length > 0 && <span className="mapping-key-status" aria-label={`${configuredTriggers.length} 个已设置触发方式`}>{configuredTriggers.length}</span>}
        </button>
        </BehaviorSummaryPopover>
      </article>
    })}
    </div>
  </details>
}

type MappingTriggerSelectorProps = {
  platform: Platform
  button: RemoteButton
  behaviors: Record<TriggerType, Behavior[]>
  trigger: TriggerType
  onSelect: (trigger: TriggerType) => void
}

const triggerIcons = {
  click: <MousePointerClick size={17} />,
  doubleClick: <MousePointer2 size={17} />,
  longPress: <Clock3 size={17} />,
}

export function MappingTriggerSelector({ platform, button, behaviors, trigger, onSelect }: MappingTriggerSelectorProps) {
  return <section className="trigger-selector" aria-labelledby="trigger-selector-title">
    <div className="trigger-selector-title">
      <span className={`row-icon icon-${button.icon}`}>{iconFor(button.icon, 17)}</span>
      <div><h2 id="trigger-selector-title">{button.label}</h2></div>
    </div>
    <div className="trigger-options" role="tablist" aria-label={`${button.label}触发方式`}>
      {triggerOrder.map((item) => {
        const selected = trigger === item
        const list = behaviors[item]
        return <BehaviorSummaryPopover openDelay={500} key={item} label={button.label} platform={platform} groups={list.length > 1 ? [{ label: triggerLabels[item], behaviors: list }] : []}><button
          type="button"
          role="tab"
          aria-selected={selected}
          className={selected ? 'active' : ''}
          onClick={() => onSelect(item)}
        >
          <span className="trigger-option-icon">{triggerIcons[item]}</span>
          <span className="trigger-option-copy"><strong>{triggerLabels[item]}</strong><small>{triggerSummary(list, item, platform)}</small></span>
          {selected ? <Check size={17} strokeWidth={3} aria-hidden="true" /> : list.length > 0 && <span className="trigger-option-dot" />}
        </button></BehaviorSummaryPopover>
      })}
    </div>
  </section>
}
