import type { ReactNode } from 'react'
import { useEffect, useRef, useState } from 'react'
import { Trash2 } from 'lucide-react'
import { behaviorFromCapturedKey, behaviorTypeLabels, formatCapturedKey } from '../appConfig'
import type { Behavior, TriggerType } from '../behaviorModel'
import type { MappingInput, Platform } from '../appTypes'
import { BehaviorEditDialog } from './BehaviorEditor'
import { isWorkflowActionChoiceSelected, workflowActionChoiceGroup } from './workflowActionChoices'

export type WorkflowStepEdit = {
  stepId: string
  trigger: TriggerType
  behavior: Behavior
  onSave: (behavior: Behavior) => void
  onDelete?: () => void
}

export function WorkflowStepDialog({
  edit,
  platform,
  button,
  onClose,
  children,
  title,
  saveLabel,
  saveTone,
  inline = false,
}: {
  edit: WorkflowStepEdit
  platform: Platform
  button: MappingInput<string>
  onClose: () => void
  children?: ReactNode
  title?: string
  saveLabel?: string
  saveTone?: 'warning'
  inline?: boolean
}) {
  const [behavior, setBehavior] = useState(edit.behavior)
  const [capturing, setCapturing] = useState(edit.behavior.type === 'shortcut' && edit.behavior.keys.length === 0)
  const ref = useRef<HTMLDivElement>(null)
  const choiceGroup = workflowActionChoiceGroup(edit.behavior)

  useEffect(() => setBehavior(edit.behavior), [edit.behavior])

  const updateBehavior = (next: Behavior) => {
    setBehavior(next)
    if (inline) edit.onSave(next)
  }

  useEffect(() => {
    if (inline) return
    const app = document.getElementById('root')
    const wasInert = app?.inert ?? false
    const previousFocus = document.activeElement
    const overflow = document.body.style.overflow
    if (app) app.inert = true
    document.body.style.overflow = 'hidden'
    if (!ref.current?.contains(document.activeElement)) ref.current?.querySelector<HTMLButtonElement>('button')?.focus()
    return () => {
      if (app) app.inert = wasInert
      document.body.style.overflow = overflow
      const node = document.querySelector<HTMLElement | SVGElement>(
        `.workflow-axonkey-canvas [data-step-id="${CSS.escape(edit.stepId)}"]`,
      )
      if (node) node.focus()
      else if (
        (previousFocus instanceof HTMLElement || previousFocus instanceof SVGElement) &&
        previousFocus.isConnected
      )
        previousFocus.focus()
    }
  }, [edit.stepId, inline])

  return (
    <div
      ref={ref}
      className={`mapping-active workflow-step-editor${inline ? ' workflow-step-inline' : ''}`}
      onKeyDownCapture={event => {
        if (capturing) return
        if (event.key === 'Escape') {
          event.preventDefault()
          event.stopPropagation()
          onClose()
        }
        if (inline || event.key !== 'Tab') return
        const elements = Array.from(
          ref.current?.querySelectorAll<HTMLElement>(
            'button:not(:disabled), input:not(:disabled), textarea, select:not(:disabled), [tabindex="0"]',
          ) ?? [],
        )
        const first = elements[0]
        const last = elements[elements.length - 1]
        if (event.shiftKey && document.activeElement === first) {
          event.preventDefault()
          last?.focus()
        } else if (!event.shiftKey && document.activeElement === last) {
          event.preventDefault()
          first?.focus()
        }
      }}
    >
      <BehaviorEditDialog
        platform={platform}
        button={button}
        trigger={edit.trigger}
        behavior={behavior}
        draft={!inline}
        inline={inline}
        delayStep={1}
        title={
          title ??
          (inline
            ? (choiceGroup?.title ?? behaviorTypeLabels[behavior.type])
            : `编辑${choiceGroup?.title ?? behaviorTypeLabels[behavior.type]}行为`)
        }
        saveLabel={saveLabel}
        saveTone={saveTone}
        headerActions={
          inline && edit.onDelete ? (
            <button type="button" className="workflow-inline-delete" onClick={edit.onDelete}>
              <Trash2 size={15} aria-hidden="true" />
              删除行为
            </button>
          ) : undefined
        }
        children={children}
        actionChoices={
          choiceGroup
            ? {
                label: choiceGroup.label,
                options: choiceGroup.options.map(option => ({
                  label: option.label,
                  selected: isWorkflowActionChoiceSelected(behavior, option),
                  behavior: {
                    id: behavior.id,
                    enabled: behavior.enabled,
                    ...(behavior.libraryItemId ? { libraryItemId: behavior.libraryItemId } : {}),
                    ...option.behavior,
                  },
                })),
              }
            : undefined
        }
        capturing={capturing}
        onStartCapture={() => setCapturing(true)}
        onCancelCapture={() => setCapturing(false)}
        onCaptureKey={(_current, event) => {
          event.preventDefault()
          event.stopPropagation()
          const captured = formatCapturedKey(event)
          if (!captured) return
          updateBehavior({
            ...behaviorFromCapturedKey(captured, behavior.id),
            enabled: behavior.enabled,
            ...(behavior.libraryItemId ? { libraryItemId: behavior.libraryItemId } : {}),
          })
          setCapturing(false)
        }}
        onUpdate={update => {
          const next = update(behavior)
          updateBehavior(next.type === 'delay' ? { ...next, ms: Math.round(next.ms) } : next)
        }}
        onClose={onClose}
        onSave={() => edit.onSave(behavior)}
      />
    </div>
  )
}
