import { DefaultSequenceComponent, Dom, Vector } from 'sequential-workflow-designer'
import type { BranchedStep, Definition, Placeholder, RootComponentExtension, Step } from 'sequential-workflow-designer'
import type { TriggerType } from '../behaviorModel.ts'

const triggers = [
  { id: 'click', label: '单击' },
  { id: 'doubleClick', label: '双击' },
  { id: 'longPress', label: '长按' },
] as const

export function isTriggerRoot(step: Step) {
  return step.type === 'axonkeyTriggers'
}

export function isWorkflowLaneDisabled(branch: Step[]) {
  return branch.some((step) => step.type === 'disabled' && step.properties.enabled !== false)
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
export function createTriggerRootExtension(onToggle: (trigger: TriggerType, disabled: boolean) => void): RootComponentExtension {
  return {
    create(parent, sequence, _parentPlaceIndicator, context) {
      const root = sequence[0] as BranchedStep
      const g = Dom.svg('g', { class: 'workflow-trigger-root' })
      parent.appendChild(g)
      const lanes = triggers.map(({ id, label }) => {
        const disabled = isWorkflowLaneDisabled(root.branches[id])
        const lane = Dom.svg('g', { class: `workflow-trigger-lane workflow-trigger-${id}${disabled ? ' workflow-trigger-disabled' : ''}`, 'data-trigger': id })
        g.appendChild(lane)
        const component = DefaultSequenceComponent.create(lane, {
          sequence: root.branches[id],
          depth: 1,
          isInputConnected: true,
          isOutputConnected: true,
          isPreview: false,
        }, context)
        const width = Math.max(140, component.view.width + 32)
        return { id, lane, component, width, label, disabled, sequence: root.branches[id] }
      })
      const height = Math.max(300, ...lanes.map(({ component }) => component.view.height + 176))
      const appendPlaceholders: Placeholder[] = []
      let offset = 0
      for (const { id, lane, component, width, label, disabled, sequence: branch } of lanes) {
        Dom.translate(lane, offset, 0)
        const center = width / 2
        const background = Dom.svg('rect', { class: 'workflow-trigger-background', width, height, rx: 12 })
        lane.insertBefore(background, component.view.g)
        const title = Dom.svg('text', { class: 'workflow-trigger-title', x: center, y: 30 })
        title.textContent = label
        lane.appendChild(title)
        const control = Dom.svg('foreignObject', { x: center - 47, y: 40, width: 94, height: 32 })
        const toggle = document.createElement('button')
        toggle.type = 'button'
        toggle.className = 'workflow-trigger-toggle'
        toggle.setAttribute('role', 'switch')
        toggle.setAttribute('aria-label', `启用${label}流程`)
        toggle.setAttribute('aria-checked', String(!disabled))
        toggle.setAttribute('data-trigger-toggle', id)
        const caption = document.createElement('span')
        caption.textContent = '启用'
        const track = document.createElement('span')
        track.className = 'workflow-trigger-toggle-track'
        track.setAttribute('aria-hidden', 'true')
        toggle.append(caption, track)
        for (const type of ['pointerdown', 'mousedown', 'touchstart', 'dblclick']) toggle.addEventListener(type, (event) => event.stopPropagation())
        toggle.addEventListener('keydown', (event) => {
          if (event.key === 'Enter' || event.key === ' ') event.stopPropagation()
        })
        toggle.addEventListener('click', (event) => {
          event.stopPropagation()
          onToggle(id, !disabled)
        })
        control.appendChild(toggle)
        lane.appendChild(control)
        lane.appendChild(Dom.svg('path', {
          class: 'workflow-trigger-line',
          d: `M ${center} 100 V 120 M ${center} ${120 + component.view.height} V ${height - 30}`,
        }))
        lane.appendChild(Dom.svg('circle', { class: 'workflow-trigger-start', cx: center, cy: 100, r: 7 }))
        lane.appendChild(Dom.svg('circle', { class: 'workflow-trigger-end', cx: center, cy: height - 30, r: 5 }))
        Dom.translate(component.view.g, center - component.view.joinX, 120)
        const dropY = branch.length === 0 ? 112 : 120 + component.view.height
        const appendPlaceholder = context.services.placeholder.createForArea(
          lane, new Vector(width - 32, height - 30 - dropY), null, branch, branch.length,
        )
        Dom.translate(appendPlaceholder.view.g, 16, dropY)
        if (!disabled) appendPlaceholders.push(appendPlaceholder)
        offset += width + 16
      }
      const width = offset - 16
      return {
        view: { g, width, height, joinX: width / 2 },
        findById: (id) => lanes.map(({ component }) => component.findById(id)).find(Boolean) ?? null,
        resolveClick: (click) => lanes.map(({ component }) => component.resolveClick(click)).find(Boolean) ?? null,
        resolvePlaceholders: (skip, result) => {
          lanes.forEach(({ component, sequence: branch, disabled }) => {
            if (!disabled && branch.length > 0) component.resolvePlaceholders(skip, result)
          })
          result.placeholders.push(...appendPlaceholders)
        },
        updateBadges: (result) => lanes.forEach(({ component }) => component.updateBadges(result)),
      }
    },
  }
}
