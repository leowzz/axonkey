import { DefaultSequenceComponent, Dom, Vector } from 'sequential-workflow-designer'
import type { BranchedStep, Definition, Placeholder, RootComponentExtension, Step } from 'sequential-workflow-designer'
import type { TriggerType } from '../behaviorModel.ts'
import { clampLaneScroll, workflowLaneLayout } from './workflowLaneLayout.ts'

export const defaultWorkflowTriggers = [
  { id: 'click', label: '单击' },
  { id: 'doubleClick', label: '双击' },
  { id: 'longPress', label: '长按' },
] as const

export function isTriggerRoot(step: Step) {
  return step.type === 'axonkeyTriggers'
}

export function isWorkflowLaneDisabled(branch: Step[]) {
  return branch.some(step => step.type === 'disabled' && step.properties.enabled !== false)
}

// Suppressed actions stay protected, but the disabling node can be removed.
export function isWorkflowStepLocked(step: Step, branch: Step[]) {
  return step.type !== 'disabled' && isWorkflowLaneDisabled(branch)
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

type WorkflowLaneAction = 'save' | 'copy' | 'paste'
type WorkflowTriggers = readonly { id: TriggerType; label: string }[]

// Render the input's supported triggers as independent lanes in one designer.
export function createTriggerRootExtension(
  onClear: (trigger: TriggerType) => void,
  onScroll: () => void = () => {},
  onAction: (trigger: TriggerType, action: WorkflowLaneAction) => void = () => {},
  triggers: WorkflowTriggers | (() => WorkflowTriggers) = defaultWorkflowTriggers,
): RootComponentExtension {
  const scrollPositions = new Map<TriggerType, number>()
  return {
    create(parent, sequence, _parentPlaceIndicator, context) {
      const visibleTriggers = typeof triggers === 'function' ? triggers() : triggers
      const root = sequence[0] as BranchedStep
      const g = Dom.svg('g', { class: 'workflow-trigger-root' })
      parent.appendChild(g)
      // The designer can rebuild the root while its SVG is temporarily
      // detached from the React canvas (for example during a fast remount).
      // Keep rendering with the SVG's current size instead of dereferencing a
      // canvas that is not in the ancestor chain yet.
      const canvas = parent.closest<HTMLElement>('.workflow-axonkey-canvas')
      const svg = parent.ownerSVGElement
      const svgBounds = svg?.getBoundingClientRect()
      const width = canvas?.clientWidth ?? svg?.clientWidth ?? svgBounds?.width ?? 800
      const height = canvas?.clientHeight ?? svg?.clientHeight ?? svgBounds?.height ?? 400
      const { gap, padding, laneWidth, laneHeight, bodyHeight, headerHeight } = workflowLaneLayout(
        width,
        height,
        visibleTriggers.length,
      )
      const lanes = visibleTriggers.map(({ id, label }) => {
        const disabled = isWorkflowLaneDisabled(root.branches[id])
        const lane = Dom.svg('g', {
          class: `workflow-trigger-lane workflow-trigger-${id}${disabled ? ' workflow-trigger-disabled' : ''}`,
          'data-trigger': id,
        })
        g.appendChild(lane)
        const viewport = Dom.svg('svg', {
          class: 'workflow-trigger-content',
          x: 0,
          y: headerHeight,
          width: laneWidth,
          height: bodyHeight,
          id: `workflow-trigger-content-${id}`,
          'data-trigger-scroll': id,
          'aria-label': `${label}流程内容`,
        })
        lane.appendChild(viewport)
        // A nested SVG's bounding box includes its offscreen children. Keep an
        // explicit viewport rectangle for hit testing and clipping drop targets.
        viewport.appendChild(
          Dom.svg('rect', {
            class: 'workflow-trigger-viewport-bounds',
            width: laneWidth,
            height: bodyHeight,
            fill: 'transparent',
          }),
        )
        const content = Dom.svg('g')
        viewport.appendChild(content)
        const component = DefaultSequenceComponent.create(
          content,
          {
            sequence: root.branches[id],
            depth: 1,
            isInputConnected: true,
            isOutputConnected: true,
            isPreview: false,
          },
          context,
        )
        return { id, lane, viewport, content, component, label, disabled, sequence: root.branches[id] }
      })
      const appendPlaceholders: Placeholder[] = []
      let offset = padding
      for (const { id, lane, viewport, content, component, label, disabled, sequence: branch } of lanes) {
        Dom.translate(lane, offset, padding)
        const center = laneWidth / 2
        const contentHeight = Math.max(bodyHeight, component.view.height + 56)
        const background = Dom.svg('rect', {
          class: 'workflow-trigger-background',
          width: laneWidth,
          height: laneHeight,
          rx: 12,
        })
        lane.insertBefore(background, viewport)
        const title = Dom.svg('text', { class: 'workflow-trigger-title', x: center, y: 30 })
        title.textContent = label
        lane.appendChild(title)
        // Keep the control in SVG coordinates: WebKit can misplace HTML inside
        // a foreignObject when the designer transforms the canvas.
        const actions = [
          { id: 'save', label: '另存', icon: 'm19 21-7-4-7 4V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2v16z M12 7v6 M9 10h6' },
          {
            id: 'copy',
            label: '复制',
            icon: 'M10 8h10a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H10a2 2 0 0 1-2-2V10a2 2 0 0 1 2-2z M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2',
          },
          {
            id: 'paste',
            label: '粘贴',
            icon: 'M15 2H9a1 1 0 0 0-1 1v2c0 .6.4 1 1 1h6c.6 0 1-.4 1-1V3c0-.6-.4-1-1-1Z M8 4H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2 M16 4h2a2 2 0 0 1 2 2v2 M11 14h10 M17 10l4 4-4 4',
          },
          {
            id: 'clear',
            label: '清空',
            icon: 'm7 21-4.3-4.3c-1-1-1-2.5 0-3.4l9.6-9.6c1-1 2.5-1 3.4 0l5.6 5.6c1 1 1 2.5 0 3.4L13 21 M22 21H7 M5 11l9 9',
          },
        ] as const
        const columns = headerHeight > 80 ? 2 : 4
        const actionGap = 6
        const actionWidth = Math.min(32, (laneWidth - 24 - (columns - 1) * actionGap) / columns)
        const actionsLeft = center - (columns * actionWidth + (columns - 1) * actionGap) / 2
        actions.forEach((action, index) => {
          const unavailable = action.id !== 'paste' && branch.length === 0
          const control = Dom.svg('g', {
            class: 'workflow-trigger-action',
            role: 'button',
            tabindex: 0,
            'aria-label': `${action.label}${label}流程`,
            'aria-disabled': String(unavailable),
            [`data-trigger-${action.id}`]: id,
          })
          Dom.translate(
            control,
            actionsLeft + (index % columns) * (actionWidth + actionGap),
            40 + Math.floor(index / columns) * 34,
          )
          control.appendChild(Dom.svg('rect', { width: actionWidth, height: 28, rx: 5 }))
          control.appendChild(
            Dom.svg('path', {
              class: 'workflow-trigger-action-icon',
              d: action.icon,
              transform: `translate(${(actionWidth - 16) / 2} 6) scale(${16 / 24})`,
              'aria-hidden': 'true',
            }),
          )
          const hint = Dom.svg('g', { class: 'workflow-trigger-action-tooltip', role: 'tooltip' })
          hint.appendChild(Dom.svg('rect', { x: (actionWidth - 44) / 2, y: -30, width: 44, height: 24, rx: 5 }))
          const hintText = Dom.svg('text', { x: actionWidth / 2, y: -14 })
          hintText.textContent = action.label
          hint.appendChild(hintText)
          control.appendChild(hint)
          const run = () => {
            if (unavailable) return
            if (action.id === 'clear') onClear(id)
            else onAction(id, action.id)
          }
          for (const type of ['pointerdown', 'mousedown', 'touchstart', 'dblclick'])
            control.addEventListener(type, event => event.stopPropagation())
          control.addEventListener('keydown', event => {
            if (event.key !== 'Enter' && event.key !== ' ') return
            event.preventDefault()
            event.stopPropagation()
            if (event.key === 'Enter' && !event.repeat) run()
          })
          control.addEventListener('keyup', event => {
            if (event.key !== ' ') return
            event.preventDefault()
            event.stopPropagation()
            run()
          })
          control.addEventListener('click', event => {
            event.stopPropagation()
            run()
          })
          lane.appendChild(control)
        })
        content.appendChild(
          Dom.svg('path', {
            class: 'workflow-trigger-line',
            d: `M ${center} 12 V 32 M ${center} ${32 + component.view.height} V ${contentHeight - 16}`,
          }),
        )
        content.appendChild(Dom.svg('circle', { class: 'workflow-trigger-start', cx: center, cy: 12, r: 7 }))
        content.appendChild(
          Dom.svg('circle', { class: 'workflow-trigger-end', cx: center, cy: contentHeight - 16, r: 5 }),
        )
        Dom.translate(component.view.g, center - component.view.joinX, 32)
        const dropY = branch.length === 0 ? 24 : 32 + component.view.height
        const appendPlaceholder = context.services.placeholder.createForArea(
          content,
          new Vector(laneWidth - 16, Math.max(8, contentHeight - 16 - dropY)),
          null,
          branch,
          branch.length,
        )
        Dom.translate(appendPlaceholder.view.g, 8, dropY)
        if (!disabled) appendPlaceholders.push(appendPlaceholder)
        const overflow = Math.max(0, contentHeight - bodyHeight)
        const thumbHeight = Math.max(24, (bodyHeight * bodyHeight) / contentHeight)
        const scrollbar = Dom.svg('rect', {
          class: 'workflow-trigger-scrollbar',
          x: laneWidth - 7,
          y: headerHeight,
          width: 5,
          height: thumbHeight,
          rx: 2.5,
          role: 'scrollbar',
          tabindex: overflow ? 0 : -1,
          'aria-label': `滚动${label}流程`,
          'aria-controls': `workflow-trigger-content-${id}`,
          'aria-orientation': 'vertical',
          'aria-valuemin': 0,
          'aria-valuemax': overflow,
          visibility: overflow ? 'visible' : 'hidden',
        })
        lane.appendChild(scrollbar)
        const scrollTo = (top: number) => {
          const next = clampLaneScroll(top, contentHeight, bodyHeight)
          scrollPositions.set(id, next)
          Dom.translate(content, 0, -next)
          viewport.setAttribute('data-scroll-top', String(next))
          scrollbar.setAttribute(
            'y',
            String(headerHeight + (overflow ? (next / overflow) * (bodyHeight - thumbHeight) : 0)),
          )
          scrollbar.setAttribute('aria-valuenow', String(next))
          onScroll()
        }
        lane.addEventListener(
          'wheel',
          event => {
            event.preventDefault()
            event.stopPropagation()
            const unit = event.deltaMode === 1 ? 24 : event.deltaMode === 2 ? bodyHeight : 1
            scrollTo((scrollPositions.get(id) ?? 0) + event.deltaY * unit)
          },
          { passive: false },
        )
        viewport.addEventListener('workflow-lane-scroll', event =>
          scrollTo((scrollPositions.get(id) ?? 0) + (event as CustomEvent<number>).detail),
        )
        let drag: { y: number; top: number } | null = null
        scrollbar.addEventListener('pointerdown', event => {
          event.preventDefault()
          event.stopPropagation()
          scrollbar.focus()
          scrollbar.setPointerCapture(event.pointerId)
          drag = { y: event.clientY, top: scrollPositions.get(id) ?? 0 }
        })
        scrollbar.addEventListener('mousedown', event => event.stopPropagation())
        scrollbar.addEventListener('pointermove', event => {
          if (drag) scrollTo(drag.top + ((event.clientY - drag.y) * overflow) / (bodyHeight - thumbHeight))
        })
        scrollbar.addEventListener('lostpointercapture', () => {
          drag = null
        })
        scrollbar.addEventListener('pointerup', event => scrollbar.releasePointerCapture(event.pointerId))
        scrollbar.addEventListener('keydown', event => {
          const top = scrollPositions.get(id) ?? 0
          const next = {
            ArrowDown: top + 40,
            ArrowUp: top - 40,
            PageDown: top + bodyHeight,
            PageUp: top - bodyHeight,
            Home: 0,
            End: overflow,
          }[event.key]
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
        findById: id => lanes.map(({ component }) => component.findById(id)).find(Boolean) ?? null,
        resolveClick: click => lanes.map(({ component }) => component.resolveClick(click)).find(Boolean) ?? null,
        resolvePlaceholders: (skip, result) => {
          lanes.forEach(({ component, sequence: branch, disabled }) => {
            if (!disabled && branch.length > 0) component.resolvePlaceholders(skip, result)
          })
          result.placeholders.push(...appendPlaceholders)
          // Clipped blocks must not remain drop targets outside their lane.
          result.placeholders = result.placeholders.map(placeholder => {
            const viewport = placeholder.view.g.closest('.workflow-trigger-content')!
            const clipped = Object.create(placeholder) as Placeholder
            clipped.getClientRect = () => {
              const rect = placeholder.getClientRect()
              const bounds = viewport.querySelector('.workflow-trigger-viewport-bounds')!.getBoundingClientRect()
              const x = Math.max(rect.x, bounds.left)
              const y = Math.max(rect.y, bounds.top)
              return new DOMRect(
                x,
                y,
                Math.max(0, Math.min(rect.x + rect.width, bounds.right) - x),
                Math.max(0, Math.min(rect.y + rect.height, bounds.bottom) - y),
              )
            }
            return clipped
          })
        },
        updateBadges: result => lanes.forEach(({ component }) => component.updateBadges(result)),
      }
    },
  }
}
