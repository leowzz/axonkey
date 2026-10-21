import { CenteredViewportCalculator, Vector } from 'sequential-workflow-designer'
import type { DesignerExtension, WorkspaceApi } from 'sequential-workflow-designer'

type WorkflowViewportApi = Pick<WorkspaceApi, 'getCanvasSize' | 'getRootComponentSize' | 'getViewport' | 'setViewport'>

export function scrollWorkflowViewport(api: WorkflowViewportApi, deltaY: number) {
  const height = api.getCanvasSize().y
  const rootHeight = api.getRootComponentSize().y
  const overflow = Math.max(0, rootHeight - height)
  const current = api.getViewport()
  const y = overflow > 0
    ? Math.max(-overflow, Math.min(0, current.position.y - deltaY))
    : Math.max(0, (height - rootHeight) / 2)
  if (y === current.position.y) return false
  api.setViewport({ position: new Vector(current.position.x, y), scale: 1 })
  return true
}

export const fixedWorkflowViewport: DesignerExtension = {
  wheelController: {
    create: (_viewport, workspace) => ({
      onWheel(event) {
        // Normalize mouse wheels (lines/pages) and touchpads (pixels).
        const unit = event.deltaMode === 1 ? 24 : event.deltaMode === 2 ? workspace.getCanvasSize().y : 1
        scrollWorkflowViewport(workspace, event.deltaY * unit)
      },
    }),
  },
  viewportController: {
    create: (api) => ({
      smoothDeltaYLimit: 16,
      getDefault() {
        const offset = api.getCanvasSize().subtract(api.getRootComponentSize()).divideByScalar(2)
        return { position: new Vector(Math.max(0, offset.x), Math.max(0, offset.y)), scale: 1 }
      },
      getZoomed: () => null,
      getNextScale: () => ({ current: 1, next: 1 }),
      limitScale: () => 1,
      getFocusedOnComponent: (position, size) => CenteredViewportCalculator.getFocusedOnComponent(api.getCanvasSize(), api.getViewport(), position, size),
    }),
  },
}
