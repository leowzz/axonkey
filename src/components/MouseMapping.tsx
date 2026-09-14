import { ArrowDown, ArrowLeft, ArrowRight, ArrowUp, Mouse, MousePointer2 } from 'lucide-react'
import type { BehaviorMap, InputId } from '../behaviorModel'
import type { MappingInput, Platform } from '../appTypes'
import { behaviorSummary } from '../appConfig'
import { mouseInputIds } from '../deviceModel'

const edges = [{ id: 'top', label: '上边缘' }, { id: 'left', label: '左边缘' }, { id: 'right', label: '右边缘' }] as const
const directions = {
  up: { label: '向上滚动', Icon: ArrowUp }, down: { label: '向下滚动', Icon: ArrowDown },
  left: { label: '向左滚动', Icon: ArrowLeft }, right: { label: '向右滚动', Icon: ArrowRight },
}
export const mouseInputs: MappingInput[] = mouseInputIds.map((id) => {
  const [, edge, direction] = id.split('.')
  const icon = direction as keyof typeof directions
  return { id, label: directions[icon].label, icon, triggerLabel: `屏幕${edges.find((item) => item.id === edge)!.label}`, originalLabel: '保留原始滚动' }
})

export function MouseDeviceIllustration() {
  return <div className="mouse-device-illustration">
    <div className="mouse-device-icon"><Mouse size={76} strokeWidth={1} /></div>
    <strong>屏幕边缘，让滚动多一种用途</strong>
    <p>将指针移到屏幕上边缘或左右边缘，滚动鼠标即可触发对应行为。</p>
    <div className="mouse-device-note">适用于系统鼠标<br />每个滚动方向独立配置</div>
  </div>
}

export function MouseMappingPicker({ behaviors, activeId, platform, onSelect, rowRefs }: {
  behaviors: BehaviorMap
  activeId: InputId
  platform: Platform
  onSelect: (id: InputId) => void
  rowRefs: { current: Partial<Record<InputId, HTMLElement>> }
}) {
  const edge = edges.find((item) => item.id === activeId.split('.')[1]) ?? edges[0]
  const inputs = mouseInputs.filter((input) => input.id.startsWith(`mouse.${edge.id}.`))
  return <div className="mouse-mapping-picker">
    <div className="mouse-edge-tabs" role="group" aria-label="屏幕触发边缘">
      {edges.map((item) => <button type="button" key={item.id} aria-pressed={item.id === edge.id} onClick={() => onSelect(`mouse.${item.id}.up`)}>{item.label}</button>)}
    </div>
    <div className="mouse-edge-preview">
      <div className={`mouse-screen mouse-screen-${edge.id}`} aria-label={`屏幕${edge.label}触发区域示意`}>
        <div className="mouse-screen-edge" />
        <span className="mouse-screen-edge-label">{edge.label} · 8 {platform === 'macos' ? '点' : '像素'}</span>
        <MousePointer2 size={27} className="mouse-screen-pointer" />
        <span className="mouse-screen-caption">将鼠标移到这里</span>
      </div>
      <div className="mouse-edge-description"><span className="section-kicker">触发区域</span><h3>屏幕{edge.label}</h3><p>选择滚动方向，再配置要执行的行为。每个边缘的映射独立保存。</p><small>{edge.id === 'top' ? '支持多显示器；左右滚动需要水平滚轮或横向滚动手势。' : '指针靠近这一侧边缘时触发；顶部角落优先使用上边缘映射。'}</small></div>
    </div>
    <div className={`mouse-direction-grid ${inputs.length === 2 ? 'two-directions' : ''}`} role="group" aria-label={`${edge.label}滚动方向`}>
      {inputs.map((input) => {
        const Icon = directions[input.icon as keyof typeof directions].Icon
        const list = behaviors[input.id].click.filter((behavior) => behavior.enabled)
        return <button type="button" key={input.id} ref={(node) => { if (node) rowRefs.current[input.id] = node }} aria-pressed={input.id === activeId} className={input.id === activeId ? 'active' : ''} onClick={() => onSelect(input.id)}>
          <Icon size={20} /><strong>{input.label}</strong><small>{list.length ? `${behaviorSummary(list[0], platform)}${list.length > 1 ? ` +${list.length - 1}` : ''}` : '保留原始滚动'}</small>
        </button>
      })}
    </div>
  </div>
}
