import { Dom } from 'sequential-workflow-designer'
import type {
  BranchedStep,
  Definition,
  Placeholder,
  RootComponentExtension,
  Sequence,
  Step,
  StepComponent,
} from 'sequential-workflow-designer'
import type { TriggerType } from '../behaviorModel.ts'
import { clampLaneScroll, layoutWorkflowFlow, workflowLaneLayout } from './workflowLaneLayout.ts'
import type { WorkflowDropSlot } from './workflowLaneLayout.ts'

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

function createFlowPlaceholder(
  parent: SVGElement,
  viewport: SVGSVGElement,
  workspaceRoot: Element | null,
  parentSequence: Sequence,
  slot: WorkflowDropSlot,
): Placeholder {
  const g = Dom.svg('g', {
    class: slot.empty ? 'sqd-placeholder workflow-empty-lane-placeholder' : 'sqd-placeholder workflow-flow-placeholder',
  })
  const hitRect = Dom.svg('rect', {
    class: 'workflow-placeholder-hit',
    x: slot.hit.x,
    y: slot.hit.y,
    width: slot.hit.width,
    height: slot.hit.height,
    fill: 'transparent',
  })
  const barRect = Dom.svg('rect', {
    class: 'sqd-placeholder-rect',
    x: slot.bar.x,
    y: slot.bar.y,
    width: slot.bar.width,
    height: slot.bar.height,
    rx: slot.empty ? 8 : 1.5,
    ry: slot.empty ? 8 : 1.5,
  })
  g.appendChild(hitRect)
  g.appendChild(barRect)
  if (slot.empty) {
    const cx = slot.bar.x + slot.bar.width / 2
    const cy = slot.bar.y + slot.bar.height / 2
    g.appendChild(
      Dom.svg('path', {
        class: 'workflow-empty-lane-plus',
        d: `M ${cx} ${cy - 4.5} V ${cy + 4.5} M ${cx - 4.5} ${cy} H ${cx + 4.5}`,
        'aria-hidden': 'true',
      }),
    )
  }
  parent.appendChild(g)

  return {
    parentSequence,
    index: slot.index,
    view: { g },
    getClientRect() {
      if (workspaceRoot?.querySelector('.workflow-trash.is-drag-over')) {
        return new DOMRect(0, 0, 0, 0)
      }
      const rect = hitRect.getBoundingClientRect()
      const bounds = viewport.querySelector('.workflow-trigger-viewport-bounds')!.getBoundingClientRect()
      const x = Math.max(rect.x, bounds.left)
      const y = Math.max(rect.y, bounds.top)
      return new DOMRect(
        x,
        y,
        Math.max(0, Math.min(rect.x + rect.width, bounds.right) - x),
        Math.max(0, Math.min(rect.y + rect.height, bounds.bottom) - y),
      )
    },
    setIsHover(isHover) {
      Dom.toggleClass(g, isHover, 'sqd-hover')
    },
    setIsVisible(isVisible) {
      Dom.toggleClass(g, isVisible, 'is-visible')
    },
    resolveClick() {
      return null
    },
  }
}

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
      const workspaceRoot = canvas?.parentElement ?? null
      const svg = parent.ownerSVGElement
      svg?.setAttribute('role', 'group')
      svg?.setAttribute('aria-label', '触发方式与行为')
      const svgBounds = svg?.getBoundingClientRect()
      const width = canvas?.clientWidth ?? svg?.clientWidth ?? svgBounds?.width ?? 800
      const height = canvas?.clientHeight ?? svg?.clientHeight ?? svgBounds?.height ?? 400
      const maxLabelLength = Math.max(1, ...visibleTriggers.map(trigger => trigger.label.length))
      const { gap, padding, laneWidth, laneHeight, bodyHeight, headerHeight, compactHeader } = workflowLaneLayout(
        width,
        height,
        visibleTriggers.length,
        maxLabelLength,
      )
      const lanes = visibleTriggers.map(({ id, label }) => {
        const branch = root.branches[id]
        const disabled = isWorkflowLaneDisabled(branch)
        const lane = Dom.svg('g', {
          class: `workflow-trigger-lane workflow-trigger-${id}${disabled ? ' workflow-trigger-disabled' : ''}`,
          'data-trigger': id,
          'data-compact-header': String(compactHeader),
          role: 'group',
          'aria-label': `${label}行为`,
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
          role: 'group',
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
        const itemsLayer = Dom.svg('g', { class: 'workflow-flow-items' })
        const placeholdersLayer = Dom.svg('g', { class: 'workflow-flow-placeholders' })
        content.appendChild(itemsLayer)
        content.appendChild(placeholdersLayer)

        const stepComponents: StepComponent[] = branch.map((step, index) =>
          context.stepComponentFactory.create(
            itemsLayer,
            {
              parentSequence: branch,
              step,
              depth: 1,
              position: index,
              isInputConnected: false,
              isOutputConnected: false,
              isPreview: false,
            },
            context,
          ),
        )
        const flow = layoutWorkflowFlow(
          stepComponents.map(component => ({ width: component.view.width, height: component.view.height })),
          laneWidth,
          bodyHeight,
        )
        for (let i = 0; i < stepComponents.length; i++) {
          Dom.translate(stepComponents[i].view.g, flow.items[i].x, flow.items[i].y)
        }
        const placeholders: Placeholder[] = disabled
          ? []
          : flow.slots
              .filter(slot => context.placeholderController.canCreate(branch, slot.index))
              .map(slot => createFlowPlaceholder(placeholdersLayer, viewport, workspaceRoot, branch, slot))

        return { id, lane, viewport, content, stepComponents, placeholders, flow, label, disabled, sequence: branch }
      })

      let offset = padding
      for (const { id, lane, viewport, content, flow, label, sequence: branch } of lanes) {
        Dom.translate(lane, offset, padding)
        const center = laneWidth / 2
        const { contentHeight, overflow } = flow
        const background = Dom.svg('rect', {
          class: 'workflow-trigger-background',
          width: laneWidth,
          height: laneHeight,
          rx: 12,
        })
        lane.insertBefore(background, viewport)

        if (compactHeader) {
          lane.appendChild(
            Dom.svg('circle', {
              class: 'workflow-trigger-dot',
              cx: 12,
              cy: 18,
              r: 3.2,
              'aria-hidden': 'true',
            }),
          )
          const title = Dom.svg('text', {
            class: 'workflow-trigger-title',
            x: 20,
            y: 22.5,
          })
          title.textContent = label
          lane.appendChild(title)
        } else {
          lane.appendChild(
            Dom.svg('circle', {
              class: 'workflow-trigger-dot',
              cx: center - label.length * 6.5 - 3.5,
              cy: 17,
              r: 3.2,
              'aria-hidden': 'true',
            }),
          )
          const title = Dom.svg('text', { class: 'workflow-trigger-title', x: center + 6, y: 22 })
          title.textContent = label
          lane.appendChild(title)
        }

        const thumbHeight = Math.max(22, (bodyHeight * bodyHeight) / contentHeight)
        const scrollbar = Dom.svg('rect', {
          class: 'workflow-trigger-scrollbar',
          x: laneWidth - 6,
          y: headerHeight,
          width: 4,
          height: thumbHeight,
          rx: 2,
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

        // Keep controls in SVG coordinates and append after viewport/scrollbar so
        // downward tooltips on compact top-row headers paint cleanly above content.
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
        const columns = compactHeader ? 4 : headerHeight > 60 ? 2 : 4
        const actionGap = compactHeader ? (laneWidth >= 184 ? 4 : 3) : 4
        const actionHeight = 24
        const actionWidth = compactHeader
          ? laneWidth >= 184
            ? 24
            : 22
          : Math.min(28, Math.max(20, (laneWidth - 16 - (columns - 1) * actionGap) / columns))
        const actionsLeft = compactHeader
          ? laneWidth - 7 - (4 * actionWidth + 3 * actionGap)
          : center - (columns * actionWidth + (columns - 1) * actionGap) / 2
        const iconSize = compactHeader ? 14 : 15

        actions.forEach((action, index) => {
          const unavailable = action.id !== 'paste' && branch.length === 0
          const controlX = actionsLeft + (index % columns) * (actionWidth + actionGap)
          const controlY = compactHeader ? 6 : 30 + Math.floor(index / columns) * 26
          const control = Dom.svg('g', {
            class: 'workflow-trigger-action',
            role: 'button',
            tabindex: 0,
            'aria-label': `${action.label}${label}流程`,
            'aria-disabled': String(unavailable),
            [`data-trigger-${action.id}`]: id,
          })
          Dom.translate(control, controlX, controlY)
          control.appendChild(Dom.svg('rect', { width: actionWidth, height: actionHeight, rx: 5 }))
          control.appendChild(
            Dom.svg('path', {
              class: 'workflow-trigger-action-icon',
              d: action.icon,
              transform: `translate(${(actionWidth - iconSize) / 2} ${(actionHeight - iconSize) / 2}) scale(${iconSize / 24})`,
              'aria-hidden': 'true',
            }),
          )
          const tipWidth = 42
          const tipHeight = 22
          const tipX = Math.max(
            3 - controlX,
            Math.min(laneWidth - tipWidth - 3 - controlX, (actionWidth - tipWidth) / 2),
          )
          const tipY = padding + controlY < 28 ? actionHeight + 5 : -(tipHeight + 4)
          const hint = Dom.svg('g', { class: 'workflow-trigger-action-tooltip', role: 'tooltip' })
          hint.appendChild(Dom.svg('rect', { x: tipX, y: tipY, width: tipWidth, height: tipHeight, rx: 5 }))
          const hintText = Dom.svg('text', { x: tipX + tipWidth / 2, y: tipY + 15 })
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

        const scrollTo = (top: number, notify = true) => {
          const prev = scrollPositions.get(id) ?? 0
          const next = clampLaneScroll(top, contentHeight, bodyHeight)
          scrollPositions.set(id, next)
          Dom.translate(content, 0, -next)
          viewport.setAttribute('data-scroll-top', String(next))
          scrollbar.setAttribute(
            'y',
            String(headerHeight + (overflow ? (next / overflow) * (bodyHeight - thumbHeight) : 0)),
          )
          scrollbar.setAttribute('aria-valuenow', String(next))
          if (notify && next !== prev) onScroll()
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
          if (drag && bodyHeight > thumbHeight) {
            scrollTo(drag.top + ((event.clientY - drag.y) * overflow) / (bodyHeight - thumbHeight))
          }
        })
        scrollbar.addEventListener('lostpointercapture', () => {
          drag = null
        })
        scrollbar.addEventListener('pointerup', event => scrollbar.releasePointerCapture(event.pointerId))
        scrollbar.addEventListener('keydown', event => {
          const top = scrollPositions.get(id) ?? 0
          const next = {
            ArrowDown: top + 36,
            ArrowUp: top - 36,
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
        scrollTo(scrollPositions.get(id) ?? 0, false)
        offset += laneWidth + gap
      }

      return {
        view: { g, width, height, joinX: width / 2 },
        findById: id =>
          lanes
            .flatMap(({ stepComponents }) => stepComponents)
            .map(component => component.findById(id))
            .find(Boolean) ?? null,
        resolveClick: click =>
          lanes
            .flatMap(({ stepComponents }) => stepComponents)
            .map(component => component.resolveClick(click))
            .find(Boolean) ?? null,
        resolvePlaceholders: (skip, result) => {
          for (const { stepComponents, placeholders, sequence: branch, disabled } of lanes) {
            if (disabled) continue
            for (const component of stepComponents) component.resolvePlaceholders(skip, result)
            const sourceIndex = skip && skip.parentSequence === branch ? branch.indexOf(skip.step) : -1
            for (const placeholder of placeholders) {
              if (sourceIndex >= 0 && (placeholder.index === sourceIndex || placeholder.index === sourceIndex + 1)) {
                continue
              }
              result.placeholders.push(placeholder)
            }
          }
        },
        updateBadges: result =>
          lanes.forEach(({ stepComponents }) => stepComponents.forEach(component => component.updateBadges(result))),
      }
    },
  }
}
