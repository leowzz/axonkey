import { DefaultSequenceComponent, Dom, Vector } from 'sequential-workflow-designer'
import type { BranchedStep, Definition, Placeholder, RootComponentExtension, Step } from 'sequential-workflow-designer'
import type { TriggerType } from '../behaviorModel.ts'
import { clampLaneScroll, workflowLaneLayout } from './workflowLaneLayout.ts'

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
export function createTriggerRootExtension(
  onClear: (trigger: TriggerType) => void,
  onScroll: () => void = () => {},
): RootComponentExtension {
  const scrollPositions = new Map<TriggerType, number>()
  return {
    create(parent, sequence, _parentPlaceIndicator, context) {
      const root = sequence[0] as BranchedStep
      const g = Dom.svg('g', { class: 'workflow-trigger-root' })
      parent.appendChild(g)
      const canvas = parent.closest('.workflow-axonkey-canvas')!
      const width = canvas.clientWidth
      const height = canvas.clientHeight
      const { gap, padding, laneWidth, laneHeight, bodyHeight } = workflowLaneLayout(width, height)
      const lanes = triggers.map(({ id, label }) => {
        const disabled = isWorkflowLaneDisabled(root.branches[id])
        const lane = Dom.svg('g', { class: `workflow-trigger-lane workflow-trigger-${id}${disabled ? ' workflow-trigger-disabled' : ''}`, 'data-trigger': id })
        g.appendChild(lane)
        const viewport = Dom.svg('svg', {
          class: 'workflow-trigger-content', x: 0, y: 80, width: laneWidth, height: bodyHeight,
          id: `workflow-trigger-content-${id}`, 'data-trigger-scroll': id, 'aria-label': `${label}流程内容`,
        })
        lane.appendChild(viewport)
        // A nested SVG's bounding box includes its offscreen children. Keep an
        // explicit viewport rectangle for hit testing and clipping drop targets.
        viewport.appendChild(Dom.svg('rect', { class: 'workflow-trigger-viewport-bounds', width: laneWidth, height: bodyHeight, fill: 'transparent' }))
        const content = Dom.svg('g')
        viewport.appendChild(content)
        const component = DefaultSequenceComponent.create(content, {
          sequence: root.branches[id],
          depth: 1,
          isInputConnected: true,
          isOutputConnected: true,
          isPreview: false,
        }, context)
        return { id, lane, viewport, content, component, label, disabled, sequence: root.branches[id] }
      })
      const appendPlaceholders: Placeholder[] = []
      let offset = padding
      for (const { id, lane, viewport, content, component, label, disabled, sequence: branch } of lanes) {
        Dom.translate(lane, offset, padding)
        const center = laneWidth / 2
        const contentHeight = Math.max(bodyHeight, component.view.height + 56)
        const background = Dom.svg('rect', { class: 'workflow-trigger-background', width: laneWidth, height: laneHeight, rx: 12 })
        lane.insertBefore(background, viewport)
        const title = Dom.svg('text', { class: 'workflow-trigger-title', x: center, y: 30 })
        title.textContent = label
        lane.appendChild(title)
        // Keep the control in SVG coordinates: WebKit can misplace HTML inside
        // a foreignObject when the designer transforms the canvas.
        const clear = Dom.svg('g', {
          class: 'workflow-trigger-clear', role: 'button', tabindex: 0,
          'aria-label': `清空${label}流程`, 'aria-disabled': String(branch.length === 0),
          'data-trigger-clear': id,
        })
        Dom.translate(clear, center - 47, 40)
        clear.appendChild(Dom.svg('rect', { width: 94, height: 30, rx: 5 }))
        const caption = Dom.svg('text', { x: 47, y: 19 })
        caption.textContent = '清空'
        clear.appendChild(caption)
        const clearLane = () => { if (branch.length > 0) onClear(id) }
        for (const type of ['pointerdown', 'mousedown', 'touchstart', 'dblclick']) clear.addEventListener(type, (event) => event.stopPropagation())
        clear.addEventListener('keydown', (event) => {
          if (event.key !== 'Enter' && event.key !== ' ') return
          event.preventDefault()
          event.stopPropagation()
          if (event.key === 'Enter' && !event.repeat) clearLane()
        })
        clear.addEventListener('keyup', (event) => {
          if (event.key !== ' ') return
          event.preventDefault()
          event.stopPropagation()
          clearLane()
        })
        clear.addEventListener('click', (event) => {
          event.stopPropagation()
          clearLane()
        })
        lane.appendChild(clear)
        content.appendChild(Dom.svg('path', {
          class: 'workflow-trigger-line',
          d: `M ${center} 12 V 32 M ${center} ${32 + component.view.height} V ${contentHeight - 16}`,
        }))
        content.appendChild(Dom.svg('circle', { class: 'workflow-trigger-start', cx: center, cy: 12, r: 7 }))
        content.appendChild(Dom.svg('circle', { class: 'workflow-trigger-end', cx: center, cy: contentHeight - 16, r: 5 }))
        Dom.translate(component.view.g, center - component.view.joinX, 32)
        const dropY = branch.length === 0 ? 24 : 32 + component.view.height
        const appendPlaceholder = context.services.placeholder.createForArea(
          content, new Vector(laneWidth - 16, Math.max(8, contentHeight - 16 - dropY)), null, branch, branch.length,
        )
        Dom.translate(appendPlaceholder.view.g, 8, dropY)
        if (!disabled) appendPlaceholders.push(appendPlaceholder)
        const overflow = Math.max(0, contentHeight - bodyHeight)
        const thumbHeight = Math.max(24, bodyHeight * bodyHeight / contentHeight)
        const scrollbar = Dom.svg('rect', {
          class: 'workflow-trigger-scrollbar', x: laneWidth - 7, y: 80, width: 5, height: thumbHeight, rx: 2.5,
          role: 'scrollbar', tabindex: overflow ? 0 : -1, 'aria-label': `滚动${label}流程`,
          'aria-controls': `workflow-trigger-content-${id}`,
          'aria-orientation': 'vertical', 'aria-valuemin': 0, 'aria-valuemax': overflow,
          visibility: overflow ? 'visible' : 'hidden',
        })
        lane.appendChild(scrollbar)
        const scrollTo = (top: number) => {
          const next = clampLaneScroll(top, contentHeight, bodyHeight)
          scrollPositions.set(id, next)
          Dom.translate(content, 0, -next)
          viewport.setAttribute('data-scroll-top', String(next))
          scrollbar.setAttribute('y', String(80 + (overflow ? next / overflow * (bodyHeight - thumbHeight) : 0)))
          scrollbar.setAttribute('aria-valuenow', String(next))
          onScroll()
        }
        lane.addEventListener('wheel', (event) => {
          event.preventDefault()
          event.stopPropagation()
          const unit = event.deltaMode === 1 ? 24 : event.deltaMode === 2 ? bodyHeight : 1
          scrollTo((scrollPositions.get(id) ?? 0) + event.deltaY * unit)
        }, { passive: false })
        viewport.addEventListener('workflow-lane-scroll', (event) => scrollTo((scrollPositions.get(id) ?? 0) + (event as CustomEvent<number>).detail))
        let drag: { y: number; top: number } | null = null
        scrollbar.addEventListener('pointerdown', (event) => {
          event.preventDefault()
          event.stopPropagation()
          scrollbar.focus()
          scrollbar.setPointerCapture(event.pointerId)
          drag = { y: event.clientY, top: scrollPositions.get(id) ?? 0 }
        })
        scrollbar.addEventListener('mousedown', (event) => event.stopPropagation())
        scrollbar.addEventListener('pointermove', (event) => {
          if (drag) scrollTo(drag.top + (event.clientY - drag.y) * overflow / (bodyHeight - thumbHeight))
        })
        scrollbar.addEventListener('lostpointercapture', () => { drag = null })
        scrollbar.addEventListener('pointerup', (event) => scrollbar.releasePointerCapture(event.pointerId))
        scrollbar.addEventListener('keydown', (event) => {
          const top = scrollPositions.get(id) ?? 0
          const next = { ArrowDown: top + 40, ArrowUp: top - 40, PageDown: top + bodyHeight, PageUp: top - bodyHeight, Home: 0, End: overflow }[event.key]
          if (next === undefined) return
          event.preventDefault()
          event.stopPropagation()
          scrollTo(next)
        })
        scrollTo(scrollPositions.get(id) ?? 0)
        offset += laneWidth + gap
      }
      return {
        view: { g, width, height, joinX: width / 2 },
        findById: (id) => lanes.map(({ component }) => component.findById(id)).find(Boolean) ?? null,
        resolveClick: (click) => lanes.map(({ component }) => component.resolveClick(click)).find(Boolean) ?? null,
        resolvePlaceholders: (skip, result) => {
          lanes.forEach(({ component, sequence: branch, disabled }) => {
            if (!disabled && branch.length > 0) component.resolvePlaceholders(skip, result)
          })
          result.placeholders.push(...appendPlaceholders)
          // Clipped blocks must not remain drop targets outside their lane.
          result.placeholders = result.placeholders.map((placeholder) => {
            const viewport = placeholder.view.g.closest('.workflow-trigger-content')!
            const clipped = Object.create(placeholder) as Placeholder
            clipped.getClientRect = () => {
              const rect = placeholder.getClientRect()
              const bounds = viewport.querySelector('.workflow-trigger-viewport-bounds')!.getBoundingClientRect()
              const x = Math.max(rect.x, bounds.left)
              const y = Math.max(rect.y, bounds.top)
              return new DOMRect(x, y, Math.max(0, Math.min(rect.x + rect.width, bounds.right) - x), Math.max(0, Math.min(rect.y + rect.height, bounds.bottom) - y))
            }
            return clipped
          })
        },
        updateBadges: (result) => lanes.forEach(({ component }) => component.updateBadges(result)),
      }
    },
  }
}
