import type { Designer } from 'sequential-workflow-designer'

type DraggingDesigner = Pick<Designer, 'isDragging'> & {
  onIsDraggingChanged: { subscribe(listener: (isDragging: boolean) => void): void; unsubscribe(listener: (isDragging: boolean) => void): void }
}

function isInside(element: HTMLElement, clientX: number, clientY: number) {
  const rect = element.getBoundingClientRect()
  return clientX >= rect.left && clientX <= rect.right && clientY >= rect.top && clientY <= rect.bottom
}

/** Track designer step drags and expose a fixed mouse drop target for deletion. */
export function bindWorkflowTrash(
  canvas: HTMLElement,
  trash: HTMLElement,
  designer: DraggingDesigner,
  onDelete: (stepId: string) => void,
) {
  let pressedStepId: string | null = null
  let draggedStepId: string | null = null
  let pendingDelete = false

  const setHover = (hover: boolean) => {
    trash.classList.toggle('is-drag-over', hover)
    trash.setAttribute('aria-label', hover ? '松开以删除行为' : '垃圾桶，拖入行为即可删除')
  }

  const onMouseDown = (event: MouseEvent) => {
    if (event.button !== 0) return
    const target = event.target as Element | null
    pressedStepId = target?.closest('[data-step-id]')?.getAttribute('data-step-id') ?? null
  }

  const onDraggingChanged = (isDragging: boolean) => {
    if (isDragging) {
      draggedStepId = pressedStepId
      pendingDelete = false
      return
    }
    if (!pendingDelete) {
      pressedStepId = null
      draggedStepId = null
      setHover(false)
    }
  }

  const onMouseMove = (event: MouseEvent) => {
    if (!draggedStepId || !designer.isDragging()) return
    setHover(isInside(trash, event.clientX, event.clientY))
  }

  const onMouseUp = (event: MouseEvent) => {
    if (!draggedStepId || !designer.isDragging()) return
    const stepId = draggedStepId
    const droppedOnTrash = isInside(trash, event.clientX, event.clientY)
    pendingDelete = droppedOnTrash
    setHover(false)
    if (droppedOnTrash) {
      // Let the designer finish its drag transaction before mutating its definition.
      setTimeout(() => {
        pendingDelete = false
        pressedStepId = null
        draggedStepId = null
        onDelete(stepId)
      }, 0)
    } else {
      pressedStepId = null
      draggedStepId = null
    }
  }

  canvas.addEventListener('mousedown', onMouseDown, true)
  window.addEventListener('mousemove', onMouseMove, true)
  window.addEventListener('mouseup', onMouseUp, true)
  designer.onIsDraggingChanged.subscribe(onDraggingChanged)
  return () => {
    canvas.removeEventListener('mousedown', onMouseDown, true)
    window.removeEventListener('mousemove', onMouseMove, true)
    window.removeEventListener('mouseup', onMouseUp, true)
    designer.onIsDraggingChanged.unsubscribe(onDraggingChanged)
    setHover(false)
  }
}
