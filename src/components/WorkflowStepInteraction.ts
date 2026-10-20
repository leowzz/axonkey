import { ClickCommandType, SelectStepBehaviorEndToken } from 'sequential-workflow-designer'
import type { DesignerExtension } from 'sequential-workflow-designer'
import { isEditableWorkflowStep } from './workflowStepEditing.ts'

export function createWorkflowStepInteraction(openEditor: (stepId: string) => void): DesignerExtension {
  return {
    stepComponentViewWrapper: {
      wrap(view, context) {
        if (context.isPreview || !isEditableWorkflowStep(context.step)) return view
        view.g.classList.add('workflow-editable-step')
        view.g.setAttribute('role', 'button')
        view.g.setAttribute('tabindex', '0')
        view.g.setAttribute('aria-label', `编辑${context.step.name}`)
        view.g.setAttribute('aria-description', '双击打开编辑窗口，也可按 Enter 或空格键编辑')
        view.g.addEventListener('keydown', (event) => {
          if (event.key !== 'Enter' && event.key !== ' ') return
          event.preventDefault()
          event.stopPropagation()
          openEditor(context.step.id)
        })
        return view
      },
    },
    clickBehaviorWrapperExtension: {
      create: () => ({
        wrap(behavior, command) {
          if (command?.type !== ClickCommandType.selectStep || !isEditableWorkflowStep(command.component.step)) return behavior
          return {
            onStart: (position) => behavior.onStart(position),
            // The designer switches to its drag behavior after pointer movement.
            onMove: (delta) => behavior.onMove(delta),
            onEnd: (interrupt, element, previousToken) => {
              const token = behavior.onEnd(interrupt, element, previousToken)
              if (!interrupt && token && SelectStepBehaviorEndToken.is(token) && SelectStepBehaviorEndToken.is(previousToken)
                && token.stepId === previousToken.stepId && token.time >= previousToken.time && token.time - previousToken.time <= 500) {
                openEditor(command.component.step.id)
                return
              }
              return token
            },
          }
        },
      }),
    },
  }
}
