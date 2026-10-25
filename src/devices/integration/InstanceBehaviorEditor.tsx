import { useState } from 'react'
import { createPortal } from 'react-dom'
import { ArrowDown, ArrowUp, Pencil, Plus, Trash2 } from 'lucide-react'
import type { MappingInput, Platform } from '../../appTypes'
import { behaviorSummary, behaviorTypeLabels, triggerLabels } from '../../appConfig'
import { behaviorTypes, createBehavior, triggerTypes } from '../../behaviorModel'
import type { Behavior, BehaviorType, CreateBehaviorOptions, TriggerBehaviors, TriggerType } from '../../behaviorModel'
import { WorkflowStepDialog } from '../../components/WorkflowStepDialog'

export function InstanceBehaviorEditor({ button, platform, sequences, onChange }: { button: MappingInput<string>; platform: Platform; sequences: TriggerBehaviors; onChange: (sequences: TriggerBehaviors) => void }) {
  const [trigger, setTrigger] = useState<TriggerType>('click')
  const [type, setType] = useState<BehaviorType>('key')
  const [editing, setEditing] = useState<{ behavior: Behavior; fresh: boolean } | null>(null)
  const sequence = sequences[trigger]
  const change = (items: Behavior[]) => onChange({ ...sequences, [trigger]: items })
  const move = (index: number, delta: number) => { const items = [...sequence]; [items[index], items[index + delta]] = [items[index + delta], items[index]]; change(items) }
  const add = () => {
    const options: CreateBehaviorOptions = type === 'wheel' || type === 'cursorMove' ? { type, direction: 'up' } : type === 'mouse' ? { type, button: 'left' } : { type }
    setEditing({ behavior: createBehavior(options), fresh: true })
  }
  return <section className="managed-behavior-editor" aria-label={`${button.label}行为编辑`}>
    <header><span className="managed-caption">当前输入</span><h2>{button.label}</h2><p>为这个设备单独设置动作</p></header>
    <div className="managed-trigger-tabs" role="tablist" aria-label="触发方式">{triggerTypes.map(id => <button key={id} role="tab" aria-selected={trigger === id} onClick={() => setTrigger(id)}>{triggerLabels[id]}<small>{sequences[id].length || ''}</small></button>)}</div>
    <div className="managed-action-list" role="tabpanel" aria-label={`${triggerLabels[trigger]}动作`}>
      {sequence.length ? sequence.map((behavior, index) => <div className="managed-action" key={behavior.id}><span className="managed-action-order">{index + 1}</span><label><input type="checkbox" aria-label={`启用动作 ${index + 1}`} checked={behavior.enabled} onChange={e => change(sequence.map(b => b.id === behavior.id ? { ...b, enabled: e.target.checked } : b))} /><span><small>{behaviorTypeLabels[behavior.type]}</small><strong>{behaviorSummary(behavior, platform)}</strong></span></label><div className="managed-action-tools"><button aria-label={`编辑动作 ${index + 1}`} onClick={() => setEditing({ behavior, fresh: false })}><Pencil size={13} /></button><button disabled={index === 0} aria-label={`上移动作 ${index + 1}`} onClick={() => move(index, -1)}><ArrowUp size={13} /></button><button disabled={index === sequence.length - 1} aria-label={`下移动作 ${index + 1}`} onClick={() => move(index, 1)}><ArrowDown size={13} /></button><button aria-label={`删除动作 ${index + 1}`} onClick={() => change(sequence.filter(b => b.id !== behavior.id))}><Trash2 size={13} /></button></div></div>) : <div className="managed-action-empty">尚未设置动作<small>{button.originalDescription}</small></div>}
    </div>
    <div className="managed-add-action"><select aria-label="要添加的动作类型" value={type} onChange={e => setType(e.target.value as BehaviorType)}>{behaviorTypes.map(value => <option key={value} value={value}>{behaviorTypeLabels[value]}</option>)}</select><button onClick={add}><Plus size={14} />添加动作</button></div>
    <p className="managed-caption">自动保存 · 按顺序执行 · 仅作用于当前实例和配置</p>
    {editing && createPortal(<WorkflowStepDialog edit={{ stepId: editing.behavior.id, trigger, behavior: editing.behavior, onSave: behavior => { change(editing.fresh ? [...sequence, behavior] : sequence.map(b => b.id === behavior.id ? behavior : b)); setEditing(null) } }} platform={platform} button={button} title={`${editing.fresh ? '添加' : '编辑'}${behaviorTypeLabels[editing.behavior.type]}`} onClose={() => setEditing(null)} />, document.body)}
  </section>
}
