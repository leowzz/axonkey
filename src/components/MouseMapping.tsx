import { ArrowDown, ArrowLeft, ArrowRight, ArrowUp, Check, Clock3, Mouse, MousePointer2, MousePointerClick } from 'lucide-react'
import type { BehaviorMap, InputId, TriggerType } from '../behaviorModel'
import type { MappingInput, Platform } from '../appTypes'
import { behaviorSummary, triggerLabels } from '../appConfig'
import { mouseControls, mouseInputId, mouseInputIds, mouseInputParts, mouseScopesForControl } from '../deviceModel'
import type { MouseControlId } from '../deviceModel'

const icons = { up: ArrowUp, down: ArrowDown, left: ArrowLeft, right: ArrowRight, buttonLeft: MousePointer2, buttonForward: MousePointer2, buttonBack: MousePointer2, buttonRight: MousePointer2 }
export const mouseInputs: MappingInput[] = mouseInputIds.map((id) => {
  const { scope, control } = mouseInputParts(id)
  return {
    id, label: control.label, icon: control.icon,
    contextLabel: scope.label,
    inheritDefault: control.kind === 'wheel' && scope.id !== 'global',
    triggerLabel: control.kind === 'wheel' ? '滚动一次' : undefined,
    originalLabel: control.kind === 'button' ? '保留原始点击' : scope.id !== 'global' ? '沿用任意位置' : '保留原始滚动',
    originalDescription: control.kind === 'wheel' && scope.id !== 'global' ? '使用任意位置的设置' : '使用鼠标原始输入',
  }
})

export function MouseInputModel({ activeId, onSelect }: { activeId: InputId; onSelect: (id: InputId) => void }) {
  const { scope, control: selected } = mouseInputParts(activeId)
  const part = (id: MouseControlId, label: string) => {
    const Icon = icons[id]
    return <button type="button" className={`mouse-part mouse-part-${id}`} aria-label={`选择${mouseControls.find((item) => item.id === id)!.label}`} aria-pressed={selected.id === id} onClick={() => onSelect(mouseInputId(scope.id, id))}><Icon size={18} /><span>{label}</span></button>
  }
  return <section className="mouse-model-section" aria-label="鼠标输入模型">
    <div className="mouse-model-title">选择输入部位</div>
    <div className="mouse-input-model">
      {part('buttonLeft', '左键')}{part('buttonForward', '前进')}{part('buttonBack', '后退')}{part('buttonRight', '右键')}
      <div className="mouse-wheel-track" aria-label="垂直滚轮方向">
        {part('up', '向上')}{part('down', '向下')}
      </div>
      <div className="mouse-horizontal-track" aria-label="水平滚轮方向">
        <span className="mouse-track-label">水平滚轮</span>
        {part('left', '向左')}{part('right', '向右')}
      </div>
      <span className="mouse-model-mark"><Mouse size={14} /> MOUSE</span>
    </div>
    <strong className="mouse-model-selection">{selected.label}</strong>
    <p>兜底操作避免误配：连续快速按下 5 次 ESC，会关闭鼠标映射开关。</p>
  </section>
}

type PickerProps = {
  behaviors: BehaviorMap
  activeId: InputId
  platform: Platform
  trigger: TriggerType
  onSelect: (id: InputId, trigger: TriggerType) => void
  rowRefs: { current: Partial<Record<InputId, HTMLElement>> }
}

export function MouseControlPicker({ activeId, onSelect }: Pick<PickerProps, 'activeId' | 'onSelect'>) {
  const { scope, control } = mouseInputParts(activeId)
  return <div className="mouse-control-grid" role="group" aria-label="鼠标输入部位">
    {mouseControls.map((item) => {
      const Icon = icons[item.id]
      return <button type="button" key={item.id} aria-pressed={item.id === control.id} onClick={() => onSelect(mouseInputId(scope.id, item.id), 'click')}><Icon size={18} /><span>{item.label}</span></button>
    })}
  </div>
}

export function MouseTriggerSelector({ behaviors, activeId, platform, trigger, onSelect, rowRefs }: PickerProps) {
  const { scope, control } = mouseInputParts(activeId)
  const triggers: TriggerType[] = control.kind === 'button' ? ['click', 'doubleClick', 'longPress'] : ['click']
  const triggerIcons = { click: control.kind === 'button' ? MousePointerClick : icons[control.id], doubleClick: MousePointerClick, longPress: Clock3 }
  const original = control.kind === 'button' ? '保留原始点击' : scope.id === 'global' ? '保留原始输入' : '沿用任意位置'
  return <section className="mouse-trigger-selector" ref={(node) => { if (node) rowRefs.current[activeId] = node }} aria-label={`${control.label}触发条件`}>
    <div className="mouse-trigger-heading"><h2>触发条件</h2><span>{control.label}</span></div>
    <div className="mouse-condition-row">
      <span className="mouse-condition-label">生效区域</span>
      <div className="mouse-scope-options" role="group" aria-label="鼠标生效区域">
        {mouseScopesForControl(control.id).map((item) => {
          const id = mouseInputId(item.id, control.id)
          const count = Object.values(behaviors[id]).filter((list) => list.some((behavior) => behavior.enabled)).length
          return <button type="button" className={`mouse-scope-option mouse-scope-${item.id}`} key={item.id} aria-pressed={item.id === scope.id} onClick={() => onSelect(id, trigger)}><span className="mouse-scope-diagram" aria-hidden="true"><span /></span><span>{item.label}</span>{count > 0 && <span className="mouse-configured-dot" aria-label="已配置" />}</button>
        })}
      </div>
    </div>
    <div className="mouse-condition-row">
      <span className="mouse-condition-label">触发方式</span>
      <div className={`mouse-gesture-options ${control.kind === 'wheel' ? 'wheel-gesture' : ''}`} role="tablist" aria-label={`${control.label}触发方式`}>
        {triggers.map((item) => {
          const Icon = triggerIcons[item]
          const ownList = behaviors[activeId][item].filter((behavior) => behavior.enabled)
          const inherited = control.kind === 'wheel' && scope.id !== 'global' && ownList.length === 0
          const list = inherited ? behaviors[mouseInputId('global', control.id)][item].filter((behavior) => behavior.enabled) : ownList
          return <button type="button" key={item} role="tab" aria-selected={trigger === item} onClick={() => onSelect(activeId, item)}><Icon size={17} /><span><strong>{control.kind === 'wheel' ? '滚动一次' : triggerLabels[item]}</strong><small>{list.length ? `${inherited ? '沿用 · ' : ''}${behaviorSummary(list[0], platform)}${list.length > 1 ? ` +${list.length - 1}` : ''}` : (control.kind === 'wheel' && scope.id !== 'global') || item === 'click' ? original : '未设置'}</small></span>{trigger === item && <Check size={15} />}</button>
        })}
      </div>
    </div>
    <p className="mouse-condition-note">{scope.id === 'global' ? '作为默认规则；已配置的屏幕边缘规则优先。' : `距屏幕${scope.label} 8 ${platform === 'macos' ? '点' : '像素'}内生效；${control.kind === 'button' ? '未设置时保留原始点击' : '未设置时沿用任意位置规则'}，顶部角落优先使用上边缘。`}{control.kind === 'button' ? ' 双击间隔 350 毫秒，长按 600 毫秒；配置后该按键用于触发行为，不用于拖拽。' : ' 每滚动一格执行一次。'}</p>
  </section>
}
