import { Dom } from 'sequential-workflow-designer'
import type { DraggedComponentExtension, Step } from 'sequential-workflow-designer'

// Render all group members in the moving preview, while retaining the primary
// step's hitbox so the designer still resolves the exact intended insertion.
export function createWorkflowDraggedSteps(getSteps: (step: Step) => Step[]): DraggedComponentExtension {
  return {
    create(parent, step, isAttached, context) {
      const steps = isAttached ? getSteps(step) : [step]
      const scale = isAttached ? context.getViewportScale() : 1
      const svg = Dom.svg('svg')
      parent.appendChild(svg)
      const components = (steps.length ? steps : [step]).map((node) => context.stepComponentFactory.create(svg, {
        step: node, parentSequence: [], depth: 0, position: 0,
        isInputConnected: true, isOutputConnected: true, isPreview: true,
      }, context))
      let height = 10
      let primaryY = 10
      const width = Math.max(...components.map((component) => component.view.width))
      for (let index = 0; index < components.length; index++) {
        const view = components[index].view
        if ((steps[index] ?? step).id === step.id) primaryY = height
        Dom.translate(view.g, 10 + (width - view.width) / 2, height)
        height += view.height + 8
      }
      const primary = components.find((_component, index) => (steps[index] ?? step).id === step.id)!.view
      Dom.attrs(svg, {
        width: width + 20, height: height + 2,
        style: `transform: scale(${scale}) translate(${-10 - (width - primary.width) / 2}px, ${-primaryY}px); transform-origin: 0 0; overflow: visible;`,
      })
      return { width: primary.width, height: primary.height, scale, destroy() { svg.remove() } }
    },
  }
}
