import { Dom } from 'sequential-workflow-designer'
import type { DraggedComponentExtension, Step } from 'sequential-workflow-designer'

// Render all group members in the moving preview while returning a subpixel
// cursor hitbox so 2D wrapped lane slots resolve the exact pointer target.
export function createWorkflowDraggedSteps(getSteps: (step: Step) => Step[]): DraggedComponentExtension {
  return {
    create(parent, step, isAttached, context) {
      const rawSteps = isAttached ? getSteps(step) : [step]
      const steps = rawSteps.length ? rawSteps : [step]
      const scale = isAttached ? context.getViewportScale() : 1
      const svg = Dom.svg('svg', { class: 'workflow-drag-preview' })
      parent.appendChild(svg)
      const components = steps.map(node =>
        context.stepComponentFactory.create(
          svg,
          {
            step: node,
            parentSequence: [],
            depth: 0,
            position: 0,
            isInputConnected: false,
            isOutputConnected: false,
            isPreview: true,
          },
          context,
        ),
      )
      let height = 6
      let primaryIndex = 0
      let primaryY = 6
      const width = Math.max(...components.map(component => component.view.width))
      for (let index = 0; index < components.length; index++) {
        const view = components[index].view
        if (steps[index].id === step.id) {
          primaryIndex = index
          primaryY = height
        }
        Dom.translate(view.g, 8 + (width - view.width) / 2, height)
        height += view.height + 4
      }
      const primary = components[primaryIndex].view
      const primaryCenterX = 8 + width / 2
      const primaryCenterY = primaryY + primary.height / 2
      Dom.attrs(svg, {
        width: width + 16,
        height: height + 2,
        style: `transform: scale(${scale}) translate(${0.25 - primaryCenterX}px, ${0.25 - primaryCenterY}px); transform-origin: 0 0; overflow: visible;`,
      })
      return {
        width: 0.5,
        height: 0.5,
        scale,
        destroy() {
          svg.remove()
        },
      }
    },
  }
}
