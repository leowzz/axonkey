import { Keyboard } from 'lucide-react'
import type { Behavior, BehaviorMap, ButtonId, TriggerType } from '../behaviorModel'
import { iconFor, triggerLabels, triggerSummary } from '../appConfig'
import type { Platform, RemoteButton } from '../appTypes'

type MappingSideProps = {
  platform: Platform
  side: 'left' | 'right'
  buttons: RemoteButton[]
  behaviors: BehaviorMap
  activeId: ButtonId
  pressedId: ButtonId | null
  selectedBehavior: { buttonId: ButtonId; trigger: TriggerType }
  rowRefs: { current: Partial<Record<ButtonId, HTMLDivElement>> }
  selectBehaviorTarget: (buttonId: ButtonId, trigger: TriggerType) => void
}

export function MappingSide({ platform, side, buttons: sideButtons, behaviors, activeId, pressedId, selectedBehavior, rowRefs, selectBehaviorTarget }: MappingSideProps) {
  return <section className={`mapping-side panel-surface ${side}`}>
    <div className="mapping-list">
      {sideButtons.map((button) => (
        <MappingRow
          key={button.id}
          platform={platform}
          button={button}
          behaviors={behaviors[button.id]}
          active={activeId === button.id}
          pressed={pressedId === button.id}
          selectedTrigger={selectedBehavior.buttonId === button.id ? selectedBehavior.trigger : null}
          rowRef={(node) => { if (node) rowRefs.current[button.id] = node }}
          onSelect={() => selectBehaviorTarget(button.id, 'click')}
          onSelectTrigger={(trigger) => selectBehaviorTarget(button.id, trigger)}
        />
      ))}
    </div>
  </section>
}

type MappingRowProps = {
  platform: Platform
  button: RemoteButton
  behaviors: Record<TriggerType, Behavior[]>
  active: boolean
  pressed: boolean
  selectedTrigger: TriggerType | null
  rowRef: (node: HTMLDivElement | null) => void
  onSelect: () => void
  onSelectTrigger: (trigger: TriggerType) => void
}

function MappingRow({ platform, button, behaviors, active, pressed, selectedTrigger, rowRef, onSelect, onSelectTrigger }: MappingRowProps) {
  const triggerOrder: TriggerType[] = ['click', 'doubleClick', 'longPress']
  const hasBehavior = triggerOrder.some((trigger) => behaviors[trigger].length > 0)
  return <article ref={rowRef} className={`mapping-card ${active ? 'active' : ''} ${pressed ? 'pressed' : ''}`} onClick={onSelect}>
    <div className="mapping-card-title"><span className={`row-icon icon-${button.icon}`}>{iconFor(button.icon, 17)}</span><strong>{button.label}</strong><span className="card-status">{hasBehavior ? '已设置' : '默认'}</span></div>
    <div className="action-slots">
      {triggerOrder.map((trigger) => {
        const selected = selectedTrigger === trigger
        const list = behaviors[trigger]
        return <button
          key={trigger}
          type="button"
          className={`action-slot ${list.length === 0 ? 'muted' : 'configured'} ${selected ? 'selected' : ''}`}
          aria-label={`${button.label}${triggerLabels[trigger]}行为`}
          onClick={(event) => { event.stopPropagation(); onSelectTrigger(trigger) }}
        >
          <span className="slot-label">{triggerLabels[trigger]}</span>
          <Keyboard size={14} className="slot-icon" />
          <strong>{triggerSummary(list, trigger, platform)}</strong>
        </button>
      })}
    </div>
  </article>
}
