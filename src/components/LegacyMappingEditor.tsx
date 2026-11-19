import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import type { Behavior, TriggerType } from '../behaviorModel'
import { normalizeBehavior, serializeSequence } from '../behaviorModel'
import { writeClipboardText } from '../clipboard'
import { behaviorSummary, triggerLabels } from '../appConfig'
import { BehaviorEditor, SequencePasteDialog } from './BehaviorEditor'
import { SelectControl } from './SelectControl'
import { WorkflowStepDialog } from './WorkflowStepDialog'
import { insertedWorkflowSteps } from './workflowBehaviorBridge'
import { workflowStepBehavior } from './workflowStepEditing'
import type { WorkflowAxonkeyProps } from './WorkflowAxonkey'
import './LegacyMappingEditor.css'

export function LegacyMappingEditor<Id extends string>({
  header,
  platform,
  button,
  sequences,
  activeTrigger,
  onChange,
  onRequestProfileSwitch,
  quickOverlayContext,
}: WorkflowAxonkeyProps<Id>) {
  const [selectedTrigger, setSelectedTrigger] = useState<TriggerType>('click')
  const trigger = button.triggerLabel ? 'click' : (activeTrigger ?? selectedTrigger)
  const [edit, setEdit] = useState<{
    behavior: Behavior
    replacement?: Behavior[]
    mode?: 'replace' | 'append'
  } | null>(null)
  const [paste, setPaste] = useState(false)
  const [status, setStatus] = useState('')
  const editorRef = useRef<HTMLElement>(null)
  const triggerRef = useRef<HTMLDivElement>(null)
  const list = sequences[trigger]
  useEffect(() => {
    setEdit(null)
    setPaste(false)
    setStatus('')
  }, [button.id])

  const save = (next: Behavior[]) => {
    if (onChange(button.id, { ...sequences, [trigger]: next }) === false) return false
    return true
  }
  const applyPreset = (preset: string, mode: 'replace' | 'append') => {
    if (preset === 'original') {
      save([])
      return
    }
    const nodes = insertedWorkflowSteps(
      {
        id: crypto.randomUUID(),
        componentType: 'task',
        type: preset,
        name: preset,
        properties: {},
      },
      platform,
      behavior => behaviorSummary(behavior, platform),
    )
    const replacement = nodes.map(node => workflowStepBehavior(node)!)
    if (preset === 'customKey') replacement[0] = { id: replacement[0].id, type: 'shortcut', keys: [], enabled: true }
    if (nodes.some(node => node.properties.draftGroup) || preset === 'customKey' || preset === 'delay') {
      setEdit({ behavior: replacement[0], replacement, mode })
    } else save(mode === 'replace' ? replacement : [...list, ...replacement])
  }

  return (
    <div className="legacy-mapping-editor">
      {header}
      <div className="legacy-mapping-scroll">
        {!button.triggerLabel && !activeTrigger && (
          <div ref={triggerRef} className="legacy-mapping-trigger">
            <label htmlFor="legacy-mapping-trigger">触发方式：</label>
            <SelectControl
              id="legacy-mapping-trigger"
              value={trigger}
              onChange={event => setSelectedTrigger(event.target.value as TriggerType)}
            >
              {(['click', 'doubleClick', 'longPress'] as const).map(item => (
                <option key={item} value={item}>
                  {triggerLabels[item]}
                </option>
              ))}
            </SelectControl>
          </div>
        )}
        <BehaviorEditor
          key={`${button.id}-${trigger}`}
          editorRef={editorRef}
          attention={false}
          platform={platform}
          button={button}
          trigger={trigger}
          behaviors={list}
          onApplyCommonBehavior={preset => applyPreset(preset, 'replace')}
          onAddAdvancedBehavior={type => applyPreset(type === 'key' ? 'customKey' : type, 'append')}
          onRemoveBehavior={id => {
            if (save(list.filter(item => item.id !== id))) {
              editorRef.current?.querySelector<HTMLButtonElement>('.behavior-sequence-actions button')?.focus()
              setStatus('行为已删除')
            }
          }}
          onMoveBehavior={(id, direction) => {
            const next = [...list]
            const index = next.findIndex(item => item.id === id)
            const target = index + direction
            ;[next[index], next[target]] = [next[target], next[index]]
            save(next)
          }}
          onEditBehavior={id => setEdit({ behavior: list.find(item => item.id === id)! })}
          onReturnToMappings={() => triggerRef.current?.querySelector('select')?.focus()}
          onCopySequence={() => {
            void writeClipboardText(serializeSequence(list))
              .then(() => setStatus('序列已复制'))
              .catch(() => setStatus('复制失败，请重试'))
          }}
          onPasteSequence={() => setPaste(true)}
          onClearSequence={() => save([])}
        />
      </div>
      {status && <span role="status">{status}</span>}
      {edit &&
        createPortal(
          <WorkflowStepDialog
            key={edit.behavior.id}
            platform={platform}
            button={button}
            quickOverlayContext={quickOverlayContext}
            onClose={() => setEdit(null)}
            edit={{
              stepId: edit.behavior.id,
              trigger,
              behavior: edit.behavior,
              onSave: value => {
                const behavior = normalizeBehavior(value)
                if (!behavior) return
                if (behavior.type === 'switchProfile') onRequestProfileSwitch(button.id, trigger, behavior)
                else {
                  const replacement = edit.replacement?.map(item => (item.id === behavior.id ? behavior : item)) ?? [
                    behavior,
                  ]
                  const next =
                    edit.mode === 'replace'
                      ? replacement
                      : edit.mode === 'append'
                        ? [...list, ...replacement]
                        : list.map(item => (item.id === behavior.id ? behavior : item))
                  if (!save(next)) return
                }
                setEdit(null)
              },
            }}
          />,
          document.body,
        )}
      {paste &&
        createPortal(
          <SequencePasteDialog
            platform={platform}
            button={button}
            trigger={trigger}
            onClose={() => setPaste(false)}
            onApply={next => {
              const profileSwitch = next.find(item => item.type === 'switchProfile')
              if (profileSwitch?.type === 'switchProfile') onRequestProfileSwitch(button.id, trigger, profileSwitch)
              else if (!save(next)) return
              setPaste(false)
            }}
          />,
          document.body,
        )}
    </div>
  )
}
