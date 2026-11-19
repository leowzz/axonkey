import type { ReactNode } from 'react'
import { useEffect, useRef, useState } from 'react'
import { Trash2 } from 'lucide-react'
import { behaviorFromCapturedKey, behaviorTypeLabels, formatCapturedKey } from '../appConfig'
import type { Behavior, TriggerType } from '../behaviorModel'
import type { MappingInput, Platform } from '../appTypes'
import { BehaviorEditDialog, type QuickOverlayEditorContext } from './BehaviorEditor'
import { isWorkflowActionChoiceSelected, workflowActionChoiceGroup } from './workflowActionChoices'
import { useMappingDialogFocus } from './useMappingDialogFocus'

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
  quickOverlayContext,
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
  quickOverlayContext?: QuickOverlayEditorContext
}) {
  const [behavior, setBehavior] = useState(edit.behavior)
  const [capturing, setCapturing] = useState(false)
  const ref = useRef<HTMLDivElement>(null)
  const trapFocus = useMappingDialogFocus(
    ref,
    !inline,
    `.workflow-axonkey-canvas [data-step-id="${CSS.escape(edit.stepId)}"]`,
  )
  const choiceGroup = workflowActionChoiceGroup(edit.behavior)

  useEffect(() => setBehavior(edit.behavior), [edit.behavior])

  const updateBehavior = (next: Behavior) => {
    setBehavior(next)
    if (inline) edit.onSave(next)
  }

  return (
    <div
      ref={ref}
      className={`mapping-active workflow-step-editor${inline ? ' workflow-step-inline' : ''}`}
      onKeyDownCapture={event => {
        if (capturing && event.key === 'Escape') {
          event.preventDefault()
          event.stopPropagation()
          setCapturing(false)
          return
        }
        if (capturing) return
        if (event.key === 'Escape') {
          event.preventDefault()
          event.stopPropagation()
          onClose()
        }
        trapFocus(event)
      }}
    >
      <BehaviorEditDialog
        manageFocus={false}
        autoCapture={false}
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
        quickOverlayContext={quickOverlayContext}
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
