import { Clock3, MousePointer2, MousePointerClick } from 'lucide-react'
import type { Behavior, BehaviorMap, ButtonId, TriggerType } from '../behaviorModel'
import { iconFor, triggerLabels, triggerSummary } from '../appConfig'
import type { Platform, RemoteButton } from '../appTypes'

const triggerOrder: TriggerType[] = ['click', 'doubleClick', 'longPress']

type MappingKeyGridProps = {
  platform: Platform
  buttons: RemoteButton[]
  behaviors: BehaviorMap
  activeId: ButtonId
  pressedId: ButtonId | null
  selectedBehavior: { buttonId: ButtonId; trigger: TriggerType }
  rowRefs: { current: Partial<Record<ButtonId, HTMLElement>> }
  onSelect: (buttonId: ButtonId) => void
}

export function MappingKeyGrid({ platform, buttons, behaviors, activeId, pressedId, selectedBehavior, rowRefs, onSelect }: MappingKeyGridProps) {
  return <div className="mapping-key-grid">
    {buttons.map((button) => {
      const configuredTriggers = triggerOrder.filter((trigger) => behaviors[button.id][trigger].length > 0)
      const selectedTrigger = selectedBehavior.buttonId === button.id ? selectedBehavior.trigger : null
      const summaryTrigger = selectedTrigger ?? configuredTriggers[0] ?? 'click'
      const summary = triggerSummary(behaviors[button.id][summaryTrigger], summaryTrigger, platform)
      const active = activeId === button.id
      const pressed = pressedId === button.id

      return <article
        key={button.id}
        ref={(node) => { if (node) rowRefs.current[button.id] = node }}
        className={`mapping-key ${active ? 'active' : ''} ${pressed ? 'pressed' : ''}`}
      >
        <button type="button" aria-pressed={active} onClick={() => onSelect(button.id)}>
          <span className={`row-icon icon-${button.icon}`}>{iconFor(button.icon, 16)}</span>
          <span className="mapping-key-copy"><strong>{button.label}</strong><small>{summary}</small></span>
          <span className={`mapping-key-status ${configuredTriggers.length > 0 ? 'configured' : ''}`} aria-label={`${configuredTriggers.length} 个已设置触发方式`}>{configuredTriggers.length || '—'}</span>
        </button>
      </article>
    })}
  </div>
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
      <div><span className="section-kicker">SELECTED KEY</span><h2 id="trigger-selector-title">{button.label}</h2></div>
    </div>
    <div className="trigger-options" role="tablist" aria-label={`${button.label}触发方式`}>
      {triggerOrder.map((item) => {
        const selected = trigger === item
        const list = behaviors[item]
        return <button
          key={item}
          type="button"
          role="tab"
          aria-selected={selected}
          className={selected ? 'active' : ''}
          onClick={() => onSelect(item)}
        >
          <span className="trigger-option-icon">{triggerIcons[item]}</span>
          <span className="trigger-option-copy"><strong>{triggerLabels[item]}</strong><small>{triggerSummary(list, item, platform)}</small></span>
          <span className={`trigger-option-dot ${list.length > 0 ? 'configured' : ''}`} />
        </button>
      })}
    </div>
  </section>
}
