import type { Designer, Step } from 'sequential-workflow-designer'
import { isWorkflowLaneDisabled, workflowBranches } from './workflowBehaviorBridge.ts'

// The designer owns the primary selection; keep additional Ctrl selections here.
export function bindWorkflowSelection(canvas: HTMLElement, designer: Designer, notifyChanged: () => void) {
  const selected = new Set<string>()
  let pendingPrimary: string | null | undefined
  const branches = () => Object.values(workflowBranches(designer.getDefinition()))
  const find = (id: string) => branches().flat().find((step) => step.id === id && step.type !== 'disabled')
  const render = () => {
    for (const id of selected) if (!find(id)) selected.delete(id)
    for (const element of canvas.querySelectorAll<SVGElement>('[data-step-id]')) {
      element.classList.toggle('workflow-step-selected', selected.has(element.getAttribute('data-step-id')!))
    }
  }
  const selectPrimary = () => {
    const ids = [...selected]
    const id = ids[ids.length - 1] ?? null
    // Public designer selection events are batched, so a synchronous guard
    // would discard the extra selection when the delayed event arrives.
    pendingPrimary = id
    if (id) designer.selectStepById(id)
    else designer.clearSelectedStep()
  }
  const onSelected = (id: string | null) => {
    if (id === pendingPrimary) {
      pendingPrimary = undefined
      render()
      return
    }
    pendingPrimary = undefined
    selected.clear()
    if (id && find(id)) selected.add(id)
    render()
  }
  const onMouseDown = (event: MouseEvent) => {
    if (event.button !== 0 || event.altKey || designer.isDragging()) return
    const target = event.target as Element | null
    if (!target?.closest('.sqd-workspace')) return
    if (target.closest('button, input, textarea, select, [contenteditable="true"]')) return
    canvas.focus({ preventScroll: true })
    const id = target.closest('[data-step-id]')?.getAttribute('data-step-id')
    if ((event.ctrlKey || event.metaKey) && id && find(id)) {
      // Ctrl-click toggles selection and must not start a single-node drag/editor.
      event.preventDefault()
      event.stopPropagation()
      if (selected.has(id)) selected.delete(id)
      else selected.add(id)
      selectPrimary()
      render()
    } else {
      pendingPrimary = undefined
      selected.clear()
      if (id && find(id)) selected.add(id)
      render()
    }
  }
  const onKeyDown = (event: KeyboardEvent) => {
    if (event.key !== 'Delete' || event.defaultPrevented || event.isComposing || event.ctrlKey || event.metaKey || event.altKey
      || designer.isReadonly() || designer.isDragging()) return
    const target = event.target as Element | null
    if (target?.closest('input, textarea, select, [contenteditable]:not([contenteditable="false"]), [role="dialog"]')) return
    const removable = new Set<Step>()
    for (const branch of branches()) {
      if (isWorkflowLaneDisabled(branch)) continue
      for (const step of branch) if (selected.has(step.id) && step.type !== 'disabled') removable.add(step)
    }
    if (removable.size === 0) return
    event.preventDefault()
    event.stopPropagation()
    for (const branch of branches()) {
      for (let index = branch.length - 1; index >= 0; index--) {
        if (removable.has(branch[index])) branch.splice(index, 1)
      }
    }
    selected.clear()
    selectPrimary()
    render()
    // One notification keeps batch deletion a single autosave/undo operation.
    notifyChanged()
  }
  canvas.addEventListener('mousedown', onMouseDown, true)
  canvas.addEventListener('keydown', onKeyDown)
  designer.onSelectedStepIdChanged.subscribe(onSelected)
  designer.onRootComponentUpdated.subscribe(render)
  return () => {
    canvas.removeEventListener('mousedown', onMouseDown, true)
    canvas.removeEventListener('keydown', onKeyDown)
    designer.onSelectedStepIdChanged.unsubscribe(onSelected)
    designer.onRootComponentUpdated.unsubscribe(render)
  }
}
