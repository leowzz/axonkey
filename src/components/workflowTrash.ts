import type { Designer } from 'sequential-workflow-designer'

type DraggingDesigner = Pick<Designer, 'isDragging'> & {
  onIsDraggingChanged: {
    subscribe(listener: (isDragging: boolean) => void): void
    unsubscribe(listener: (isDragging: boolean) => void): void
  }
}

function isInside(element: HTMLElement, clientX: number, clientY: number) {
  const rect = element.getBoundingClientRect()
  return clientX >= rect.left && clientX <= rect.right && clientY >= rect.top && clientY <= rect.bottom
}

/** Show a drop target in the active lane only while dragging existing steps. */
export function bindWorkflowTrash(
  canvas: HTMLElement,
  trash: HTMLElement,
  designer: DraggingDesigner,
  onDelete: (stepId: string) => void,
) {
  let pressedStepId: string | null = null
  let draggedStepId: string | null = null
  let pressedTrigger: string | null = null
  let visible = false
  let pendingDelete = false

  const setHover = (hover: boolean) => {
    trash.classList.toggle('is-drag-over', hover)
    trash.setAttribute('aria-label', hover ? '松开以删除行为' : '垃圾桶，拖入行为即可删除')
  }

  const positionTarget = (lane: Element | undefined) => {
    visible = Boolean(lane)
    trash.classList.toggle('is-visible', visible)
    trash.setAttribute('aria-hidden', String(!visible))
    if (!lane) return
    const bounds = lane.querySelector('.workflow-trigger-background')!.getBoundingClientRect()
    const canvasBounds = canvas.getBoundingClientRect()
    const parentBounds = trash.parentElement!.getBoundingClientRect()
    trash.style.left = `${Math.min(bounds.right, canvasBounds.right) - parentBounds.left - 76 - 8}px`
    trash.style.top = `${Math.min(bounds.bottom, canvasBounds.bottom) - parentBounds.top - 54 - 8}px`
  }

  const laneAt = (x: number, y: number) =>
    [...canvas.querySelectorAll('.workflow-trigger-lane')].find(lane =>
      isInside(lane.querySelector<HTMLElement>('.workflow-trigger-background')!, x, y),
    )

  const onMouseDown = (event: MouseEvent) => {
    if (event.button !== 0) return
    const target = event.target as Element | null
    pressedStepId = target?.closest('[data-step-id]')?.getAttribute('data-step-id') ?? null
    pressedTrigger = target?.closest('[data-trigger]')?.getAttribute('data-trigger') ?? null
  }

  const onDraggingChanged = (isDragging: boolean) => {
    if (isDragging) {
      draggedStepId = pressedStepId
      pendingDelete = false
      positionTarget(
        draggedStepId
          ? [...canvas.querySelectorAll('.workflow-trigger-lane')].find(
              lane => lane.getAttribute('data-trigger') === pressedTrigger,
            )
          : undefined,
      )
      return
    }
    positionTarget(undefined)
    if (!pendingDelete) {
      pressedStepId = null
      draggedStepId = null
      setHover(false)
    }
  }

  const onMouseMove = (event: MouseEvent) => {
    if (!draggedStepId || !designer.isDragging()) return
    positionTarget(laneAt(event.clientX, event.clientY))
    setHover(visible && isInside(trash, event.clientX, event.clientY))
  }

  const onMouseUp = (event: MouseEvent) => {
    if (!draggedStepId || !designer.isDragging()) return
    const stepId = draggedStepId
    positionTarget(laneAt(event.clientX, event.clientY))
    const droppedOnTrash = visible && isInside(trash, event.clientX, event.clientY)
    pendingDelete = droppedOnTrash
    setHover(false)
    positionTarget(undefined)
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
    positionTarget(undefined)
  }
}
