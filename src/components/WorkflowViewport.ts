import { CenteredViewportCalculator, Vector } from 'sequential-workflow-designer'
import type { DesignerExtension } from 'sequential-workflow-designer'

export const fixedWorkflowViewport: DesignerExtension = {
  wheelController: { create: () => ({ onWheel() {} }) },
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
