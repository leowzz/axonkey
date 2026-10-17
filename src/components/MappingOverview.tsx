import { useLayoutEffect, useRef, useState } from 'react'
import { ArrowUpRight, CircleDot } from 'lucide-react'
import { iconFor, triggerLabels, triggerSummary } from '../appConfig'
import { BehaviorSummaryPopover } from './BehaviorSummaryPopover'
import { triggerTypes } from '../behaviorModel'
import type { BehaviorMap, ButtonId, TriggerType } from '../behaviorModel'
import type { HitPosition, Platform, RemoteButton } from '../appTypes'

type Props = {
  buttons: RemoteButton[]
  behaviors: BehaviorMap
  positions: Record<ButtonId, HitPosition>
  platform: Platform
  enabled: boolean
  saveState: 'saved' | 'saving' | 'error'
  pressedId: ButtonId | null
  selection: { buttonId: ButtonId; trigger: TriggerType }
  onSelect: (id: ButtonId, trigger: TriggerType) => void
  onEdit: (id: ButtonId, trigger: TriggerType) => void
}

type Wire = { id: ButtonId; path: string }

export function MappingOverview({ buttons, behaviors, positions, platform, enabled, saveState, pressedId, selection, onSelect, onEdit }: Props) {
  const { buttonId: selectedId, trigger } = selection
  const [hoveredId, setHoveredId] = useState<ButtonId | null>(null)
  const [wires, setWires] = useState<Wire[]>([])
  const canvasRef = useRef<HTMLDivElement>(null)
  const imageRef = useRef<HTMLDivElement>(null)
  const cardRefs = useRef<Partial<Record<ButtonId, HTMLDivElement>>>({})
  const highlightedId = pressedId ?? hoveredId ?? selectedId
  const triggerCount = buttons.filter((button) => behaviors[button.id][trigger].length > 0).length

  // Use the editor artwork and calibrated percentage positions; resize keeps wires attached.
  useLayoutEffect(() => {
    const canvas = canvasRef.current
    const art = imageRef.current
    if (!canvas || !art) return
    const measure = () => {
      const root = canvas.getBoundingClientRect()
      const image = art.getBoundingClientRect()
      setWires(buttons.flatMap((button) => {
        const card = cardRefs.current[button.id]?.getBoundingClientRect()
        if (!card) return []
        const x1 = (button.side === 'left' ? card.right : card.left) - root.left
        const y1 = card.top + card.height / 2 - root.top
        const x2 = image.left - root.left + image.width * positions[button.id].x / 100
        const y2 = image.top - root.top + image.height * positions[button.id].y / 100
        const elbow = button.side === 'left' ? image.left - root.left - 22 : image.right - root.left + 22
        return [{ id: button.id, path: `M ${x1} ${y1} H ${elbow} L ${x2} ${y2}` }]
      }))
    }
    const observer = new ResizeObserver(measure)
    observer.observe(canvas)
    observer.observe(art)
    Object.values(cardRefs.current).forEach((card) => { if (card) observer.observe(card) })
    measure()
    return () => observer.disconnect()
  }, [buttons, positions])

  return <div className="mapping-overview">
    <section className="overview-surface" aria-label="当前按键映射示意图">
      <div className="overview-toolbar">
        <div className="overview-trigger-switch" role="group" aria-label="总览触发方式">
          {triggerTypes.map((type) => <button type="button" key={type} aria-pressed={type === trigger} className={type === trigger ? 'active' : ''} onClick={() => onSelect(selectedId, type)}>{triggerLabels[type]}</button>)}
        </div>
        <span className={`overview-save-state ${saveState === 'error' ? 'error' : ''}`}><span />{saveState === 'error' ? '应用失败 · 请进入编辑重试' : saveState === 'saving' ? '正在保存配置' : enabled ? '自定义按键已开启' : '自定义按键未开启'}</span>
      </div>
      <div className="overview-canvas" ref={canvasRef}>
        <svg className="overview-wires" aria-hidden="true">{wires.map((wire) => <path key={wire.id} d={wire.path} className={highlightedId === wire.id ? 'active' : ''} />)}</svg>
        {(['left', 'right'] as const).map((side) => <div key={side} className={`overview-cards overview-cards-${side}`}>
          {buttons.filter((button) => button.side === side).map((button) => {
            const list = behaviors[button.id][trigger]
            const summary = triggerSummary(list, trigger, platform)
            const paused = list.length > 0 && list.every((behavior) => !behavior.enabled)
            return <div key={button.id} ref={(node) => { if (node) cardRefs.current[button.id] = node }}
              className={`overview-key ${list.length ? 'configured' : ''} ${highlightedId === button.id ? 'highlighted' : ''} ${pressedId === button.id ? 'pressed' : ''}`}
              onMouseEnter={() => setHoveredId(button.id)} onMouseLeave={() => setHoveredId(null)}
              onFocus={() => setHoveredId(button.id)} onBlur={() => setHoveredId(null)}>
              <BehaviorSummaryPopover openDelay={500} label={button.label} platform={platform} groups={list.length > 1 ? [{ label: triggerLabels[trigger], behaviors: list }] : []}>
              <button type="button" className="overview-key-select" aria-pressed={selectedId === button.id} onClick={() => onSelect(button.id, trigger)}>
              <span className="overview-key-icon">{iconFor(button.icon, 18)}</span>
              <span className="overview-key-copy"><span className="overview-key-name">{button.label}</span><strong>{summary}</strong></span>
              </button>
              </BehaviorSummaryPopover>
              <span className="overview-key-actions"><small>{paused ? '动作已停用' : list.length ? `${list.length} 个动作` : trigger === 'click' ? '默认' : '未设置'}</small><button type="button" className="overview-key-edit" aria-label={`编辑${button.label}${triggerLabels[trigger]}映射`} onClick={() => { onSelect(button.id, trigger); onEdit(button.id, trigger) }}>编辑 <ArrowUpRight size={12} /></button></span>
            </div>
          })}
        </div>)}
        <div className="overview-device">
          <div className="overview-art" ref={imageRef}>
            <img src="/rc003-remote-keymap.png" alt="小米 RC003 遥控器，按键位置与映射编辑页一致" />
            {buttons.map((button) => <button type="button" key={button.id} aria-label={`查看${button.label}映射`} aria-pressed={selectedId === button.id}
              className={`overview-marker ${highlightedId === button.id ? 'active' : ''} ${behaviors[button.id][trigger].length ? 'configured' : ''}`}
              style={{ left: `${positions[button.id].x}%`, top: `${positions[button.id].y}%` }}
              onClick={() => onSelect(button.id, trigger)} onMouseEnter={() => setHoveredId(button.id)} onMouseLeave={() => setHoveredId(null)}
              onFocus={() => setHoveredId(button.id)} onBlur={() => setHoveredId(null)}><span /></button>)}
          </div>
          <span className="overview-device-label"><span>RC003</span></span>
        </div>
      </div>
      <div className="overview-legend"><span><CircleDot size={13} /> {triggerLabels[trigger]} · {triggerCount} 个按键已配置</span><span>点击编辑调整动作 · 实体按下时同步高亮</span></div>
    </section>
  </div>
}
