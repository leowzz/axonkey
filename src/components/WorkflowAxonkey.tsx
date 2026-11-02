import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { Trash2 } from 'lucide-react'
import type { DesignerApi, Step, ToolboxGroupConfiguration } from 'sequential-workflow-designer'
import { DefinitionChangeType, Designer, StepsDesignerExtension } from 'sequential-workflow-designer'
import { behaviorSummary, keyDisplayName, rightModifierChoices, triggerLabels } from '../appConfig'
import type { AdvancedBehaviorType, CommonBehaviorPreset, MappingInput, Platform } from '../appTypes'
import { defaultCursorDistance, normalizeBehavior, serializeSequence } from '../behaviorModel'
import type { Behavior, InputId, TriggerBehaviors, TriggerType, SwitchProfileBehavior } from '../behaviorModel'
import { writeClipboardText } from '../clipboard'
import { createSavedSequence, parseSavedSequences, savedSequencesStorageKey } from '../savedSequences'
import type { SavedSequence } from '../savedSequences'
import { SequencePasteDialog } from './BehaviorEditor'
import { WorkflowSequenceSaveDialog } from './WorkflowSequenceSaveDialog'
import { createTriggerRootExtension, defaultWorkflowTriggers, isTriggerRoot } from './WorkflowTriggerRoot'
import { behaviorToWorkflowStep, behaviorsToWorkflow, clearWorkflowLane, insertedWorkflowSteps, isWorkflowLaneDisabled, isWorkflowStepLocked, workflowBranches, workflowSequenceSignature, workflowToBehaviors } from './workflowBehaviorBridge'
import { createWorkflowActionIconUrls } from './workflowActionIcons'
import { WorkflowToolbox } from './WorkflowToolbox'
import type { WorkflowToolboxPalette } from './WorkflowToolbox'
import { createWorkflowStepInteraction } from './WorkflowStepInteraction'
import { defaultWorkflowDelayMs, findWorkflowStepEditor, isEditableWorkflowStep, workflowBehaviorProperties, workflowStepBehavior } from './workflowStepEditing'
import { WorkflowStepDialog } from './WorkflowStepDialog'
import type { WorkflowStepEdit } from './WorkflowStepDialog'
import type { WorkflowActionChoicePreset } from './workflowActionChoices'
import { fixedWorkflowViewport } from './WorkflowViewport'
import { bindWorkflowSelection } from './workflowSelection'
import { createWorkflowDraggedSteps } from './WorkflowDraggedSteps'
import { bindWorkflowTrash } from './workflowTrash'
import { workflowLaneLayout } from './workflowLaneLayout'
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

type WorkflowAxonkeyProps<Id extends string> = {
  platform: Platform
  button: MappingInput<Id>
  sequences: TriggerBehaviors
  activeTrigger?: TriggerType
  onRequestProfileSwitch: (inputId: Id, trigger: TriggerType, behavior: SwitchProfileBehavior) => void
  onChange: (inputId: Id, sequences: TriggerBehaviors) => void | false
  toolboxCategory: string
  onToolboxCategoryChange: (category: string) => void
}

type WorkflowAction = {
  preset: CommonBehaviorPreset | AdvancedBehaviorType | 'wheel' | 'cursorMove' | 'switchProfile' | WorkflowActionChoicePreset
  name: string
  description?: string
}

export function WorkflowAxonkey<Id extends string = InputId>({ platform, button, sequences, activeTrigger, onChange, onRequestProfileSwitch, toolboxCategory, onToolboxCategoryChange }: WorkflowAxonkeyProps<Id>) {
  const triggers = button.triggerLabel ? [{ id: 'click' as const, label: button.triggerLabel }]
    : activeTrigger ? defaultWorkflowTriggers.filter(trigger => trigger.id === activeTrigger) : defaultWorkflowTriggers
  const triggersRef = useRef(triggers)
  triggersRef.current = triggers
  const refreshLanesRef = useRef<(() => void) | null>(null)
  const inputLabel = [button.label, button.contextLabel].filter(Boolean).join(' · ')
  const workflowRef = useRef<HTMLElement>(null)
  const canvasRef = useRef<HTMLDivElement>(null)
  const trashRef = useRef<HTMLButtonElement>(null)
  const savedRef = useRef('')
  const incomingRef = useRef(sequences)
  incomingRef.current = sequences
  const onChangeRef = useRef(onChange)
  onChangeRef.current = onChange
  const onRequestProfileSwitchRef = useRef(onRequestProfileSwitch)
  onRequestProfileSwitchRef.current = onRequestProfileSwitch
  const [reload, setReload] = useState(0)
  const [library, setLibrary] = useState<{ items: SavedSequence[]; error: string }>(() => {
    try { return { items: parseSavedSequences(window.localStorage.getItem(savedSequencesStorageKey)), error: '' } }
    catch { return { items: [], error: '无法读取已保存的序列，请重新打开页面重试。' } }
  })
  const [sequenceDialog, setSequenceDialog] = useState<
    { type: 'save'; trigger: TriggerType; behaviors: Behavior[] } | { type: 'paste'; trigger: TriggerType } | null
  >(null)
  const [laneStatus, setLaneStatus] = useState('')
  useEffect(() => {
    if (!laneStatus) return
    const timer = window.setTimeout(() => setLaneStatus(''), 3500)
    return () => window.clearTimeout(timer)
  }, [laneStatus])
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
      { preset: 'enter', name: '确认 / 回车', description: 'Enter' },
      { preset: 'space', name: '空格', description: 'Space' },
      ...rightModifierChoices().map(({ preset, key }) => ({ preset, name: keyDisplayName(key, platform) })),
      { preset: 'previousTab', name: '上一标签页', description: `${keyDisplayName('Ctrl', platform)} + Shift + Tab` },
      { preset: 'nextTab', name: '下一标签页', description: `${keyDisplayName('Ctrl', platform)} + Tab` },
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
    const compositeActions: WorkflowAction[] = [
      { preset: 'textAndEnter', name: '输入文本并回车', description: '等待 30 毫秒后回车' },
      { preset: 'deleteAllText', name: '删除全部文本', description: `${keyDisplayName(platform === 'macos' ? 'Win' : 'Ctrl', platform)} + A，等待 30 毫秒后 ${keyDisplayName(platform === 'macos' ? 'Win' : 'Ctrl', platform)} + X` },
    ]
    const controlActions: WorkflowAction[] = [
      { preset: 'switchProfile', name: '切换配置文件', description: '上一个或下一个配置文件，可设置到边缘自动循环' },
      { preset: 'disabled', name: '禁用此触发方式', description: '替换当前泳道的序列，不发送任何输入；清空泳道可取消禁用' },
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
      { name: '常用行为', groups: [toGroup({ name: '常用行为', actions: commonActions })] },
      { name: '组合行为', groups: [toGroup({ name: '组合行为', actions: compositeActions })] },
    ]
    const label = (behavior: Parameters<typeof behaviorSummary>[0]) => behaviorSummary(behavior, platform)
    const definition = behaviorsToWorkflow(sequences, label)
    let acceptedBranches = structuredClone(workflowBranches(definition))
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
          if (savedBehavior.type === 'switchProfile') {
            setEditingStep(null)
            onRequestProfileSwitchRef.current(button.id, current.trigger, savedBehavior)
            return
          }
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
    const canDragStep = (step: Step, source: Step[]) => !workflowApi?.editor.isReadonly()
      && !isTriggerRoot(step) && !isWorkflowStepLocked(step, source) && (selectionBinding?.canDragSelection() ?? true)
    const designer = Designer.create(canvasRef.current, definition, {
      theme: 'light',
      textWidthMeasurer: (text) => {
        const full = text.textContent ?? ''
        const maxWidth = Math.max(20, workflowLaneLayout(canvasRef.current?.clientWidth ?? 800, 400, triggersRef.current.length).laneWidth - 62)
        if (text.getComputedTextLength() > maxWidth) {
          let end = full.length
          do { text.textContent = `${full.slice(0, --end)}…` } while (end > 0 && text.getComputedTextLength() > maxWidth)
          const title = document.createElementNS('http://www.w3.org/2000/svg', 'title')
          title.textContent = full
          text.parentElement?.appendChild(title)
        }
        return text.getComputedTextLength()
      },
      // Undo/redo uses the application's shared behavior history and persistence.
      steps: {
        iconUrlProvider: (_componentType, type) => iconUrls[type] ?? null,
        isDraggable: canDragStep,
        isDeletable: (step, source) => !isTriggerRoot(step) && !isWorkflowStepLocked(step, source),
        isDuplicable: (step, source) => step.type !== 'switchProfile' && !isTriggerRoot(step) && !isWorkflowLaneDisabled(source),
        canInsertStep: (_step, target) => !target.some(isTriggerRoot) && !isWorkflowLaneDisabled(target),
        canMoveStep: (source, step, target) => step.type !== 'switchProfile' && !isTriggerRoot(step) && !target.some(isTriggerRoot) && !isWorkflowLaneDisabled(source) && !isWorkflowLaneDisabled(target),
      },
      extensions: [fixedWorkflowViewport, StepsDesignerExtension.create({ task: { view: {
        paddingLeft: 8, paddingRight: 8, paddingY: 10, textMarginLeft: 8,
        minTextWidth: 20, iconSize: 18, radius: 5, inputSize: 14, outputSize: 10,
      } } }), createWorkflowStepInteraction(openEditor, (interrupt) => selectionBinding?.finishDrag(interrupt), canDragStep), {
        draggedComponent: createWorkflowDraggedSteps((step) => selectionBinding?.getDragSteps(step.id) ?? [step]),
        contextMenu: {
          createItemsProvider: () => ({
            getItems: (step, parentSequence) => step && isEditableWorkflowStep(step) && !workflowApi?.editor.isReadonly() && !isWorkflowLaneDisabled(parentSequence)
              ? [{ label: '编辑', order: -1, callback: () => openEditor(step.id) }]
              : [],
          }),
        },
        rootComponent: createTriggerRootExtension((trigger) => {
          const api = workflowApi
          if (!active || !api || api.editor.isReadonly()) return
          if (!clearWorkflowLane(api.editor.getDefinition(), trigger)) return
          const restoreFocus = document.activeElement?.getAttribute('data-trigger-clear') === trigger
          if (restoreFocus) void designer.onRootComponentUpdated.once().then(() => {
            if (active) canvasRef.current?.querySelector<SVGElement>(`[data-trigger-clear="${trigger}"]`)?.focus()
          })
          api.editor.createStepEditorContext('axonkey-triggers').notifyChildrenChanged()
        }, () => {
          // Invalidate the designer's cached drag targets after a lane scroll.
          const workspace = workflowApi?.workspace
          if (workspace) workspace.setViewport(workspace.getViewport())
        }, (trigger, action) => {
          const api = workflowApi
          if (!active || !api || api.editor.isReadonly()) return
          if (action === 'paste') { setSequenceDialog({ type: 'paste', trigger }); return }
          const current = api.editor.getDefinition()
          if (workflowBranches(current)[trigger].some((step) => step.properties.draftGroup)) {
            setLaneStatus('请先完成当前泳道中的行为配置')
            return
          }
          const sequence = workflowToBehaviors(current)?.[trigger]
          if (!sequence?.length) return
          if (action === 'save') setSequenceDialog({ type: 'save', trigger, behaviors: sequence })
          else void writeClipboardText(serializeSequence(sequence)).then(() => {
            if (active) setLaneStatus(`${button.triggerLabel ?? triggerLabels[trigger]}序列已复制`)
          }).catch(() => { if (active) setLaneStatus('复制失败，请重试') })
        }, () => triggersRef.current),
        uiComponents: [{
          create: (root, api) => {
            workflowApi = api
            const host = document.createElement('aside')
            host.className = 'sqd-toolbox workflow-toolbox'
            host.setAttribute('aria-label', '行为工具箱')
            // Keep the toolbox in the workbench layout so it stays docked to
            // the canvas instead of floating over the designer surface.
            const toolboxParent = workflowRef.current && typeof workflowRef.current.appendChild === 'function'
              ? workflowRef.current
              : root
            toolboxParent.appendChild(host)
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
        for (let index = branch.length - 1; index >= 0; index--) {
          if (!idsToDelete.has(branch[index].id) || isWorkflowStepLocked(branch[index], branch)) continue
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
    const persist = (next: TriggerBehaviors) => {
      const signature = workflowSequenceSignature(next)
      const current = workflowBranches(workflowApi!.editor.getDefinition())
      if (signature === savedRef.current) {
        acceptedBranches = structuredClone(current)
        return
      }
      const previousSignature = savedRef.current
      savedRef.current = signature
      // Shared-action deletion can wait for the app's confirmation dialog.
      // Restore the canvas immediately so cancel and cleanup cannot save it.
      if (onChangeRef.current(button.id, next) === false) {
        savedRef.current = previousSignature
        if (active && workflowApi) {
          // Keep incomplete drafts in other lanes when the user cancels.
          const restored = structuredClone(acceptedBranches)
          for (const trigger of Object.keys(current) as TriggerType[]) current[trigger].splice(0, current[trigger].length, ...restored[trigger])
          workflowApi.editor.createStepEditorContext('axonkey-triggers').notifyChildrenChanged()
        }
        return
      }
      acceptedBranches = structuredClone(current)
    }
    designer.onDefinitionChanged.subscribe((event) => {
      if (!active) return
      const current = workflowApi?.editor.getDefinition()
      if (!current) return
      if (event.changeType === DefinitionChangeType.stepInserted && event.stepId) {
        for (const [trigger, branch] of Object.entries(workflowBranches(current))) {
          const index = branch.findIndex((step) => step.id === event.stepId)
          if (index < 0) continue
          const nodes = insertedWorkflowSteps(branch[index], platform, label)
          const profileSwitch = nodes.map(workflowStepBehavior).find((behavior) => behavior?.type === 'switchProfile')
          if (profileSwitch?.type === 'switchProfile') {
            branch.splice(index, 1)
            designer.clearSelectedStep()
            workflowApi!.editor.createStepEditorContext('axonkey-triggers').notifyChildrenChanged()
            onRequestProfileSwitchRef.current(button.id, trigger as TriggerType, profileSwitch)
            break
          }
          if (nodes.length === 1 && nodes[0].type === 'disabled' && nodes[0].properties.enabled !== false) {
            branch.splice(0, branch.length, ...nodes)
          } else branch.splice(index, 1, ...nodes)
          workflowApi!.editor.createStepEditorContext('axonkey-triggers').notifyChildrenChanged()
          // Dropping a block only inserts it. Users can open the editor from
          // the block itself when they want to change its parameters.
          // The designer coalesces nested change notifications. Save the
          // normalized definition here instead of waiting for another event.
          break
        }
      }
      const next = workflowToBehaviors(current)
      if (next) persist(next)
    })
    const resizeObserver = new ResizeObserver(() => {
      if (!ready || designer.isDragging()) return
      designer.updateLayout()
      workflowApi?.editor.createStepEditorContext('axonkey-triggers').notifyChildrenChanged()
      designer.resetViewport()
    })
    resizeObserver.observe(canvasRef.current)
    // Change only the rendered lanes. Keep every branch, pending edits, lane
    // scroll position and the toolbox alive when switching the visible trigger.
    refreshLanesRef.current = () => {
      designer.clearSelectedStep()
      workflowApi?.editor.createStepEditorContext('axonkey-triggers').notifyChildrenChanged()
      designer.resetViewport()
    }

    return () => {
      active = false
      refreshLanesRef.current = null
      // Designer events are batched. Flush a last drop/move/delete before a fast
      // key/page switch, but never write the old canvas over an external undo.
      if (workflowApi && workflowSequenceSignature(incomingRef.current) === savedRef.current) {
        const current = workflowApi.editor.getDefinition()
        for (const branch of Object.values(workflowBranches(current))) {
          for (let index = branch.length - 1; index >= 0; index--) {
            if (!branch[index].properties.behaviorType) {
              const nodes = insertedWorkflowSteps(branch[index], platform, label)
              // A fast page change must not commit an unconfirmed shared action.
              branch.splice(index, 1, ...(nodes.some((node) => node.type === 'switchProfile') ? [] : nodes))
            }
          }
        }
        const next = workflowToBehaviors(current)
        if (next) persist(next)
      }
      setEditingStep(null)
      setSequenceDialog(null)
      setToolbox(null)
      resizeObserver.disconnect()
      selectionBinding?.()
      unbindTrash()
      designer.destroy()
    }
  }, [platform, button.id, reload])

  useEffect(() => { refreshLanesRef.current?.() }, [activeTrigger, button.triggerLabel])

  useEffect(() => {
    // An import, reset, or shared undo replaces the view. Our own save echo keeps
    // the current designer and its viewport intact.
    if (workflowSequenceSignature(sequences) !== savedRef.current) setReload((value) => value + 1)
  }, [sequences])

  const storeLibrary = (items: SavedSequence[]): string | null => {
    if (library.error) return library.error
    try {
      window.localStorage.setItem(savedSequencesStorageKey, JSON.stringify(items))
      setLibrary({ items, error: '' })
      return null
    } catch { return '保存失败，请重试。' }
  }
  const savedPalette: WorkflowToolboxPalette = {
    name: '已保存', groups: [{ name: '已保存', steps: library.items.map((item) => ({
      componentType: 'task', type: 'savedSequence', name: item.name,
      properties: { savedSequenceId: item.id, sequence: item.sequence },
    })) }],
  }

  const closeEditor = () => {
    // Closing the editor only dismisses it. A behavior is removed through the
    // explicit delete action, so an accidental click on the close icon cannot
    // discard the node from the workflow.
    setEditingStep(null)
  }

  return <section ref={workflowRef} className="workflow-axonkey" aria-label={`${inputLabel} · 行为流程图`}>
    <div ref={canvasRef} className="workflow-axonkey-canvas" tabIndex={-1} aria-label="行为流程图画布" />
    <button ref={trashRef} type="button" className="workflow-trash" aria-label="垃圾桶，拖入行为即可删除" tabIndex={-1}>
      <Trash2 size={21} strokeWidth={1.8} aria-hidden="true" />
      <span>拖入删除</span>
    </button>
    {toolbox && createPortal(<WorkflowToolbox api={toolbox.api} palettes={[...toolbox.palettes, savedPalette]} savedError={library.error} onRemoveSavedSequence={(id) => { const error = storeLibrary(library.items.filter((item) => item.id !== id)); if (error) setLaneStatus(error) }} iconUrls={toolbox.iconUrls} selectedCategory={toolboxCategory} onCategoryChange={onToolboxCategoryChange} />, toolbox.host)}
    {laneStatus && <div className="workflow-lane-status" role="status">{laneStatus}</div>}
    {sequenceDialog?.type === 'save' && createPortal(<WorkflowSequenceSaveDialog
      initialName={`${inputLabel} · ${button.triggerLabel ?? triggerLabels[sequenceDialog.trigger]}`}
      onClose={() => setSequenceDialog(null)}
      onSave={(name) => {
        const saved = createSavedSequence(name, sequenceDialog.behaviors)
        const error = storeLibrary([...library.items, saved])
        if (error) return error
        setSequenceDialog(null)
        onToolboxCategoryChange('已保存/已保存')
        setLaneStatus('已保存到行为库')
        return null
      }}
    />, document.body)}
    {sequenceDialog?.type === 'paste' && toolbox && createPortal(<SequencePasteDialog
      platform={platform} button={button} trigger={sequenceDialog.trigger}
      onClose={() => setSequenceDialog(null)}
      onApply={(sequence) => {
        if (toolbox.api.editor.isReadonly()) return
        const profileSwitch = sequence.find((behavior) => behavior.type === 'switchProfile')
        if (profileSwitch?.type === 'switchProfile') {
          onRequestProfileSwitchRef.current(button.id, sequenceDialog.trigger, profileSwitch)
          setSequenceDialog(null)
          return
        }
        const branch = workflowBranches(toolbox.api.editor.getDefinition())[sequenceDialog.trigger]
        branch.splice(0, branch.length, ...sequence.map((behavior) => behaviorToWorkflowStep(behavior, (item) => behaviorSummary(item, platform))))
        toolbox.api.editor.createStepEditorContext('axonkey-triggers').notifyChildrenChanged()
        setSequenceDialog(null)
        setLaneStatus('当前泳道序列已替换，可撤销')
      }}
    />, document.body)}
    {editingStep && createPortal(<WorkflowStepDialog key={editingStep.stepId} edit={editingStep} platform={platform} button={button} onClose={closeEditor} />, document.body)}
  </section>
}
