import { DefaultSequenceComponent, Dom, Vector } from 'sequential-workflow-designer'
import type { BranchedStep, Definition, Placeholder, RootComponentExtension, Step } from 'sequential-workflow-designer'

const triggers = [
  { id: 'click', label: '单击' },
  { id: 'doubleClick', label: '双击' },
  { id: 'longPress', label: '长按' },
] as const

export function isTriggerRoot(step: Step) {
  return step.type === 'axonkeyTriggers'
}

export function createTriggerDefinition(): Definition {
  const root: BranchedStep = {
    id: 'axonkey-triggers',
    componentType: 'switch',
    type: 'axonkeyTriggers',
    name: '触发方式',
    properties: {},
    branches: { click: [], doubleClick: [], longPress: [] },
  }
  return { properties: {}, sequence: [root] }
}

// Render the three branch sequences as independent lines in one designer.
export const triggerRootExtension: RootComponentExtension = {
  create(parent, sequence, _parentPlaceIndicator, context) {
    const root = sequence[0] as BranchedStep
    const g = Dom.svg('g', { class: 'workflow-trigger-root' })
    parent.appendChild(g)
    const lanes = triggers.map(({ id, label }) => {
      const lane = Dom.svg('g', { class: `workflow-trigger-lane workflow-trigger-${id}`, 'data-trigger': id })
      g.appendChild(lane)
      const component = DefaultSequenceComponent.create(lane, {
        sequence: root.branches[id],
        depth: 1,
        isInputConnected: true,
        isOutputConnected: true,
        isPreview: false,
      }, context)
      const width = Math.max(140, component.view.width + 32)
      return { lane, component, width, label, sequence: root.branches[id] }
    })
    const height = Math.max(260, ...lanes.map(({ component }) => component.view.height + 136))
    const appendPlaceholders: Placeholder[] = []
    let offset = 0
    for (const { lane, component, width, label, sequence: branch } of lanes) {
      Dom.translate(lane, offset, 0)
      const center = width / 2
      const background = Dom.svg('rect', { class: 'workflow-trigger-background', width, height, rx: 12 })
      lane.insertBefore(background, component.view.g)
      const title = Dom.svg('text', { class: 'workflow-trigger-title', x: center, y: 30 })
      title.textContent = label
      lane.appendChild(title)
      lane.appendChild(Dom.svg('path', {
        class: 'workflow-trigger-line',
        d: `M ${center} 60 V 80 M ${center} ${80 + component.view.height} V ${height - 30}`,
      }))
      lane.appendChild(Dom.svg('circle', { class: 'workflow-trigger-start', cx: center, cy: 60, r: 7 }))
      lane.appendChild(Dom.svg('circle', { class: 'workflow-trigger-end', cx: center, cy: height - 30, r: 5 }))
      Dom.translate(component.view.g, center - component.view.joinX, 80)
      const dropY = branch.length === 0 ? 72 : 80 + component.view.height
      const appendPlaceholder = context.services.placeholder.createForArea(
        lane, new Vector(width - 32, height - 30 - dropY), null, branch, branch.length,
      )
      Dom.translate(appendPlaceholder.view.g, 16, dropY)
      appendPlaceholders.push(appendPlaceholder)
      offset += width + 16
    }
    const width = offset - 16
    return {
      view: { g, width, height, joinX: width / 2 },
      findById: (id) => lanes.map(({ component }) => component.findById(id)).find(Boolean) ?? null,
      resolveClick: (click) => lanes.map(({ component }) => component.resolveClick(click)).find(Boolean) ?? null,
      resolvePlaceholders: (skip, result) => {
        lanes.forEach(({ component, sequence: branch }) => {
          if (branch.length > 0) component.resolvePlaceholders(skip, result)
        })
        result.placeholders.push(...appendPlaceholders)
      },
      updateBadges: (result) => lanes.forEach(({ component }) => component.updateBadges(result)),
    }
  },
}
