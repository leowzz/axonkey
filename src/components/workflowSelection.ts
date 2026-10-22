import type { Designer, Step, WorkspaceApi } from 'sequential-workflow-designer'
import { isWorkflowStepLocked, workflowBranches } from './workflowBehaviorBridge.ts'
import { scrollWorkflowViewport } from './WorkflowViewport.ts'

// The designer owns the primary selection; keep additional Ctrl selections here.
export function bindWorkflowSelection(canvas: HTMLElement, designer: Designer, notifyChanged: () => void, getWorkspace?: () => WorkspaceApi | undefined) {
  const selected = new Set<string>()
  let pendingPrimary: string | null | undefined
  let pressedStepId: string | null = null
  let preserveGroupPress: string | null = null
  let groupDragStarted = false
  let dragSnapshot: { ids: string[]; primary: string; source: Step[]; index: number } | null = null
  let marquee: {
    workspace: HTMLElement; overlay: HTMLElement; original: string[]; base: string[]
    startX: number; startY: number; pointerX: number; pointerY: number; moved: boolean
    laneScroll: Map<string, number>
  } | null = null
  let frame = 0
  const branches = () => Object.values(workflowBranches(designer.getDefinition()))
  const find = (id: string) => {
    for (const branch of branches()) {
      const step = branch.find((step) => step.id === id)
      if (step) return isWorkflowStepLocked(step, branch) ? undefined : step
    }
  }
  const orderedSelectedIds = () => branches().flatMap((branch) => branch.map((step) => step.id)).filter((id) => selected.has(id))
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
    if (marquee) return
    // The designer clears its primary selection as a drag starts, then emits
    // that change asynchronously. It must not discard our drag group.
    if (groupDragStarted && (id === null || selected.has(id))) {
      pendingPrimary = undefined
      render()
      return
    }
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
  const updateMarquee = () => {
    if (!marquee) return
    const m = marquee
    const bounds = m.workspace.getBoundingClientRect()
    const originY = m.startY + (getWorkspace?.()?.getViewport().position.y ?? 0)
    const x = Math.max(0, Math.min(bounds.width, m.pointerX - bounds.left))
    const y = Math.max(0, Math.min(bounds.height, m.pointerY - bounds.top))
    const left = Math.max(0, Math.min(m.startX, x))
    const top = Math.max(0, Math.min(originY, y))
    const right = Math.min(bounds.width, Math.max(m.startX, x))
    const bottom = Math.min(bounds.height, Math.max(originY, y))
    Object.assign(m.overlay.style, { left: `${left}px`, top: `${top}px`, width: `${right - left}px`, height: `${bottom - top}px` })
    m.overlay.hidden = !m.moved
    selected.clear()
    for (const id of m.base) selected.add(id)
    if (m.moved) {
      const enabled = new Set(branches().flatMap((branch) => branch.filter((step) => !isWorkflowStepLocked(step, branch))).map((step) => step.id))
      for (const element of m.workspace.querySelectorAll<SVGElement>('[data-step-id]')) {
        const id = element.getAttribute('data-step-id')!
        if (!enabled.has(id) || !find(id)) continue
        const rect = element.getBoundingClientRect()
        const lane = element.closest?.('[data-trigger-scroll]')
        const laneBounds = lane?.querySelector('.workflow-trigger-viewport-bounds')?.getBoundingClientRect()
        const scrollDelta = lane ? Number(lane.getAttribute('data-scroll-top')) - (m.laneScroll.get(lane.getAttribute('data-trigger-scroll')!) ?? 0) : 0
        const selectionStart = laneBounds ? Math.max(bounds.top + originY, laneBounds.top) - scrollDelta : bounds.top + originY
        const selectionEnd = laneBounds ? Math.max(laneBounds.top, Math.min(laneBounds.bottom, bounds.top + y)) : bounds.top + y
        if (rect.right > bounds.left + Math.min(m.startX, x) && rect.left < bounds.left + Math.max(m.startX, x)
          && rect.bottom > Math.min(selectionStart, selectionEnd) && rect.top < Math.max(selectionStart, selectionEnd)) selected.add(id)
      }
    }
    render()
  }
  const autoScroll = () => {
    if (!marquee) return
    const workspace = getWorkspace?.()
    const rect = marquee.workspace.getBoundingClientRect()
    const lane = [...canvas.querySelectorAll<SVGSVGElement>('[data-trigger-scroll]')].find((element) => {
      const bounds = element.querySelector?.('.workflow-trigger-viewport-bounds')?.getBoundingClientRect()
      return bounds && marquee!.pointerX >= bounds.left && marquee!.pointerX <= bounds.right
    })
    if (lane && marquee.moved) {
      const bounds = lane.querySelector('.workflow-trigger-viewport-bounds')!.getBoundingClientRect()
      const delta = marquee.pointerY < bounds.top + 28 ? -10 : marquee.pointerY > bounds.bottom - 28 ? 10 : 0
      if (delta) {
        lane.dispatchEvent(new CustomEvent('workflow-lane-scroll', { detail: delta }))
        updateMarquee()
      }
      frame = requestAnimationFrame(autoScroll)
      return
    }
    if (workspace && marquee.moved && marquee.pointerX >= rect.left && marquee.pointerX <= rect.right) {
      const edge = 28
      const delta = marquee.pointerY < rect.top + edge ? -10 : marquee.pointerY > rect.bottom - edge ? 10 : 0
      if (delta && scrollWorkflowViewport(workspace, delta)) updateMarquee()
    }
    frame = requestAnimationFrame(autoScroll)
  }
  const endMarquee = (cancel = false) => {
    if (!marquee) return
    if (frame) cancelAnimationFrame(frame)
    frame = 0
    if (cancel) {
      selected.clear()
      for (const id of marquee.original) selected.add(id)
    }
    marquee.overlay.remove()
    marquee = null
    selectPrimary()
    render()
  }
  const onMouseMove = (event: MouseEvent) => {
    if (!marquee) return
    event.preventDefault()
    marquee.pointerX = event.clientX
    marquee.pointerY = event.clientY
    const rect = marquee.workspace.getBoundingClientRect()
    const startY = marquee.startY + (getWorkspace?.()?.getViewport().position.y ?? 0)
    if (Math.hypot(event.clientX - rect.left - marquee.startX, event.clientY - rect.top - startY) > 3) marquee.moved = true
    updateMarquee()
  }
  const onMouseDown = (event: MouseEvent) => {
    if (marquee) return
    pressedStepId = null
    preserveGroupPress = null
    groupDragStarted = false
    dragSnapshot = null
    if (event.button !== 0 || event.altKey || designer.isDragging()) return
    const target = event.target as Element | null
    const workspace = target?.closest<HTMLElement>('.sqd-workspace')
    if (!target || !workspace) return
    if (target.closest('button, input, textarea, select, [role="button"]:not([data-step-id]), [role="scrollbar"], [contenteditable="true"]')) return
    canvas.focus({ preventScroll: true })
    const id = target.closest('[data-step-id]')?.getAttribute('data-step-id')
    pressedStepId = id && find(id) ? id : null
    if (!id) {
      // Capture the blank press before the designer starts its pan behavior.
      event.preventDefault()
      event.stopPropagation()
      const rect = workspace.getBoundingClientRect()
      const overlay = canvas.ownerDocument.createElement('div')
      overlay.className = 'workflow-selection-marquee'
      overlay.setAttribute('aria-hidden', 'true')
      overlay.hidden = true
      workspace.appendChild(overlay)
      marquee = {
        workspace, overlay, original: [...selected], base: event.ctrlKey || event.metaKey ? [...selected] : [],
        laneScroll: new Map([...canvas.querySelectorAll('[data-trigger-scroll]')].map((lane) => [lane.getAttribute('data-trigger-scroll')!, Number(lane.getAttribute('data-scroll-top'))])),
        startX: event.clientX - rect.left,
        startY: event.clientY - rect.top - (getWorkspace?.()?.getViewport().position.y ?? 0),
        pointerX: event.clientX, pointerY: event.clientY, moved: false,
      }
      // Live highlights come entirely from our set until the box is committed.
      designer.clearSelectedStep()
      updateMarquee()
      if (getWorkspace && typeof requestAnimationFrame !== 'undefined') frame = requestAnimationFrame(autoScroll)
      return
    }
    if ((event.ctrlKey || event.metaKey) && id && find(id)) {
      // Ctrl-click toggles selection and must not start a single-node drag/editor.
      event.preventDefault()
      event.stopPropagation()
      if (selected.has(id)) selected.delete(id)
      else selected.add(id)
      selectPrimary()
      render()
    } else if (id && selected.has(id) && selected.size > 1) {
      // Keep a multi-selection intact while the pointer gesture is undecided.
      // A plain click is collapsed again on mouseup; a real drag keeps the
      // group, like common desktop editors do.
      pendingPrimary = id
      preserveGroupPress = id
      groupDragStarted = false
      designer.selectStepById(id)
      render()
    } else {
      pendingPrimary = undefined
      selected.clear()
      if (id && find(id)) selected.add(id)
      render()
    }
  }
  const onDraggingChanged = (isDragging: boolean) => {
    if (isDragging) {
      if (pressedStepId && selected.size > 1 && selected.has(pressedStepId)) {
        groupDragStarted = true
        const source = branches().find((branch) => branch.some((step) => step.id === pressedStepId))!
        dragSnapshot = { ids: orderedSelectedIds(), primary: pressedStepId, source, index: source.findIndex((step) => step.id === pressedStepId) }
      }
      return
    }
    // Completion is handled synchronously by the actual drag behavior wrapper.
    // Public definition events arrive too late to commit a group atomically.
  }
  const onMouseUp = (event: MouseEvent) => {
    if (marquee) {
      onMouseMove(event)
      endMarquee()
      return
    }
    const id = preserveGroupPress
    if (!id) return
    if (groupDragStarted) {
      preserveGroupPress = null
      return
    }
    // The designer's own mouseup handler has already selected the primary
    // step. Collapse only a click; a real drag keeps the complete group.
    setTimeout(() => {
      if (preserveGroupPress !== id || groupDragStarted) return
      selected.clear()
      selected.add(id)
      pendingPrimary = id
      render()
      preserveGroupPress = null
    }, 0)
  }
  const finishDrag = (interrupt: boolean) => {
    const snapshot = dragSnapshot
    dragSnapshot = null
    if (!snapshot || interrupt || designer.isReadonly()) return
    const definitionBranches = branches()
    const primaryBranch = definitionBranches.find((branch) => branch.some((step) => step.id === snapshot.primary))
    if (!primaryBranch) return
    const primaryIndex = primaryBranch.findIndex((step) => step.id === snapshot.primary)
    // An invalid/outside drop or an interrupted drag leaves every node intact.
    if (primaryBranch === snapshot.source && primaryIndex === snapshot.index) return
    const ids = new Set(snapshot.ids)
    const steps = snapshot.ids.map((id) => definitionBranches.flat().find((step) => step.id === id)).filter((step): step is Step => Boolean(step))
    const selectedBeforeTarget = primaryBranch.slice(0, primaryIndex).filter((step) => ids.has(step.id)).length
    for (const branch of definitionBranches) {
      for (let index = branch.length - 1; index >= 0; index--) {
        if (ids.has(branch[index].id)) branch.splice(index, 1)
      }
    }
    primaryBranch.splice(Math.max(0, primaryIndex - selectedBeforeTarget), 0, ...steps)
    render()
    notifyChanged()
  }
  const onKeyDown = (event: KeyboardEvent) => {
    if (marquee) {
      if (event.key === 'Escape') {
        event.preventDefault()
        endMarquee(true)
      }
      return
    }
    if (event.key !== 'Delete' || event.defaultPrevented || event.isComposing || event.ctrlKey || event.metaKey || event.altKey
      || designer.isReadonly() || designer.isDragging()) return
    const target = event.target as Element | null
    if (target?.closest('input, textarea, select, [contenteditable]:not([contenteditable="false"]), [role="dialog"]')) return
    const removable = new Set<Step>()
    for (const branch of branches()) {
      for (const step of branch) if (selected.has(step.id) && !isWorkflowStepLocked(step, branch)) removable.add(step)
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
  const mouseupTarget: Window | HTMLElement = typeof window === 'undefined' ? canvas : window
  const onBlur = () => endMarquee(true)
  const onRootUpdated = () => {
    const workspace = getWorkspace?.()
    if (workspace) scrollWorkflowViewport(workspace, 0)
    render()
  }
  mouseupTarget.addEventListener('mouseup', onMouseUp as EventListener, true)
  mouseupTarget.addEventListener('mousemove', onMouseMove as EventListener, true)
  mouseupTarget.addEventListener('blur', onBlur)
  designer.onSelectedStepIdChanged.subscribe(onSelected)
  designer.onIsDraggingChanged.subscribe(onDraggingChanged)
  designer.onRootComponentUpdated.subscribe(onRootUpdated)
  const unbind = () => {
    endMarquee(true)
    canvas.removeEventListener('mousedown', onMouseDown, true)
    canvas.removeEventListener('keydown', onKeyDown)
    mouseupTarget.removeEventListener('mouseup', onMouseUp as EventListener, true)
    mouseupTarget.removeEventListener('mousemove', onMouseMove as EventListener, true)
    mouseupTarget.removeEventListener('blur', onBlur)
    designer.onSelectedStepIdChanged.unsubscribe(onSelected)
    designer.onIsDraggingChanged.unsubscribe(onDraggingChanged)
    designer.onRootComponentUpdated.unsubscribe(onRootUpdated)
  }
  return Object.assign(unbind, {
    getSelectedIds: () => [...selected],
    getDragSteps: (stepId: string) => {
      const all = branches().flat()
      const ids = selected.has(stepId) ? orderedSelectedIds() : [stepId]
      return ids.map((id) => all.find((step) => step.id === id)).filter((step): step is Step => Boolean(step))
    },
    canDragSelection: () => branches().every((branch) => branch.every((step) => !selected.has(step.id)
      || (!isWorkflowStepLocked(step, branch) && (selected.size === 1 || step.type !== 'disabled')))),
    finishDrag,
  })
}
