import { ClickCommandType, SelectStepBehaviorEndToken } from 'sequential-workflow-designer'
import type { DesignerExtension, Step } from 'sequential-workflow-designer'
import { isEditableWorkflowStep } from './workflowStepEditing.ts'

export function createWorkflowStepInteraction(
  openEditor: (stepId: string) => void,
  finishDrag?: (interrupt: boolean) => void,
  canDragStep?: (step: Step, source: Step[]) => boolean,
  openDialog?: (stepId: string) => void,
  keyboard?: {
    select: (stepId: string) => void
    remove: (stepId: string) => void
    move: (stepId: string, direction: -1 | 1) => void
  },
): DesignerExtension {
  return {
    stepComponentViewWrapper: {
      wrap(view, context) {
        if (context.isPreview) return view
        const editable = isEditableWorkflowStep(context.step)
        view.g.classList.add('workflow-editable-step')
        view.g.setAttribute('role', 'button')
        view.g.setAttribute('tabindex', '0')
        view.g.setAttribute('aria-label', `${editable ? '编辑' : ''}${context.step.name}`)
        view.g.setAttribute('aria-description', `${editable ? '回车编辑，' : ''}Delete 删除，Alt+上下方向键调整顺序`)
        view.g.addEventListener('focus', () => keyboard?.select(context.step.id))
        // Screen readers can activate an SVG button with a synthetic click.
        view.g.addEventListener('click', event => {
          if (event.detail !== 0 || !editable) return
          event.preventDefault()
          event.stopPropagation()
          ;(openDialog ?? openEditor)(context.step.id)
        })
        view.g.addEventListener('keydown', event => {
          if (
            keyboard &&
            !event.ctrlKey &&
            !event.metaKey &&
            (event.key === 'Delete' || (event.altKey && (event.key === 'ArrowUp' || event.key === 'ArrowDown')))
          ) {
            event.preventDefault()
            event.stopPropagation()
            if (event.key === 'Delete') keyboard.remove(context.step.id)
            else keyboard.move(context.step.id, event.key === 'ArrowUp' ? -1 : 1)
            return
          }
          if (
            !event.altKey &&
            !event.ctrlKey &&
            !event.metaKey &&
            (event.key === 'ArrowDown' ||
              event.key === 'ArrowUp' ||
              event.key === 'ArrowRight' ||
              event.key === 'ArrowLeft')
          ) {
            const lane = view.g.closest('.workflow-trigger-lane')
            const focusables = lane ? [...lane.querySelectorAll<SVGElement>('.workflow-editable-step')] : []
            const index = focusables.indexOf(view.g)
            const delta = event.key === 'ArrowDown' || event.key === 'ArrowRight' ? 1 : -1
            const target = focusables[index + delta]
            if (target) {
              event.preventDefault()
              event.stopPropagation()
              target.focus()
              const scrollViewport = lane?.querySelector<SVGSVGElement>('[data-trigger-scroll]')
              const bounds = scrollViewport?.querySelector('.workflow-trigger-viewport-bounds')?.getBoundingClientRect()
              const rect = target.getBoundingClientRect?.()
              if (scrollViewport && bounds && bounds.height > 0 && rect && rect.height > 0) {
                if (rect.top < bounds.top + 8) {
                  scrollViewport.dispatchEvent(
                    new CustomEvent('workflow-lane-scroll', { detail: rect.top - (bounds.top + 8) }),
                  )
                } else if (rect.bottom > bounds.bottom - 8) {
                  scrollViewport.dispatchEvent(
                    new CustomEvent('workflow-lane-scroll', { detail: rect.bottom - (bounds.bottom - 8) }),
                  )
                }
              }
            }
            return
          }
          if (event.repeat || (event.key !== 'Enter' && event.key !== ' ')) return
          event.preventDefault()
          event.stopPropagation()
          if (editable) (openDialog ?? openEditor)(context.step.id)
        })
        return view
      },
    },
    clickBehaviorWrapperExtension: {
      create: () => ({
        wrap(behavior, command) {
          if (!command) {
            // Mouse marquee selection owns blank presses. Never let the
            // designer's fallback behavior pan the canvas (including Alt/middle).
            return { onStart() {}, onMove() {}, onEnd() {} }
          }
          if (
            command?.type !== ClickCommandType.selectStep ||
            (!finishDrag && !isEditableWorkflowStep(command.component.step))
          )
            return behavior
          return {
            onStart: position => behavior.onStart(position),
            // The designer switches to its drag behavior after pointer movement.
            onMove: delta => {
              // A rejected step drag otherwise falls back to moving the viewport.
              if (canDragStep && !canDragStep(command.component.step, command.component.parentSequence)) return
              const next = behavior.onMove(delta)
              if (!next || !finishDrag) return next
              return {
                onStart: position => next.onStart(position),
                onMove: movement => next.onMove(movement),
                onEnd: (interrupt, element, token) => {
                  const result = next.onEnd(interrupt, element, token)
                  finishDrag(interrupt)
                  return result
                },
              }
            },
            onEnd: (interrupt, element, previousToken) => {
              const token = behavior.onEnd(interrupt, element, previousToken)
              if (
                isEditableWorkflowStep(command.component.step) &&
                !interrupt &&
                token &&
                SelectStepBehaviorEndToken.is(token)
              ) {
                if (
                  openDialog &&
                  previousToken &&
                  SelectStepBehaviorEndToken.is(previousToken) &&
                  token.stepId === previousToken.stepId &&
                  token.time >= previousToken.time &&
                  token.time - previousToken.time <= 500
                ) {
                  openDialog(command.component.step.id)
                  return
                }
                openEditor(command.component.step.id)
              }
              return token
            },
          }
        },
      }),
    },
  }
}
