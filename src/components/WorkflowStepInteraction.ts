import { ClickCommandType, SelectStepBehaviorEndToken } from 'sequential-workflow-designer'
import type { DesignerExtension, Step } from 'sequential-workflow-designer'
import { isEditableWorkflowStep } from './workflowStepEditing.ts'

export function createWorkflowStepInteraction(
  openEditor: (stepId: string) => void,
  finishDrag?: (interrupt: boolean) => void,
  canDragStep?: (step: Step, source: Step[]) => boolean,
  openDialog?: (stepId: string) => void,
): DesignerExtension {
  return {
    stepComponentViewWrapper: {
      wrap(view, context) {
        if (context.isPreview || !isEditableWorkflowStep(context.step)) return view
        view.g.classList.add('workflow-editable-step')
        view.g.setAttribute('role', 'button')
        view.g.setAttribute('tabindex', '0')
        view.g.setAttribute('aria-label', `编辑${context.step.name}`)
        view.g.setAttribute('aria-description', '单击在下方编辑，双击或 Alt+Enter 打开编辑弹窗')
        view.g.addEventListener('keydown', event => {
          if (event.key !== 'Enter' && event.key !== ' ') return
          event.preventDefault()
          event.stopPropagation()
          if (event.altKey && openDialog) openDialog(context.step.id)
          else openEditor(context.step.id)
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
