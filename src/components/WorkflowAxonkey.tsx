import { recordLibraryAdditions } from '../cloud/libraryUsage'
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import type { KeyboardEvent as ReactKeyboardEvent, ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { ArrowDown, ArrowUp, MoreHorizontal, Pencil, Plus, X } from 'lucide-react'
import type { Definition, Step, StepDefinition, ToolboxGroupConfiguration } from 'sequential-workflow-designer'
import {
  behaviorFromCapturedKey,
  behaviorSummary,
  behaviorTypeLabels,
  formatCapturedKey,
  keyDisplayName,
  rightModifierChoices,
  triggerLabels,
} from '../appConfig'
import type { AdvancedBehaviorType, CommonBehaviorPreset, MappingInput, Platform } from '../appTypes'
import { createBehavior, defaultCursorDistance, normalizeBehavior, serializeSequence } from '../behaviorModel'
import type { Behavior, InputId, SwitchProfileBehavior, TriggerBehaviors, TriggerType } from '../behaviorModel'
import { writeClipboardText } from '../clipboard'
import { macosShortcutPresets } from '../macosShortcutPresets'
import { createSavedSequence, parseSavedSequences, savedSequencesStorageKey } from '../savedSequences'
import type { SavedSequence } from '../savedSequences'
import { SequencePasteDialog } from './BehaviorEditor'
import { WorkflowSequenceSaveDialog } from './WorkflowSequenceSaveDialog'
import { defaultWorkflowTriggers } from './WorkflowTriggerRoot'
import {
  behaviorToWorkflowStep,
  behaviorsToWorkflow,
  clearWorkflowLane,
  insertedWorkflowSteps,
  isWorkflowLaneDisabled,
  isWorkflowStepLocked,
  takeWorkflowLibraryAdditions,
  workflowBranches,
  workflowSequenceSignature,
  workflowToBehaviors,
} from './workflowBehaviorBridge'
import { createWorkflowActionIconUrls } from './workflowActionIcons'
import { WorkflowToolbox } from './WorkflowToolbox'
import type { WorkflowToolboxPalette } from './WorkflowToolbox'
import {
  defaultWorkflowDelayMs,
  findWorkflowStepEditor,
  isEditableWorkflowStep,
  workflowBehaviorProperties,
  workflowStepBehavior,
} from './workflowStepEditing'
import { WorkflowStepDialog } from './WorkflowStepDialog'
import type { WorkflowStepEdit } from './WorkflowStepDialog'
import { workflowActionChoiceStep } from './workflowActionChoices'
import type { WorkflowActionChoicePreset } from './workflowActionChoices'
import './WorkflowAxonkey.css'

type WorkflowAxonkeyProps<Id extends string> = {
  header?: ReactNode
  splitRatio?: number
  onSplitRatioChange?: (ratio: number) => void
  platform: Platform
  button: MappingInput<Id>
  sequences: TriggerBehaviors
  activeTrigger?: TriggerType
  onRequestProfileSwitch: (
    inputId: Id,
    trigger: TriggerType,
    behavior: SwitchProfileBehavior,
    additionItemId?: string,
  ) => void
  onChange: (inputId: Id, sequences: TriggerBehaviors) => void | false
  toolboxCategory: string
  onToolboxCategoryChange: (category: string) => void
}

type WorkflowAction = {
  preset:
    CommonBehaviorPreset | AdvancedBehaviorType | 'wheel' | 'cursorMove' | 'switchProfile' | WorkflowActionChoicePreset
  name: string
  description?: string
}

type VisualBehaviorItem = {
  step: Step
  startIndex: number
  span: number
  autoEnter: boolean
}

type WorkflowSession<Id extends string> = {
  inputId: Id
  platform: Platform
  propSignature: string
  savedSignature: string
  definition: Definition
  acceptedBranches: ReturnType<typeof workflowBranches>
}

type PopoverPosition = {
  top: number
  right: number
}

function getAutoEnterSpan(branch: Step[], index: number): 3 | 1 {
  const first = branch[index]
  const delayStep = branch[index + 1]
  const enterStep = branch[index + 2]
  if (!first || first.type !== 'paste' || !delayStep || !enterStep) return 1
  if (delayStep.type !== 'delay' || delayStep.properties.ms !== 30 || delayStep.properties.enabled === false) return 1
  if (enterStep.type !== 'customKey' || enterStep.properties.key !== 'Enter' || enterStep.properties.enabled === false)
    return 1
  const draftGroup = first.properties.draftGroup
  if (draftGroup && (delayStep.properties.draftGroup !== draftGroup || enterStep.properties.draftGroup !== draftGroup))
    return 1
  return 3
}

function buildVisualItems(branch: Step[]): VisualBehaviorItem[] {
  const items: VisualBehaviorItem[] = []
  for (let index = 0; index < branch.length;) {
    const span = getAutoEnterSpan(branch, index)
    items.push({
      step: branch[index],
      startIndex: index,
      span,
      autoEnter: span === 3,
    })
    index += span
  }
  return items
}

function formatKeyChordPill(behavior: Behavior, platform: Platform): { chord: string; presetLabel: string } {
  if (behavior.type === 'key') {
    return { chord: behavior.key ? keyDisplayName(behavior.key, platform) : '未录入', presetLabel: '' }
  }
  if (behavior.type === 'shortcut') {
    const chord = behavior.keys.map(key => keyDisplayName(key, platform)).join(' + ') || '未录入'
    const preset = macosShortcutPresets(platform).find(
      ({ keys }) => keys.length === behavior.keys.length && keys.every((key, idx) => key === behavior.keys[idx]),
    )
    return { chord, presetLabel: preset?.name ?? '' }
  }
  return { chord: '', presetLabel: '' }
}

function stepTagLabel(step: Step, behavior: Behavior): string {
  const choice = workflowActionChoiceStep(step.type)
  if (choice) return choice.title
  if (behavior.type === 'key' || behavior.type === 'shortcut') return '快捷键'
  if (behavior.type === 'delay') return '等待延时'
  if (behavior.type === 'paste') return '粘贴文本'
  if (behavior.type === 'typeText') return '输入文字'
  return behaviorTypeLabels?.[behavior.type] ?? behavior.type
}

export function WorkflowAxonkey<Id extends string = InputId>({
  header,
  platform,
  button,
  sequences,
  activeTrigger,
  onChange,
  onRequestProfileSwitch,
  toolboxCategory,
  onToolboxCategoryChange,
}: WorkflowAxonkeyProps<Id>) {
  const triggers = button.triggerLabel
    ? [{ id: 'click' as const, label: button.triggerLabel }]
    : activeTrigger
      ? defaultWorkflowTriggers.filter(trigger => trigger.id === activeTrigger)
      : defaultWorkflowTriggers

  const inputLabel = [button.label, button.contextLabel].filter(Boolean).join(' · ')
  const labelBehavior = (item: Behavior) => behaviorSummary(item, platform)

  const onChangeRef = useRef(onChange)
  onChangeRef.current = onChange
  const onRequestProfileSwitchRef = useRef(onRequestProfileSwitch)
  onRequestProfileSwitchRef.current = onRequestProfileSwitch

  const sessionRef = useRef<WorkflowSession<Id> | null>(null)
  const incomingSignature = workflowSequenceSignature(sequences)
  if (
    !sessionRef.current ||
    sessionRef.current.inputId !== button.id ||
    sessionRef.current.platform !== platform ||
    (incomingSignature !== sessionRef.current.propSignature && incomingSignature !== sessionRef.current.savedSignature)
  ) {
    const definition = behaviorsToWorkflow(sequences, labelBehavior)
    sessionRef.current = {
      inputId: button.id,
      platform,
      propSignature: incomingSignature,
      savedSignature: incomingSignature,
      definition,
      acceptedBranches: structuredClone(workflowBranches(definition)),
    }
  } else if (incomingSignature !== sessionRef.current.propSignature) {
    sessionRef.current.propSignature = incomingSignature
  }

  const [, setRenderTick] = useState(0)
  const refreshView = () => setRenderTick(value => value + 1)

  const [library, setLibrary] = useState<{ items: SavedSequence[]; error: string }>(() => {
    try {
      return { items: parseSavedSequences(window.localStorage.getItem(savedSequencesStorageKey)), error: '' }
    } catch {
      return { items: [], error: '无法读取已保存的序列，请重新打开页面重试。' }
    }
  })
  const [sequenceDialog, setSequenceDialog] = useState<
    { type: 'save'; trigger: TriggerType; behaviors: Behavior[] } | { type: 'paste'; trigger: TriggerType } | null
  >(null)
  const [laneStatus, setLaneStatus] = useState('')
  const [dialogStep, setDialogStep] = useState<WorkflowStepEdit | null>(null)
  const [capturingStepId, setCapturingStepId] = useState<string | null>(null)
  const [inlinePrompt, setInlinePrompt] = useState<{ stepId: string; text: string } | null>(null)
  const [delayDrafts, setDelayDrafts] = useState<Record<string, string>>({})
  const [pickerTrigger, setPickerTrigger] = useState<TriggerType | null>(null)
  const [pickerPosition, setPickerPosition] = useState<PopoverPosition>({ top: 112, right: 24 })
  const [seqMenuTrigger, setSeqMenuTrigger] = useState<TriggerType | null>(null)

  const scrollContainerRef = useRef<HTMLDivElement>(null)
  const pickerRef = useRef<HTMLDivElement>(null)
  const captureButtonRef = useRef<HTMLButtonElement | null>(null)

  const resolvedPickerTrigger = pickerTrigger
    ? (triggers.find(item => item.id === pickerTrigger)?.id ?? triggers[0]?.id ?? null)
    : null
  const activePickerLabel = resolvedPickerTrigger
    ? (triggers.find(item => item.id === resolvedPickerTrigger)?.label ?? triggerLabels[resolvedPickerTrigger])
    : (triggers[0]?.label ?? '单击')

  useEffect(() => {
    if (!laneStatus) return
    const timer = window.setTimeout(() => setLaneStatus(''), 3500)
    return () => window.clearTimeout(timer)
  }, [laneStatus])

  useEffect(() => {
    setDialogStep(null)
    setSequenceDialog(null)
    setCapturingStepId(null)
    setInlinePrompt(null)
    setDelayDrafts({})
    setSeqMenuTrigger(null)
  }, [button.id, platform])

  useLayoutEffect(() => {
    if (capturingStepId) captureButtonRef.current?.focus()
  }, [capturingStepId])

  useEffect(() => {
    if (!resolvedPickerTrigger && !seqMenuTrigger) return
    const onPointerDown = (event: MouseEvent) => {
      const target = event.target as HTMLElement | null
      if (!target) return
      if (target.closest('.behavior-dialog, dialog, .workflow-library-dialog, .workflow-share-login')) return
      if (seqMenuTrigger && !target.closest('.trigger-seq-menu-wrap')) {
        setSeqMenuTrigger(null)
      }
      if (
        resolvedPickerTrigger &&
        !pickerRef.current?.contains(target) &&
        !target.closest('[data-trigger-add], .trigger-empty-slot')
      ) {
        setPickerTrigger(null)
      }
    }
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return
      if (document.querySelector('dialog[open], .behavior-dialog-backdrop')) return
      if (seqMenuTrigger) {
        event.stopPropagation()
        setSeqMenuTrigger(null)
        return
      }
      if (resolvedPickerTrigger) {
        event.stopPropagation()
        setPickerTrigger(null)
      }
    }
    window.addEventListener('mousedown', onPointerDown)
    window.addEventListener('keydown', onKeyDown)
    return () => {
      window.removeEventListener('mousedown', onPointerDown)
      window.removeEventListener('keydown', onKeyDown)
    }
  }, [resolvedPickerTrigger, seqMenuTrigger])

  const iconUrls = useMemo(() => createWorkflowActionIconUrls(platform), [platform])

  const palettes = useMemo<WorkflowToolboxPalette[]>(() => {
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
      {
        preset: 'deleteAllText',
        name: '删除全部文本',
        description: `${keyDisplayName(platform === 'macos' ? 'Win' : 'Ctrl', platform)} + A，等待 30 毫秒后 ${keyDisplayName(platform === 'macos' ? 'Win' : 'Ctrl', platform)} + X`,
      },
    ]
    const controlActions: WorkflowAction[] = [
      { preset: 'switchProfile', name: '切换配置文件', description: '上一个或下一个配置文件，可设置到边缘自动循环' },
      {
        preset: 'disabled',
        name: '禁用此触发方式',
        description: '替换当前泳道的序列，不发送任何输入；清空泳道可取消禁用',
      },
      { preset: 'delay', name: '等待' },
      { preset: 'paste', name: '粘贴文本' },
      { preset: 'typeText', name: '模拟输入文字' },
      { preset: 'openPath', name: '打开文件或文件夹' },
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
    mediaActions.push({ preset: 'volumeControl', name: '音量控制', description: '选择增大音量、减小音量或静音' })
    const macosActions = [...macosShortcutPresets(platform)]
    const actionGroups = [
      { name: '控制', actions: controlActions },
      ...(macosActions.length ? [{ name: 'macOS', actions: macosActions }] : []),
      { name: '键盘', actions: keyboardActions },
      { name: '鼠标', actions: mouseActions },
      { name: '媒体控制', actions: mediaActions },
    ]
    const toGroup = (group: { name: string; actions: WorkflowAction[] }): ToolboxGroupConfiguration => ({
      name: group.name,
      steps: group.actions.map(({ preset, name, description }) => ({
        componentType: 'task',
        type: preset,
        name,
        properties: {
          preset,
          description: description ?? '',
          ...(preset === 'delay' ? { ms: defaultWorkflowDelayMs } : {}),
        },
      })),
    })
    return [
      { name: '基础', groups: actionGroups.map(toGroup) },
      { name: '常用行为', groups: [toGroup({ name: '常用行为', actions: commonActions })] },
      { name: '组合行为', groups: [toGroup({ name: '组合行为', actions: compositeActions })] },
    ]
  }, [platform])

  const persistCurrent = () => {
    const session = sessionRef.current
    if (!session) return
    const next = workflowToBehaviors(session.definition)
    if (!next) {
      refreshView()
      return
    }
    const signature = workflowSequenceSignature(next)
    const current = workflowBranches(session.definition)
    if (signature === session.savedSignature) {
      session.acceptedBranches = structuredClone(current)
      refreshView()
      return
    }
    const previousSignature = session.savedSignature
    session.savedSignature = signature
    // Shared-action deletion can wait for the app's confirmation dialog.
    // Restore branches immediately so cancel cannot save an unconfirmed removal.
    if (onChangeRef.current(session.inputId, next) === false) {
      session.savedSignature = previousSignature
      const restored = structuredClone(session.acceptedBranches)
      for (const trigger of Object.keys(current) as TriggerType[]) {
        current[trigger].splice(0, current[trigger].length, ...restored[trigger])
      }
      refreshView()
      return
    }
    recordLibraryAdditions(takeWorkflowLibraryAdditions(session.definition))
    session.acceptedBranches = structuredClone(current)
    refreshView()
  }

  const saveStepBehavior = (stepId: string, candidate: Behavior, fromModal = false): boolean => {
    const session = sessionRef.current
    if (!session) return false
    const current = findWorkflowStepEditor(session.definition, stepId)
    if (!current || isWorkflowLaneDisabled(workflowBranches(session.definition)[current.trigger])) return false
    const properties = workflowBehaviorProperties(current.step, candidate)
    if (!properties) return false
    const savedBehavior = normalizeBehavior({ ...candidate, id: stepId })
    if (!savedBehavior) return false
    if (savedBehavior.type === 'switchProfile') {
      setDialogStep(null)
      onRequestProfileSwitchRef.current(
        session.inputId,
        current.trigger,
        savedBehavior,
        current.step.properties.pendingLibraryAddition as string | undefined,
      )
      return true
    }
    const group = current.step.properties.draftGroup
    if (group) {
      for (const branch of Object.values(workflowBranches(session.definition))) {
        for (const node of branch) {
          if (node.properties.draftGroup === group) delete node.properties.draftGroup
        }
      }
    }
    const { libraryItemId, pendingLibraryAddition } = current.step.properties
    Object.assign(current.step, behaviorToWorkflowStep(savedBehavior, labelBehavior))
    if (libraryItemId) current.step.properties.libraryItemId = libraryItemId
    if (pendingLibraryAddition) current.step.properties.pendingLibraryAddition = pendingLibraryAddition
    if (fromModal) setDialogStep(null)
    persistCurrent()
    return true
  }

  const deleteStepById = (stepId: string) => {
    const session = sessionRef.current
    if (!session) return
    const current = findWorkflowStepEditor(session.definition, stepId)
    if (!current) return
    const branch = workflowBranches(session.definition)[current.trigger]
    if (isWorkflowStepLocked(current.step, branch)) return
    const index = branch.indexOf(current.step)
    if (index < 0) return
    const span = getAutoEnterSpan(branch, index)
    branch.splice(index, span)
    if (inlinePrompt?.stepId === stepId) setInlinePrompt(null)
    if (capturingStepId === stepId) setCapturingStepId(null)
    setDialogStep(null)
    persistCurrent()
  }

  const openModalEditor = (stepId: string) => {
    const session = sessionRef.current
    if (!session) return
    const editor = findWorkflowStepEditor(session.definition, stepId)
    if (!editor || isWorkflowLaneDisabled(workflowBranches(session.definition)[editor.trigger])) return
    setDialogStep({
      stepId,
      trigger: editor.trigger,
      behavior: editor.behavior,
      onDelete: () => deleteStepById(stepId),
      onSave: updated => {
        saveStepBehavior(stepId, updated, true)
      },
    })
  }

  const addStepToTrigger = (rawStep: StepDefinition, trigger: TriggerType) => {
    const session = sessionRef.current
    if (!session) return
    const branches = workflowBranches(session.definition)
    const branch = branches[trigger]
    if (isWorkflowLaneDisabled(branch)) {
      setLaneStatus('请先清空当前泳道，取消禁用后再添加行为')
      return
    }
    const stepCopy: Step = { ...structuredClone(rawStep), id: crypto.randomUUID() }
    const nodes = insertedWorkflowSteps(stepCopy, platform, labelBehavior)
    for (const node of nodes) {
      delete node.properties.libraryVersionId
      delete node.properties.author
    }
    const profileSwitch = nodes.map(workflowStepBehavior).find(behavior => behavior?.type === 'switchProfile')
    if (profileSwitch?.type === 'switchProfile') {
      setPickerTrigger(null)
      onRequestProfileSwitchRef.current(
        session.inputId,
        trigger,
        profileSwitch,
        nodes.find(node => node.properties.pendingLibraryAddition)?.properties.pendingLibraryAddition as
          string | undefined,
      )
      return
    }
    if (nodes.length === 1 && nodes[0].type === 'disabled' && nodes[0].properties.enabled !== false) {
      branch.splice(0, branch.length, ...nodes)
      setPickerTrigger(null)
      persistCurrent()
      return
    }
    branch.push(...nodes)
    setPickerTrigger(null)
    persistCurrent()

    const first = nodes[0]
    if (!first) return
    if (rawStep.type === 'customKey') {
      setCapturingStepId(first.id)
      return
    }
    if (rawStep.type === 'paste' || rawStep.type === 'typeText' || rawStep.type === 'textAndEnter') {
      const initialBehavior = workflowStepBehavior(first)
      const initialText =
        initialBehavior && (initialBehavior.type === 'paste' || initialBehavior.type === 'typeText')
          ? initialBehavior.text
          : ''
      setInlinePrompt({ stepId: first.id, text: initialText })
      return
    }
    const draftEditable = nodes.find(node => node.properties.draftGroup && isEditableWorkflowStep(node))
    if (draftEditable) {
      openModalEditor(draftEditable.id)
    }
  }

  const clearTrigger = (trigger: TriggerType) => {
    const session = sessionRef.current
    if (!session) return
    if (!clearWorkflowLane(session.definition, trigger)) return
    setSeqMenuTrigger(null)
    persistCurrent()
  }

  const moveVisualItem = (trigger: TriggerType, itemIndex: number, direction: -1 | 1) => {
    const session = sessionRef.current
    if (!session) return
    const branch = workflowBranches(session.definition)[trigger]
    if (isWorkflowLaneDisabled(branch)) return
    const items = buildVisualItems(branch)
    const targetIndex = itemIndex + direction
    if (targetIndex < 0 || targetIndex >= items.length) return
    const currentItem = items[itemIndex]
    const otherItem = items[targetIndex]
    if (currentItem.step.type === 'switchProfile' || otherItem.step.type === 'switchProfile') return
    const moved = branch.splice(currentItem.startIndex, currentItem.span)
    const insertAt = direction < 0 ? otherItem.startIndex : otherItem.startIndex - currentItem.span + otherItem.span
    branch.splice(insertAt, 0, ...moved)
    persistCurrent()
  }

  const toggleAutoEnter = (trigger: TriggerType, item: VisualBehaviorItem) => {
    const session = sessionRef.current
    if (!session) return
    const branch = workflowBranches(session.definition)[trigger]
    if (item.autoEnter) {
      branch.splice(item.startIndex + 1, 2)
    } else {
      const extraSteps = [
        behaviorToWorkflowStep(createBehavior({ type: 'delay', ms: 30 }), labelBehavior),
        behaviorToWorkflowStep(createBehavior({ type: 'key', key: 'Enter' }), labelBehavior),
      ]
      const draftGroup = item.step.properties.draftGroup
      if (draftGroup) {
        for (const extra of extraSteps) extra.properties.draftGroup = draftGroup
      }
      branch.splice(item.startIndex + 1, 0, ...extraSteps)
    }
    persistCurrent()
  }

  const runLaneAction = (trigger: TriggerType, action: 'copy' | 'paste' | 'save') => {
    const session = sessionRef.current
    if (!session) return
    setSeqMenuTrigger(null)
    if (action === 'paste') {
      setSequenceDialog({ type: 'paste', trigger })
      return
    }
    if (workflowBranches(session.definition)[trigger].some(step => step.properties.draftGroup)) {
      setLaneStatus('请先完成当前泳道中的行为配置')
      return
    }
    const sequence = workflowToBehaviors(session.definition)?.[trigger]
    if (!sequence?.length) return
    if (action === 'save') {
      setSequenceDialog({ type: 'save', trigger, behaviors: sequence })
      return
    }
    void writeClipboardText(serializeSequence(sequence))
      .then(() => {
        setLaneStatus(`${button.triggerLabel ?? triggerLabels[trigger]}序列已复制`)
      })
      .catch(() => {
        setLaneStatus('复制失败，请重试')
      })
  }

  const togglePicker = (trigger: TriggerType, anchor?: HTMLElement | null) => {
    const session = sessionRef.current
    if (session && isWorkflowLaneDisabled(workflowBranches(session.definition)[trigger])) {
      setLaneStatus('请先清空当前泳道，取消禁用后再添加行为')
      return
    }
    if (resolvedPickerTrigger === trigger) {
      setPickerTrigger(null)
      return
    }
    if (anchor && typeof anchor.getBoundingClientRect === 'function' && typeof window.innerWidth === 'number') {
      const rect = anchor.getBoundingClientRect()
      const popoverHeight = 420
      const viewportHeight = window.innerHeight || 760
      const viewportWidth = window.innerWidth || 1080
      const top = Math.max(58, Math.min(rect.bottom + 6, viewportHeight - popoverHeight - 12))
      const right = Math.max(16, viewportWidth - rect.right)
      setPickerPosition({ top, right })
    }
    setSeqMenuTrigger(null)
    setPickerTrigger(trigger)
  }

  const storeLibrary = (items: SavedSequence[]): string | null => {
    if (library.error) return library.error
    try {
      window.localStorage.setItem(savedSequencesStorageKey, JSON.stringify(items))
      setLibrary({ items, error: '' })
      return null
    } catch {
      return '保存失败，请重试。'
    }
  }

  const savedPalette: WorkflowToolboxPalette = {
    name: '已保存',
    groups: [
      {
        name: '已保存',
        steps: library.items.map(item => ({
          componentType: 'task',
          type: 'savedSequence',
          name: item.name,
          properties: {
            savedSequenceId: item.id,
            sequence: item.sequence,
            ...(item.libraryItemIds ? { libraryItemIds: item.libraryItemIds } : {}),
          },
        })),
      },
    ],
  }

  const getStepPreview = (step: StepDefinition) =>
    insertedWorkflowSteps({ ...step, id: 'preview' }, platform, labelBehavior).map(node => {
      const behavior = workflowStepBehavior(node)
      if (!behavior) return node.name
      const description =
        behavior.type === 'paste'
          ? `粘贴：${behavior.text || '（添加后填写文本）'}`
          : behavior.type === 'openApp'
            ? `打开应用：${behavior.path || '（添加后选择应用）'}`
            : behaviorSummary(behavior, platform)
      return `${description}${behavior.enabled ? '' : '（已停用）'}`
    })

  const branches = workflowBranches(sessionRef.current!.definition)

  const handleInlineKeyCapture = (step: Step, behavior: Behavior, event: ReactKeyboardEvent<HTMLButtonElement>) => {
    if (capturingStepId !== step.id) return
    event.preventDefault()
    event.stopPropagation()
    if (event.key === 'Escape' && !event.ctrlKey && !event.altKey && !event.metaKey && !event.shiftKey) {
      setCapturingStepId(null)
      return
    }
    const captured = formatCapturedKey(event)
    if (!captured) return
    saveStepBehavior(step.id, {
      ...behaviorFromCapturedKey(captured, step.id),
      enabled: behavior.enabled,
      ...(behavior.libraryItemId ? { libraryItemId: behavior.libraryItemId } : {}),
    })
    setCapturingStepId(null)
  }

  return (
    <section className="workflow-axonkey" aria-label={`${inputLabel} · 行为编排`}>
      {header}
      <div
        ref={scrollContainerRef}
        className="workflow-triggers-scroll workflow-axonkey-canvas"
        tabIndex={-1}
        aria-label="触发器行为编排"
      >
        <div className="trigger-stack">
          {triggers.map(trigger => {
            const branch = branches[trigger.id]
            const laneDisabled = isWorkflowLaneDisabled(branch)
            const visualItems = laneDisabled ? [] : buildVisualItems(branch)
            const hasCommittedSteps = branch.length > 0 && !branch.every(node => Boolean(node.properties.draftGroup))
            const isMenuOpen = seqMenuTrigger === trigger.id

            return (
              <article
                key={trigger.id}
                className={`trigger-card workflow-trigger-${trigger.id}${branch.length === 0 ? ' is-empty' : ''}${laneDisabled ? ' is-disabled' : ''}`}
                data-trigger={trigger.id}
                aria-label={`${trigger.label}触发器`}
              >
                <div className="trigger-row-main">
                  <div className="trigger-badge-col">
                    <span className="trigger-badge">{trigger.label}</span>
                  </div>

                  <div className="trigger-behavior-stack">
                    {branch.length === 0 ? (
                      <button
                        type="button"
                        className="trigger-empty-slot"
                        onClick={event => togglePicker(trigger.id, event.currentTarget)}
                      >
                        未配置（保留原始输入）
                      </button>
                    ) : laneDisabled ? (
                      <div className="step-item is-disabled-step">
                        <div className="step-line">
                          <div className="step-left">
                            <span className="step-disabled-text">已禁用此触发方式（不发送任何输入）</span>
                          </div>
                          <div className="step-actions is-visible">
                            <button
                              type="button"
                              className="tiny-icon-btn danger"
                              data-trigger-clear={trigger.id}
                              aria-label={`取消禁用${trigger.label}`}
                              title="取消禁用"
                              onClick={() => clearTrigger(trigger.id)}
                            >
                              <X size={14} aria-hidden="true" />
                            </button>
                          </div>
                        </div>
                      </div>
                    ) : (
                      visualItems.map((item, visualIndex) => {
                        const { step } = item
                        const behavior = workflowStepBehavior(step)
                        if (!behavior) return null
                        const isChoiceStep = Boolean(workflowActionChoiceStep(step.type))
                        const isInlineKey = !isChoiceStep && (behavior.type === 'key' || behavior.type === 'shortcut')
                        const isInlineText = behavior.type === 'paste' || behavior.type === 'typeText'
                        const isInlineDelay = behavior.type === 'delay'
                        const isCapturing = capturingStepId === step.id
                        const isPromptOpen = inlinePrompt?.stepId === step.id
                        const isDraft = Boolean(step.properties.draftGroup)
                        const showSequenceControls = visualItems.length > 1
                        const canReorder = showSequenceControls && step.type !== 'switchProfile'
                        const { chord, presetLabel } = isInlineKey
                          ? formatKeyChordPill(behavior, platform)
                          : { chord: '', presetLabel: '' }
                        const delayValue =
                          isInlineDelay && behavior.type === 'delay'
                            ? (delayDrafts[step.id] ?? String(behavior.ms))
                            : ''

                        return (
                          <div
                            key={step.id}
                            className={`step-item${isCapturing || isPromptOpen ? ' editing' : ''}${!behavior.enabled ? ' is-muted' : ''}`}
                          >
                            <div className="step-line">
                              <div className="step-left">
                                {showSequenceControls && <span className="step-index">{visualIndex + 1}</span>}
                                <span className="step-type-tag">{stepTagLabel(step, behavior)}</span>
                                {!behavior.enabled && <span className="step-muted-pill">已停用</span>}

                                {isInlineKey ? (
                                  <>
                                    <button
                                      ref={isCapturing ? captureButtonRef : undefined}
                                      type="button"
                                      data-step-id={step.id}
                                      className={`keycap-btn${isCapturing ? ' capturing' : ''}`}
                                      aria-label={isCapturing ? '正在录入按键，按 Esc 取消' : `修改快捷键 ${chord}`}
                                      onClick={event => {
                                        event.currentTarget.focus()
                                        setCapturingStepId(isCapturing ? null : step.id)
                                      }}
                                      onBlur={() => {
                                        if (isCapturing) setCapturingStepId(null)
                                      }}
                                      onKeyDown={event => handleInlineKeyCapture(step, behavior, event)}
                                    >
                                      {isCapturing ? '按下按键… (Esc 取消)' : chord}
                                    </button>
                                    {presetLabel && <span className="step-secondary-note">{presetLabel}</span>}
                                  </>
                                ) : isInlineText ? (
                                  <>
                                    <button
                                      type="button"
                                      data-step-id={step.id}
                                      className={`prompt-preview-btn${!behavior.text ? ' is-placeholder' : ''}`}
                                      onClick={() =>
                                        setInlinePrompt(isPromptOpen ? null : { stepId: step.id, text: behavior.text })
                                      }
                                    >
                                      {behavior.text ? `“${behavior.text}”` : '点击输入文本…'}
                                    </button>
                                    {behavior.type === 'paste' && (
                                      <button
                                        type="button"
                                        className={`inline-chip-toggle${item.autoEnter ? ' on' : ''}`}
                                        aria-pressed={item.autoEnter}
                                        onClick={() => toggleAutoEnter(trigger.id, item)}
                                      >
                                        ↵ 自动回车
                                      </button>
                                    )}
                                  </>
                                ) : isInlineDelay ? (
                                  <label className="delay-input-wrap">
                                    <input
                                      type="number"
                                      data-step-id={step.id}
                                      className="delay-input"
                                      aria-label="等待毫秒数"
                                      min={0}
                                      max={300000}
                                      step={10}
                                      value={delayValue}
                                      onChange={event => {
                                        const raw = event.target.value
                                        setDelayDrafts(prev => ({ ...prev, [step.id]: raw }))
                                        if (!raw.trim()) return
                                        const parsed = Math.round(Number(raw))
                                        if (Number.isFinite(parsed) && parsed >= 0 && parsed <= 300000) {
                                          saveStepBehavior(step.id, { ...behavior, ms: parsed })
                                        }
                                      }}
                                      onBlur={() => {
                                        setDelayDrafts(prev => {
                                          const next = { ...prev }
                                          delete next[step.id]
                                          return next
                                        })
                                      }}
                                    />
                                    <span>ms</span>
                                  </label>
                                ) : isEditableWorkflowStep(step) ? (
                                  <button
                                    type="button"
                                    data-step-id={step.id}
                                    className={`step-summary-btn${isDraft ? ' is-placeholder' : ''}`}
                                    onClick={() => openModalEditor(step.id)}
                                  >
                                    {isDraft &&
                                    ((behavior.type === 'openWebsite' && !behavior.url) ||
                                      ((behavior.type === 'openApp' || behavior.type === 'openPath') && !behavior.path))
                                      ? `点击设置${stepTagLabel(step, behavior)}…`
                                      : behaviorSummary(behavior, platform)}
                                  </button>
                                ) : (
                                  <span data-step-id={step.id} className="step-static-summary">
                                    {behaviorSummary(behavior, platform)}
                                  </span>
                                )}
                              </div>

                              <div className="step-actions">
                                {(isInlineKey || (!isInlineText && !isInlineDelay && isEditableWorkflowStep(step))) && (
                                  <button
                                    type="button"
                                    className="tiny-icon-btn"
                                    aria-label={`编辑${stepTagLabel(step, behavior)}参数`}
                                    title="更多参数"
                                    onClick={() => openModalEditor(step.id)}
                                  >
                                    <Pencil size={13} aria-hidden="true" />
                                  </button>
                                )}
                                {canReorder && (
                                  <>
                                    <button
                                      type="button"
                                      className="tiny-icon-btn"
                                      aria-label="上移步骤"
                                      title="上移"
                                      disabled={
                                        visualIndex === 0 || visualItems[visualIndex - 1]?.step.type === 'switchProfile'
                                      }
                                      onClick={() => moveVisualItem(trigger.id, visualIndex, -1)}
                                    >
                                      <ArrowUp size={13} aria-hidden="true" />
                                    </button>
                                    <button
                                      type="button"
                                      className="tiny-icon-btn"
                                      aria-label="下移步骤"
                                      title="下移"
                                      disabled={
                                        visualIndex === visualItems.length - 1 ||
                                        visualItems[visualIndex + 1]?.step.type === 'switchProfile'
                                      }
                                      onClick={() => moveVisualItem(trigger.id, visualIndex, 1)}
                                    >
                                      <ArrowDown size={13} aria-hidden="true" />
                                    </button>
                                  </>
                                )}
                                <button
                                  type="button"
                                  className="tiny-icon-btn danger"
                                  aria-label="删除行为"
                                  title="删除"
                                  onClick={() => deleteStepById(step.id)}
                                >
                                  <X size={14} aria-hidden="true" />
                                </button>
                              </div>
                            </div>

                            {isInlineText && isPromptOpen && (
                              <div className="inline-prompt-editor">
                                <textarea
                                  className="inline-prompt-textarea"
                                  aria-label={behavior.type === 'paste' ? '粘贴文本内容' : '模拟输入文字内容'}
                                  placeholder={
                                    behavior.type === 'paste' ? '输入要粘贴的文本或提示词…' : '输入要模拟键入的文字…'
                                  }
                                  value={inlinePrompt.text}
                                  autoFocus
                                  onChange={event => {
                                    const textValue = event.target.value
                                    setInlinePrompt({ stepId: step.id, text: textValue })
                                    if (textValue.trim()) {
                                      saveStepBehavior(step.id, { ...behavior, text: textValue })
                                    }
                                  }}
                                  onKeyDown={event => {
                                    if (event.key === 'Escape') {
                                      event.preventDefault()
                                      event.stopPropagation()
                                      setInlinePrompt(null)
                                    }
                                  }}
                                />
                                <div className="inline-editor-foot">
                                  <span>{inlinePrompt.text.trim() ? '更改自动保存' : '请输入非空内容后自动保存'}</span>
                                  <button
                                    type="button"
                                    className="inline-collapse-btn"
                                    onClick={() => setInlinePrompt(null)}
                                  >
                                    收起
                                  </button>
                                </div>
                              </div>
                            )}
                          </div>
                        )
                      })
                    )}
                  </div>

                  <div className="trigger-add-slot">
                    <div className="trigger-seq-menu-wrap" data-open={isMenuOpen ? 'true' : undefined}>
                      <button
                        type="button"
                        className="tiny-icon-btn trigger-seq-menu-btn"
                        aria-label={`${trigger.label}序列操作`}
                        aria-haspopup="menu"
                        aria-expanded={isMenuOpen}
                        title="序列操作"
                        onClick={() => setSeqMenuTrigger(current => (current === trigger.id ? null : trigger.id))}
                      >
                        <MoreHorizontal size={15} aria-hidden="true" />
                      </button>
                      {isMenuOpen && (
                        <div className="trigger-seq-dropdown" role="menu" aria-label={`${trigger.label}序列菜单`}>
                          <button
                            type="button"
                            role="menuitem"
                            disabled={!hasCommittedSteps || laneDisabled}
                            onClick={() => runLaneAction(trigger.id, 'copy')}
                          >
                            复制序列
                          </button>
                          <button type="button" role="menuitem" onClick={() => runLaneAction(trigger.id, 'paste')}>
                            粘贴序列
                          </button>
                          <button
                            type="button"
                            role="menuitem"
                            disabled={!hasCommittedSteps || laneDisabled}
                            onClick={() => runLaneAction(trigger.id, 'save')}
                          >
                            保存到行为库
                          </button>
                          <button
                            type="button"
                            role="menuitem"
                            className="danger"
                            data-trigger-clear={trigger.id}
                            disabled={branch.length === 0}
                            onClick={() => clearTrigger(trigger.id)}
                          >
                            清空此触发
                          </button>
                        </div>
                      )}
                    </div>

                    <button
                      type="button"
                      className={`add-step-btn${resolvedPickerTrigger === trigger.id ? ' active' : ''}`}
                      data-trigger-add={trigger.id}
                      aria-expanded={resolvedPickerTrigger === trigger.id}
                      aria-disabled={laneDisabled || undefined}
                      onClick={event => togglePicker(trigger.id, event.currentTarget)}
                    >
                      <Plus size={14} aria-hidden="true" />
                      添加
                    </button>
                  </div>
                </div>
              </article>
            )
          })}
        </div>

        {button.icon === 'mic' && (
          <div className="workflow-canvas-footer has-voice-guidance">
            <div className="workflow-voice-guidance">
              <p>要按住说话，请将语音快捷键配在「单击」，「双击」「长按」留空。</p>
              <p>这样按下即保持、松开即释放；「长按」表示按住一段时间后触发行为。</p>
            </div>
          </div>
        )}
      </div>

      {resolvedPickerTrigger &&
        createPortal(
          <aside
            ref={pickerRef}
            className="workflow-picker-popover sqd-toolbox workflow-toolbox"
            style={{ top: `${pickerPosition.top}px`, right: `${pickerPosition.right}px` }}
            aria-label="行为工具箱"
          >
            <div className="workflow-picker-topbar">
              <span className="workflow-picker-target">添加到 · {activePickerLabel}</span>
              <button
                type="button"
                className="tiny-icon-btn"
                aria-label="关闭动作面板"
                onClick={() => setPickerTrigger(null)}
              >
                <X size={15} aria-hidden="true" />
              </button>
            </div>
            <WorkflowToolbox
              api={null}
              platform={platform}
              palettes={[...palettes, savedPalette]}
              savedError={library.error}
              onRemoveSavedSequence={id => {
                const error = storeLibrary(library.items.filter(item => item.id !== id))
                if (error) setLaneStatus(error)
              }}
              iconUrls={iconUrls}
              addLabel={`添加到${activePickerLabel}`}
              onAddStep={step => addStepToTrigger(step, resolvedPickerTrigger)}
              getStepPreview={getStepPreview}
              selectedCategory={toolboxCategory}
              onCategoryChange={onToolboxCategoryChange}
            />
          </aside>,
          document.body,
        )}

      {dialogStep &&
        createPortal(
          <WorkflowStepDialog
            key={dialogStep.stepId}
            edit={dialogStep}
            platform={platform}
            button={button}
            onClose={() => setDialogStep(null)}
          />,
          document.body,
        )}

      {laneStatus && (
        <div className="workflow-lane-status" role="status">
          {laneStatus}
        </div>
      )}

      {sequenceDialog?.type === 'save' &&
        createPortal(
          <WorkflowSequenceSaveDialog
            initialName={`${inputLabel} · ${button.triggerLabel ?? triggerLabels[sequenceDialog.trigger]}`}
            onClose={() => setSequenceDialog(null)}
            onSave={name => {
              const saved = createSavedSequence(name, sequenceDialog.behaviors)
              const error = storeLibrary([...library.items, saved])
              if (error) return error
              setSequenceDialog(null)
              onToolboxCategoryChange('已保存/已保存')
              setLaneStatus('已保存到行为库')
              return null
            }}
          />,
          document.body,
        )}

      {sequenceDialog?.type === 'paste' &&
        createPortal(
          <SequencePasteDialog
            platform={platform}
            button={button}
            trigger={sequenceDialog.trigger}
            onClose={() => setSequenceDialog(null)}
            onApply={sequence => {
              const session = sessionRef.current
              if (!session) return
              const profileSwitch = sequence.find(behavior => behavior.type === 'switchProfile')
              if (profileSwitch?.type === 'switchProfile') {
                onRequestProfileSwitchRef.current(session.inputId, sequenceDialog.trigger, profileSwitch)
                setSequenceDialog(null)
                return
              }
              const branch = workflowBranches(session.definition)[sequenceDialog.trigger]
              branch.splice(
                0,
                branch.length,
                ...sequence.map(behavior => behaviorToWorkflowStep(behavior, labelBehavior)),
              )
              setSequenceDialog(null)
              setLaneStatus(`${button.triggerLabel ?? triggerLabels[sequenceDialog.trigger]}序列已更新`)
              persistCurrent()
            }}
          />,
          document.body,
        )}
    </section>
  )
}
