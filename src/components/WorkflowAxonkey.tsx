import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { Trash2 } from 'lucide-react'
import type { DesignerApi, ToolboxGroupConfiguration } from 'sequential-workflow-designer'
import { DefinitionChangeType, Designer } from 'sequential-workflow-designer'
import { behaviorSummary, keyDisplayName, rightModifierChoices } from '../appConfig'
import type { AdvancedBehaviorType, CommonBehaviorPreset, MappingInput, Platform } from '../appTypes'
import { defaultCursorDistance, normalizeBehavior } from '../behaviorModel'
import type { InputId, TriggerBehaviors } from '../behaviorModel'
import { createTriggerRootExtension, isTriggerRoot } from './WorkflowTriggerRoot'
import { behaviorToWorkflowStep, behaviorsToWorkflow, insertedWorkflowSteps, isWorkflowLaneDisabled, setWorkflowLaneDisabled, workflowBranches, workflowSequenceSignature, workflowToBehaviors } from './workflowBehaviorBridge'
import { createWorkflowActionIconUrls } from './workflowActionIcons'
import { WorkflowToolbox } from './WorkflowToolbox'
import type { WorkflowToolboxPalette } from './WorkflowToolbox'
import { createWorkflowStepInteraction } from './WorkflowStepInteraction'
import { defaultWorkflowDelayMs, findWorkflowStepEditor, isEditableWorkflowStep, workflowBehaviorProperties } from './workflowStepEditing'
import { WorkflowStepDialog } from './WorkflowStepDialog'
import type { WorkflowStepEdit } from './WorkflowStepDialog'
import type { WorkflowActionChoicePreset } from './workflowActionChoices'
import { fixedWorkflowViewport } from './WorkflowViewport'
import { bindWorkflowSelection } from './workflowSelection'
import { createWorkflowDraggedSteps } from './WorkflowDraggedSteps'
import { bindWorkflowTrash } from './workflowTrash'
import 'sequential-workflow-designer/css/designer.css'
import 'sequential-workflow-designer/css/designer-light.css'
import './WorkflowAxonkey.css'

const translations: Record<string, string> = {
  'contextMenu.select': '选中',
  'contextMenu.unselect': '取消选中',
  'contextMenu.delete': '删除',
  'contextMenu.duplicate': '复制',
  'contextMenu.resetView': '重置视图',
}

type WorkflowAxonkeyProps = {
  platform: Platform
  button: MappingInput
  sequences: TriggerBehaviors
  onChange: (inputId: InputId, sequences: TriggerBehaviors) => void
  toolboxExpandedIndex: number | null
  onToolboxExpandedChange: (index: number | null) => void
}

type WorkflowAction = {
  preset: CommonBehaviorPreset | AdvancedBehaviorType | 'wheel' | 'cursorMove' | WorkflowActionChoicePreset
  name: string
  description?: string
}

export function WorkflowAxonkey({ platform, button, sequences, onChange, toolboxExpandedIndex, onToolboxExpandedChange }: WorkflowAxonkeyProps) {
  const canvasRef = useRef<HTMLDivElement>(null)
  const trashRef = useRef<HTMLButtonElement>(null)
  const savedRef = useRef('')
  const incomingRef = useRef(sequences)
  incomingRef.current = sequences
  const onChangeRef = useRef(onChange)
  onChangeRef.current = onChange
  const [reload, setReload] = useState(0)
  const [editingStep, setEditingStep] = useState<WorkflowStepEdit | null>(null)
  const [toolbox, setToolbox] = useState<{
    host: HTMLElement
    api: DesignerApi
    palettes: WorkflowToolboxPalette[]
    iconUrls: Record<string, string>
  } | null>(null)

  useEffect(() => {
    if (!canvasRef.current) return

    const commonActions: WorkflowAction[] = [
      { preset: 'escape', name: '返回 / 关闭', description: 'Esc' },
      { preset: 'enter', name: '确认 / 提交', description: 'Enter' },
      { preset: 'space', name: '空格', description: 'Space' },
      ...rightModifierChoices().map(({ preset, key }) => ({ preset, name: keyDisplayName(key, platform) })),
      { preset: 'previousTab', name: '上一标签页', description: `${keyDisplayName('Ctrl', platform)} + Shift + Tab` },
      { preset: 'nextTab', name: '下一标签页', description: `${keyDisplayName('Ctrl', platform)} + Tab` },
      { preset: 'textAndEnter', name: '输入文本并回车', description: '等待 30 毫秒后回车' },
      { preset: 'deleteAllText', name: '删除全部文本', description: '复制，等待 30 毫秒后剪切' },
      { preset: 'arrowUp', name: '方向上' },
      { preset: 'arrowDown', name: '方向下' },
      { preset: 'arrowLeft', name: '方向左' },
      { preset: 'arrowRight', name: '方向右' },
      { preset: 'tab', name: '切换焦点', description: 'Tab' },
      { preset: 'backspace', name: '向前删除', description: 'Backspace' },
      { preset: 'delete', name: '向后删除', description: 'Delete' },
      { preset: 'keyHome', name: '跳到开头', description: 'Home' },
      { preset: 'keyEnd', name: '跳到结尾', description: 'End' },
      { preset: 'pageUp', name: '向上翻页', description: 'Page Up' },
      { preset: 'pageDown', name: '向下翻页', description: 'Page Down' },
    ]
    const controlActions: WorkflowAction[] = [
      { preset: 'delay', name: '等待' },
      { preset: 'paste', name: '粘贴文本' },
      { preset: 'openApp', name: '打开应用' },
      { preset: 'openWebsite', name: '打开网站' },
    ]
    const keyboardActions: WorkflowAction[] = [
      { preset: 'customKey', name: '按键/组合键', description: '录入按键或组合键' },
    ]
    const mouseActions: WorkflowAction[] = []
    if (platform === 'windows' || platform === 'macos') {
      mouseActions.push(
        { preset: 'wheel', name: '鼠标滚动', description: '选择向上、向下、向左或向右滚动' },
        { preset: 'mouseButton', name: '鼠标按键', description: '选择左键或右键' },
        { preset: 'cursorMove', name: '光标移动', description: `选择移动方向，默认 ${defaultCursorDistance} 像素` },
      )
    }
    const mediaActions: WorkflowAction[] = [
      { preset: 'mediaPlayPause', name: '播放 / 暂停' },
      { preset: 'mediaTrack', name: '曲目切换', description: '选择上一首或下一首' },
    ]
    if (platform === 'windows') mediaActions.push({ preset: 'mediaStop', name: '停止播放' })
    mediaActions.push(
      { preset: 'volumeControl', name: '音量控制', description: '选择增大音量、减小音量或静音' },
    )
    const actionGroups = [
      { name: '控制', actions: controlActions },
      { name: '键盘', actions: keyboardActions },
      { name: '鼠标', actions: mouseActions },
      { name: '媒体控制', actions: mediaActions },
    ]
    const toGroup = (group: { name: string; actions: WorkflowAction[] }): ToolboxGroupConfiguration => ({
      name: group.name,
      steps: group.actions.map(({ preset, name, description }) => ({
        componentType: 'task', type: preset, name,
        properties: { preset, description: description ?? '', ...(preset === 'delay' ? { ms: defaultWorkflowDelayMs } : {}) },
      })),
    })
    const palettes: WorkflowToolboxPalette[] = [
      { name: '基础', groups: actionGroups.map(toGroup) },
      { name: '常用', groups: [toGroup({ name: '常用', actions: commonActions })] },
    ]
    const label = (behavior: Parameters<typeof behaviorSummary>[0]) => behaviorSummary(behavior, platform)
    const definition = behaviorsToWorkflow(sequences, label)
    savedRef.current = workflowSequenceSignature(sequences)
    let active = true
    const iconUrls = createWorkflowActionIconUrls(platform)
    let workflowApi: DesignerApi | undefined
    let selectionBinding: ReturnType<typeof bindWorkflowSelection> | undefined
    const openEditor = (stepId: string) => {
      const api = workflowApi
      if (!api || api.editor.isReadonly()) return
      const editor = findWorkflowStepEditor(api.editor.getDefinition(), stepId)
      if (!editor || isWorkflowLaneDisabled(workflowBranches(api.editor.getDefinition())[editor.trigger])) return
      setEditingStep({
        stepId, trigger: editor.trigger, behavior: editor.behavior,
        onSave: (behavior) => {
          if (!active) return
          const current = findWorkflowStepEditor(api.editor.getDefinition(), stepId)
          if (!current || api.editor.isReadonly()) return
          const properties = workflowBehaviorProperties(current.step, behavior)
          if (!properties) return
          const savedBehavior = normalizeBehavior({ ...behavior, id: stepId })
          if (!savedBehavior) return
          const group = current.step.properties.draftGroup
          for (const branch of Object.values(workflowBranches(api.editor.getDefinition()))) {
            for (const node of branch) {
              if (group && node.properties.draftGroup === group) delete node.properties.draftGroup
            }
          }
          Object.assign(current.step, behaviorToWorkflowStep(savedBehavior, label))
          api.editor.createStepEditorContext('axonkey-triggers').notifyChildrenChanged()
          setEditingStep(null)
        },
      })
    }
    const designer = Designer.create(canvasRef.current, definition, {
      theme: 'light',
      // Undo/redo uses the application's shared behavior history and persistence.
      steps: {
        iconUrlProvider: (_componentType, type) => iconUrls[type] ?? null,
        isDraggable: (step, source) => !isTriggerRoot(step) && !isWorkflowLaneDisabled(source) && (selectionBinding?.canDragSelection() ?? true),
        isDeletable: (step, source) => !isTriggerRoot(step) && !isWorkflowLaneDisabled(source),
        isDuplicable: (step, source) => !isTriggerRoot(step) && !isWorkflowLaneDisabled(source),
        canInsertStep: (_step, target) => !target.some(isTriggerRoot) && !isWorkflowLaneDisabled(target),
        canMoveStep: (source, step, target) => !isTriggerRoot(step) && !target.some(isTriggerRoot) && !isWorkflowLaneDisabled(source) && !isWorkflowLaneDisabled(target),
      },
      extensions: [fixedWorkflowViewport, createWorkflowStepInteraction(openEditor, (interrupt) => selectionBinding?.finishDrag(interrupt)), {
        draggedComponent: createWorkflowDraggedSteps((step) => selectionBinding?.getDragSteps(step.id) ?? [step]),
        contextMenu: {
          createItemsProvider: () => ({
            getItems: (step, parentSequence) => step && isEditableWorkflowStep(step) && !workflowApi?.editor.isReadonly() && !isWorkflowLaneDisabled(parentSequence)
              ? [{ label: '编辑', order: -1, callback: () => openEditor(step.id) }]
              : [],
          }),
        },
        rootComponent: createTriggerRootExtension((trigger, disabled) => {
          const api = workflowApi
          if (!active || !api || api.editor.isReadonly()) return
          if (!setWorkflowLaneDisabled(api.editor.getDefinition(), trigger, disabled, label)) return
          const restoreFocus = document.activeElement?.getAttribute('data-trigger-toggle') === trigger
          if (restoreFocus) void designer.onRootComponentUpdated.once().then(() => {
            if (active) canvasRef.current?.querySelector<HTMLButtonElement>(`[data-trigger-toggle="${trigger}"]`)?.focus()
          })
          api.editor.createStepEditorContext('axonkey-triggers').notifyChildrenChanged()
        }),
        uiComponents: [{
          create: (root, api) => {
            workflowApi = api
            const host = document.createElement('aside')
            host.className = 'sqd-toolbox workflow-toolbox'
            host.setAttribute('aria-label', '积木工具箱')
            root.appendChild(host)
            setToolbox({ host, api, palettes, iconUrls })
            return { updateLayout() {}, destroy() { host.remove() } }
          },
        }],
      }],
      toolbox: false,
      editors: false,
      controlBar: false,
      contextMenu: true,
      keyboard: false,
      i18n: (key, defaultValue) => translations[key] ?? defaultValue,
    })
    selectionBinding = bindWorkflowSelection(canvasRef.current, designer, () => {
      workflowApi?.editor.createStepEditorContext('axonkey-triggers').notifyChildrenChanged()
    }, () => workflowApi?.workspace)
    const unbindTrash = trashRef.current ? bindWorkflowTrash(canvasRef.current, trashRef.current, designer, (stepId) => {
      const api = workflowApi
      if (!active || !api || api.editor.isReadonly()) return
      const definition = api.editor.getDefinition()
      const selectedIds = new Set(selectionBinding?.getSelectedIds())
      const idsToDelete = selectedIds.has(stepId) ? selectedIds : new Set([stepId])
      let removed = false
      for (const branch of Object.values(workflowBranches(definition))) {
        if (isWorkflowLaneDisabled(branch)) continue
        for (let index = branch.length - 1; index >= 0; index--) {
          if (!idsToDelete.has(branch[index].id) || branch[index].type === 'disabled') continue
          branch.splice(index, 1)
          removed = true
        }
      }
      if (!removed) return
      designer.clearSelectedStep()
      api.editor.createStepEditorContext('axonkey-triggers').notifyChildrenChanged()
    }) : () => {}
    let ready = false
    designer.onReady.subscribe(() => { ready = true })
    designer.onDefinitionChanged.subscribe((event) => {
      if (!active) return
      const current = workflowApi?.editor.getDefinition()
      if (!current) return
      if (event.changeType === DefinitionChangeType.stepInserted && event.stepId) {
        for (const branch of Object.values(workflowBranches(current))) {
          const index = branch.findIndex((step) => step.id === event.stepId)
          if (index < 0) continue
          const nodes = insertedWorkflowSteps(branch[index], platform, label)
          branch.splice(index, 1, ...nodes)
          workflowApi!.editor.createStepEditorContext('axonkey-triggers').notifyChildrenChanged()
          openEditor(event.stepId)
          return
        }
      }
      const next = workflowToBehaviors(current)
      if (next && workflowSequenceSignature(next) !== savedRef.current) {
        savedRef.current = workflowSequenceSignature(next)
        onChangeRef.current(button.id, next)
      }
    })
    const resizeObserver = new ResizeObserver(() => {
      if (!ready || designer.isDragging()) return
      designer.updateLayout()
      designer.resetViewport()
    })
    resizeObserver.observe(canvasRef.current)

    return () => {
      active = false
      // Designer events are batched. Flush a last drop/move/delete before a fast
      // key/page switch, but never write the old canvas over an external undo.
      if (workflowApi && workflowSequenceSignature(incomingRef.current) === savedRef.current) {
        const current = workflowApi.editor.getDefinition()
        for (const branch of Object.values(workflowBranches(current))) {
          for (let index = branch.length - 1; index >= 0; index--) {
            if (!branch[index].properties.behaviorType) branch.splice(index, 1, ...insertedWorkflowSteps(branch[index], platform, label))
          }
        }
        const next = workflowToBehaviors(current)
        if (next && workflowSequenceSignature(next) !== savedRef.current) onChangeRef.current(button.id, next)
      }
      setEditingStep(null)
      setToolbox(null)
      resizeObserver.disconnect()
      selectionBinding?.()
      unbindTrash()
      designer.destroy()
    }
  }, [platform, button.id, reload])

  useEffect(() => {
    // An import, reset, or shared undo replaces the view. Our own save echo keeps
    // the current designer and its viewport intact.
    if (workflowSequenceSignature(sequences) !== savedRef.current) setReload((value) => value + 1)
  }, [sequences])

  const closeEditor = () => {
    if (editingStep && toolbox) {
      const definition = toolbox.api.editor.getDefinition()
      let removed = false
      for (const branch of Object.values(workflowBranches(definition))) {
        for (let index = branch.length - 1; index >= 0; index--) {
          if (branch[index].properties.draftGroup === editingStep.stepId) {
            branch.splice(index, 1)
            removed = true
          }
        }
      }
      if (removed) toolbox.api.editor.createStepEditorContext('axonkey-triggers').notifyChildrenChanged()
    }
    setEditingStep(null)
  }

  return <section className="workflow-axonkey" aria-label={`${button.label} · 行为流程图`}>
    <div ref={canvasRef} className="workflow-axonkey-canvas" tabIndex={-1} aria-label="行为流程图画布" />
    <button ref={trashRef} type="button" className="workflow-trash" aria-label="垃圾桶，拖入积木即可删除" tabIndex={-1}>
      <Trash2 size={21} strokeWidth={1.8} aria-hidden="true" />
      <span>拖入删除</span>
    </button>
    {toolbox && createPortal(<WorkflowToolbox api={toolbox.api} palettes={toolbox.palettes} iconUrls={toolbox.iconUrls} expandedIndex={toolboxExpandedIndex} onExpandedChange={onToolboxExpandedChange} />, toolbox.host)}
    {editingStep && createPortal(<WorkflowStepDialog key={editingStep.stepId} edit={editingStep} platform={platform} button={button} onClose={closeEditor} />, document.body)}
  </section>
}
