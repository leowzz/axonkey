import { useEffect, useRef, useState } from 'react'
import { behaviorFromCapturedKey, behaviorTypeLabels, formatCapturedKey } from '../appConfig'
import type { Behavior, TriggerType } from '../behaviorModel'
import type { MappingInput, Platform } from '../appTypes'
import { BehaviorEditDialog } from './BehaviorEditor'

export type WorkflowStepEdit = {
  stepId: string
  trigger: TriggerType
  behavior: Behavior
  onSave: (behavior: Behavior) => void
}

export function WorkflowStepDialog({ edit, platform, button, onClose }: {
  edit: WorkflowStepEdit
  platform: Platform
  button: MappingInput
  onClose: () => void
}) {
  const [behavior, setBehavior] = useState(edit.behavior)
  const [capturing, setCapturing] = useState(edit.behavior.type === 'shortcut' && edit.behavior.keys.length === 0)
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
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
      const node = document.querySelector<SVGElement>(`.workflow-axonkey-canvas [data-step-id="${CSS.escape(edit.stepId)}"]`)
      if (node) node.focus()
      else if ((previousFocus instanceof HTMLElement || previousFocus instanceof SVGElement) && previousFocus.isConnected) previousFocus.focus()
    }
  }, [edit.stepId])

  return <div ref={ref} className="mapping-active workflow-step-editor" onKeyDownCapture={(event) => {
    if (capturing) return
    if (event.key === 'Escape') {
      event.preventDefault()
      event.stopPropagation()
      onClose()
    }
    if (event.key !== 'Tab') return
    const elements = Array.from(ref.current?.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled), textarea, select:not(:disabled), [tabindex="0"]') ?? [])
    const first = elements[0]
    const last = elements[elements.length - 1]
    if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus() }
    else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus() }
  }}>
    <BehaviorEditDialog
      platform={platform}
      button={button}
      trigger={edit.trigger}
      behavior={behavior}
      draft
      delayStep={1}
      title={`编辑${behaviorTypeLabels[behavior.type]}行为`}
      saveHint="保存到当前流程节点"
      capturing={capturing}
      onStartCapture={() => setCapturing(true)}
      onCancelCapture={() => setCapturing(false)}
      onCaptureKey={(_current, event) => {
        event.preventDefault()
        event.stopPropagation()
        const captured = formatCapturedKey(event)
        if (!captured) return
        setBehavior(behaviorFromCapturedKey(captured, behavior.id))
        setCapturing(false)
      }}
      onUpdate={(update) => setBehavior((current) => {
        const next = update(current)
        return next.type === 'delay' ? { ...next, ms: Math.round(next.ms) } : next
      })}
      onClose={onClose}
      onSave={() => edit.onSave(behavior)}
    />
  </div>
}
