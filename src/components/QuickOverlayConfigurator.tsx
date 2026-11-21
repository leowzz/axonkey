import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react'
import type { CSSProperties, PointerEvent } from 'react'
import { createPortal } from 'react-dom'
import { ArrowLeft, ChevronRight, Copy, Eye, MoreHorizontal, Pencil, Plus, Trash2, X } from 'lucide-react'
import type { StepDefinition } from 'sequential-workflow-designer'
import { behaviorTypeLabels } from '../appConfig'
import { appStorage } from '../appStorage'
import type { MappingInput, Platform } from '../appTypes'
import { createBehavior, normalizeBehavior } from '../behaviorModel'
import type { Behavior, InputId, TriggerBehaviors, TriggerType } from '../behaviorModel'
import { behaviorSummary } from '../behaviorSummary'
import { recordLibraryAdditions } from '../cloud/libraryUsage'
import { mouseInputId, mouseInputParts, mouseScopes } from '../devices'
import type { MouseScopeId } from '../devices'
import { parseSavedSequences, savedSequencesStorageKey } from '../savedSequences'
import { BehaviorHistoryActions } from './BehaviorHistoryActions'
import { QuickOverlayPresentation } from './QuickOverlay'
import { QuickOverlaySurface, conciseSlotShort, renderKeyGlyph, slotKindClass } from './QuickOverlaySurface'
import {
  buildQuickPromptSequence,
  extractQuickPrompt,
  insertQuickOverlaySteps,
  moveQuickOverlayStep,
  quickOverlayAllowsToolboxStep,
  quickOverlayClickBehaviors,
  quickOverlayToolboxInsertion,
  type QuickPromptDraft,
} from './quickOverlayConfiguration'
import { buildQuickOverlayView, summarizeQuickTrigger } from './quickOverlayModel'
import type { QuickOverlayKeySlot } from './quickOverlayModel'
import { SelectControl } from './SelectControl'
import { SettingsHelp } from './SettingsHelp'
import { behaviorToWorkflowStep } from './workflowBehaviorBridge'
import { createWorkflowActionIconUrls } from './workflowActionIcons'
import { WorkflowStepDialog } from './WorkflowStepDialog'
import type { WorkflowStepEdit } from './WorkflowStepDialog'
import { WorkflowToolbox, type WorkflowToolboxPalette } from './WorkflowToolbox'
import { workflowToolboxPalettes } from './workflowToolboxPalettes'
import './QuickOverlayConfigurator.css'

type DragSource = { action: StepDefinition } | { stepId: string }
type DropTarget = { inputId: string } | { index: number }
type Drag = { source: DragSource; pointerId: number; x: number; y: number; active: boolean }

const emptySequence: TriggerBehaviors = { click: [], doubleClick: [], longPress: [] }
const emptyPromptDraft = (method: 'paste' | 'typeText' = 'paste'): QuickPromptDraft => ({
  title: '',
  content: '',
  method,
  autoEnter: false,
})

export function QuickOverlayConfigurator<Id extends string>({
  deviceKind,
  deviceName,
  profileId,
  profileName,
  promptMode,
  triggerInput,
  triggerType = 'click',
  triggerBindingWarning,
  inputs,
  behaviors,
  platform,
  onChange,
  onBindTrigger,
  onTogglePromptMode,
  onRename,
  onDuplicate,
  onDelete,
  onClose,
  history,
}: {
  deviceKind: string
  deviceName: string
  profileId: string
  profileName: string
  promptMode?: boolean
  triggerInput?: string
  triggerType?: TriggerType
  triggerBindingWarning?: string
  inputs: readonly MappingInput<Id>[]
  behaviors: Record<string, TriggerBehaviors>
  platform: Platform
  onChange: (inputId: Id, sequences: TriggerBehaviors) => void | false
  onBindTrigger?: (inputId: Id | '', trigger: TriggerType) => void
  onTogglePromptMode?: (enabled: boolean) => void
  onRename: (name: string) => void
  onDuplicate: () => void
  onDelete: () => void
  onClose: () => void
  history: Parameters<typeof BehaviorHistoryActions>[0]
}) {
  const isMouse = deviceKind === 'mouse'
  const [scope, setScope] = useState<MouseScopeId>('top')
  const scopeInputs = useMemo(
    () => (isMouse ? inputs.filter(input => mouseInputParts(input.id as InputId).scope.id === scope) : inputs),
    [inputs, isMouse, scope],
  )
  const triggerSelectInputs = useMemo(() => {
    if (!triggerInput || scopeInputs.some(item => item.id === triggerInput)) return scopeInputs
    const matched = inputs.find(item => item.id === triggerInput)
    return matched ? [matched, ...scopeInputs] : scopeInputs
  }, [inputs, scopeInputs, triggerInput])
  const [selectedId, setSelectedId] = useState<Id>()
  const [name, setName] = useState(profileName)
  const [localPromptMode, setLocalPromptMode] = useState(Boolean(promptMode))
  useEffect(() => {
    if (promptMode !== undefined) setLocalPromptMode(promptMode)
  }, [promptMode])
  const isPromptMode = promptMode ?? localPromptMode
  const [category, setCategory] = useState('all')
  const [edit, setEdit] = useState<{ input: MappingInput<Id>; step: WorkflowStepEdit } | null>(null)
  const [menu, setMenu] = useState<{ id: string; x: number; y: number; anchor: HTMLButtonElement } | null>(null)
  const [preview, setPreview] = useState(false)
  const previewRef = useRef<HTMLDialogElement>(null)
  const menuRef = useRef<HTMLDivElement>(null)
  const toolboxRef = useRef<HTMLElement>(null)
  const dragRef = useRef<Drag | null>(null)
  const suppressClick = useRef(false)
  const [dragging, setDragging] = useState(false)
  const [dropTarget, setDropTarget] = useState<DropTarget | null>(null)
  const fieldId = useId()
  const iconUrls = useMemo(() => createWorkflowActionIconUrls(platform), [platform])
  const [saved] = useState(() => {
    try {
      return { items: parseSavedSequences(appStorage.getItem(savedSequencesStorageKey)), error: '' }
    } catch {
      return { items: [], error: '无法读取已保存的序列，请重新打开页面重试。' }
    }
  })
  const palettes = useMemo<WorkflowToolboxPalette[]>(
    () => [
      ...workflowToolboxPalettes(platform, true),
      {
        name: '已保存',
        groups: [
          {
            name: '已保存',
            steps: saved.items.map(item => ({
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
      },
    ],
    [platform, saved.items],
  )
  const clickBehaviors = useMemo(() => quickOverlayClickBehaviors(behaviors), [behaviors])
  const editableInputs = useMemo(() => {
    const baseView = buildQuickOverlayView(
      {
        revision: 0,
        sourceId: '',
        deviceKind,
        deviceName,
        profileId,
        profileName,
        triggerInput: triggerInput ?? '',
        pressed: [],
        preview: true,
        promptMode: isPromptMode,
        behaviors: clickBehaviors,
      },
      platform,
      { includeUnconfiguredAxes: true },
    )
    return scopeInputs.filter(input => input.id !== baseView.triggerInputId)
  }, [
    clickBehaviors,
    deviceKind,
    deviceName,
    isPromptMode,
    platform,
    profileId,
    profileName,
    scopeInputs,
    triggerInput,
  ])
  const selected = editableInputs.find(input => input.id === selectedId) ?? editableInputs[0]
  const sequence = selected ? (behaviors[selected.id]?.click ?? emptySequence.click) : emptySequence.click
  const promptInspection = useMemo(() => extractQuickPrompt(sequence, platform), [platform, sequence])

  const [promptDraft, setPromptDraft] = useState<QuickPromptDraft>(() =>
    promptInspection.kind === 'prompt' ? promptInspection.prompt : emptyPromptDraft(),
  )
  const [promptDirty, setPromptDirty] = useState(false)
  const dirtyPromptRef = useRef<{
    input: MappingInput<Id>
    draft: QuickPromptDraft
    baseSequence: Behavior[]
    blockedNonPrompt: boolean
  } | null>(null)
  const promptTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const syncedInputRef = useRef<string>(selected?.id ?? '')
  const wasPromptModeRef = useRef<boolean>(isPromptMode)
  const lastCommittedRef = useRef<{ inputId: string; sig: string }>({
    inputId: selected?.id ?? '',
    sig: JSON.stringify(sequence),
  })

  const clearPromptTimer = useCallback(() => {
    if (promptTimerRef.current !== null && typeof clearTimeout === 'function') {
      clearTimeout(promptTimerRef.current)
      promptTimerRef.current = null
    }
  }, [])

  useEffect(() => clearPromptTimer, [clearPromptTimer])

  const commitPromptSequence = useCallback(
    (input: MappingInput<Id>, draft: QuickPromptDraft, baseSequence: Behavior[]) => {
      const nextClick = buildQuickPromptSequence(draft, baseSequence)
      lastCommittedRef.current = { inputId: input.id, sig: JSON.stringify(nextClick) }
      dirtyPromptRef.current = null
      setPromptDirty(false)
      onChange(input.id, { ...(behaviors[input.id] ?? emptySequence), click: nextClick })
    },
    [behaviors, onChange],
  )

  const flushPendingPrompt = useCallback(() => {
    clearPromptTimer()
    const pending = dirtyPromptRef.current
    if (!pending) return
    if (pending.blockedNonPrompt && !pending.draft.title.trim() && !pending.draft.content) {
      dirtyPromptRef.current = null
      setPromptDirty(false)
      return
    }
    commitPromptSequence(pending.input, pending.draft, pending.baseSequence)
  }, [clearPromptTimer, commitPromptSequence])

  useEffect(() => {
    const currentId = selected?.id ?? ''
    const currentSig = JSON.stringify(sequence)
    const keyChanged = syncedInputRef.current !== currentId
    const modeEntered = !wasPromptModeRef.current && isPromptMode
    wasPromptModeRef.current = isPromptMode
    const externalChange = lastCommittedRef.current.inputId !== currentId || lastCommittedRef.current.sig !== currentSig
    if (keyChanged || modeEntered || (externalChange && !dirtyPromptRef.current)) {
      syncedInputRef.current = currentId
      lastCommittedRef.current = { inputId: currentId, sig: currentSig }
      dirtyPromptRef.current = null
      setPromptDirty(false)
      setPromptDraft(promptInspection.kind === 'prompt' ? promptInspection.prompt : emptyPromptDraft())
    }
  }, [isPromptMode, promptInspection, selected?.id, sequence])

  const effectiveClickBehaviors = useMemo(() => {
    if (!isPromptMode || !selected || !promptDirty) return clickBehaviors
    if (promptInspection.kind === 'other' && !promptDraft.title.trim() && !promptDraft.content) return clickBehaviors
    const nextClick = buildQuickPromptSequence(promptDraft, sequence)
    if (nextClick.length === 0) {
      const next = { ...clickBehaviors }
      delete next[selected.id]
      return next
    }
    return {
      ...clickBehaviors,
      [selected.id]: { click: nextClick, doubleClick: [], longPress: [] },
    }
  }, [clickBehaviors, isPromptMode, promptDirty, promptDraft, promptInspection.kind, selected, sequence])

  const session = useMemo(
    () => ({
      revision: 0,
      sourceId: '',
      deviceKind,
      deviceName,
      profileId,
      profileName,
      triggerInput: triggerInput ?? '',
      pressed: [],
      preview: true,
      promptMode: isPromptMode,
      behaviors: effectiveClickBehaviors,
    }),
    [deviceKind, deviceName, effectiveClickBehaviors, isPromptMode, profileId, profileName, triggerInput],
  )
  const view = useMemo(
    () =>
      buildQuickOverlayView(
        {
          ...session,
          behaviors: isMouse
            ? Object.fromEntries(
                scopeInputs
                  .filter(input => effectiveClickBehaviors[input.id])
                  .map(input => [input.id, effectiveClickBehaviors[input.id]]),
              )
            : effectiveClickBehaviors,
        },
        platform,
        { includeUnconfiguredAxes: true },
      ),
    [effectiveClickBehaviors, isMouse, platform, scopeInputs, session],
  )
  const configuredCount = useMemo(
    () =>
      Object.entries(effectiveClickBehaviors).filter(
        ([id, seq]) => id !== view.triggerInputId && seq.click.some(step => step.enabled),
      ).length,
    [effectiveClickBehaviors, view.triggerInputId],
  )
  const previewView = preview ? buildQuickOverlayView(session, platform) : null

  useEffect(() => setName(profileName), [profileName])
  useEffect(() => {
    if (preview) previewRef.current?.showModal()
  }, [preview])
  useEffect(() => {
    if (!menu) return
    menuRef.current?.querySelector('button')?.focus()
    const close = (event: globalThis.PointerEvent) => {
      if (!menuRef.current?.contains(event.target as Node)) setMenu(null)
    }
    document.addEventListener('pointerdown', close)
    return () => document.removeEventListener('pointerdown', close)
  }, [menu])

  const saveName = () => {
    const next = name.trim()
    if (next && next !== profileName) onRename(next)
    else setName(profileName)
  }
  const writeClick = (input: MappingInput<Id>, click: Behavior[]) =>
    onChange(input.id, { ...(behaviors[input.id] ?? emptySequence), click })

  const updatePromptDraft = (next: QuickPromptDraft, immediate = false) => {
    if (!selected) return
    setPromptDraft(next)
    const blockedNonPrompt = promptInspection.kind === 'other'
    if (blockedNonPrompt && !next.title.trim() && !next.content) {
      clearPromptTimer()
      dirtyPromptRef.current = null
      setPromptDirty(false)
      return
    }
    clearPromptTimer()
    if (immediate || typeof setTimeout !== 'function') {
      commitPromptSequence(selected, next, sequence)
      return
    }
    dirtyPromptRef.current = { input: selected, draft: next, baseSequence: sequence, blockedNonPrompt }
    setPromptDirty(true)
    promptTimerRef.current = setTimeout(() => {
      const pending = dirtyPromptRef.current
      if (!pending) return
      commitPromptSequence(pending.input, pending.draft, pending.baseSequence)
    }, 350)
  }

  const clearPromptSlot = () => {
    if (!selected) return
    clearPromptTimer()
    dirtyPromptRef.current = null
    setPromptDirty(false)
    setPromptDraft(emptyPromptDraft(promptDraft.method))
    lastCommittedRef.current = { inputId: selected.id, sig: '[]' }
    writeClick(selected, [])
  }

  const selectKeyInput = (nextId: Id) => {
    if (selected?.id !== nextId) flushPendingPrompt()
    setSelectedId(nextId)
  }

  const handleTogglePromptMode = () => {
    flushPendingPrompt()
    const next = !isPromptMode
    if (promptMode === undefined) setLocalPromptMode(next)
    onTogglePromptMode?.(next)
  }

  const addAction = (action: StepDefinition, input: MappingInput<Id>, index: number) => {
    const { additions, libraryItems, needsEdit } = quickOverlayToolboxInsertion(action, platform, crypto.randomUUID())
    if (!additions.length) return
    selectKeyInput(input.id)
    const commit = (steps: Behavior[]) => {
      const current = behaviors[input.id]?.click ?? emptySequence.click
      if (writeClick(input, insertQuickOverlaySteps(current, index, steps)) !== false) {
        recordLibraryAdditions(libraryItems)
        setEdit(null)
      }
    }
    if (!needsEdit) {
      commit(additions)
      return
    }
    const [behavior, ...following] = additions
    setEdit({
      input,
      step: {
        stepId: behavior.id,
        trigger: 'click',
        behavior,
        onSave: draft => {
          const normalized = normalizeBehavior({ ...draft, libraryItemId: behavior.libraryItemId })
          if (normalized) commit([normalized, ...following])
        },
      },
    })
  }

  const editStep = (input: MappingInput<Id>, behavior: Behavior) => {
    setEdit({
      input,
      step: {
        stepId: behavior.id,
        trigger: 'click',
        behavior,
        onSave: draft => {
          const normalized = normalizeBehavior({ ...draft, libraryItemId: behavior.libraryItemId })
          if (!normalized) return
          if (
            writeClick(
              input,
              sequence.map(step => (step.id === behavior.id ? normalized : step)),
            ) !== false
          ) {
            setEdit(null)
          }
        },
      },
    })
  }

  const beginDrag = (event: PointerEvent<HTMLButtonElement>, source: DragSource) => {
    if (event.button !== 0 || !event.isPrimary) return
    event.currentTarget.setPointerCapture(event.pointerId)
    dragRef.current = { source, pointerId: event.pointerId, x: event.clientX, y: event.clientY, active: false }
  }
  const targetAt = (event: PointerEvent, source: DragSource): DropTarget | null => {
    const hit = document.elementFromPoint(event.clientX, event.clientY)
    const key = hit?.closest<HTMLElement>('[data-quick-overlay-input]')
    if ('action' in source && key?.dataset.quickOverlayInput) return { inputId: key.dataset.quickOverlayInput }
    const position = hit?.closest<HTMLElement>('[data-quick-overlay-insert]')
    if (!position?.dataset.quickOverlayInsert) return null
    let index = Number(position.dataset.quickOverlayInsert)
    if (position.matches('.quick-overlay-step')) {
      const bounds = position.getBoundingClientRect()
      if (event.clientX > bounds.left + bounds.width / 2) index++
    }
    return { index }
  }
  const moveDrag = (event: PointerEvent) => {
    const drag = dragRef.current
    if (!drag || drag.pointerId !== event.pointerId) return
    if (!drag.active) {
      if (Math.hypot(event.clientX - drag.x, event.clientY - drag.y) < 5) return
      drag.active = true
      setDragging(true)
    }
    setDropTarget(targetAt(event, drag.source))
  }
  const finishDrag = (event: PointerEvent) => {
    const drag = dragRef.current
    if (!drag || event.pointerId !== drag.pointerId) return
    dragRef.current = null
    setDragging(false)
    setDropTarget(null)
    if (!drag.active) return
    suppressClick.current = true
    if (event.type === 'pointercancel') return
    const target = targetAt(event, drag.source)
    if (!target) return
    if ('action' in drag.source) {
      const input = 'inputId' in target ? scopeInputs.find(input => input.id === target.inputId) : selected
      if (input)
        addAction(
          drag.source.action,
          input,
          'index' in target ? target.index : (behaviors[input.id]?.click.length ?? 0),
        )
    } else if (selected && 'index' in target) {
      const next = moveQuickOverlayStep(sequence, drag.source.stepId, target.index)
      if (next !== sequence) writeClick(selected, next)
    }
  }

  const renderKey = (slot: QuickOverlayKeySlot, extra = '', style?: CSSProperties) => {
    const control = isMouse ? mouseInputParts(slot.inputId as InputId).control.id : undefined
    const id = control ? mouseInputId(scope, control) : slot.inputId
    const input = scopeInputs.find(item => item.id === id)
    const isTrigger = id === view.triggerInputId
    const steps = input && !isTrigger ? effectiveClickBehaviors[input.id]?.click : undefined
    const stepPreview = steps?.length ? summarizeQuickTrigger('click', steps, platform) : null
    const count = steps?.length ?? 0
    const isDrop = dropTarget && 'inputId' in dropTarget && dropTarget.inputId === id
    const short = conciseSlotShort(slot)
    const summaryText = stepPreview?.title ? `${stepPreview.title}：${stepPreview.text}` : stepPreview?.text
    const label = isTrigger ? `${slot.label}：触发键，再按退出，不可配置` : (summaryText ?? slot.label)
    const topTag = isTrigger ? (
      <span className="ceramic-key-tag is-exit">触发键</span>
    ) : isPromptMode && stepPreview?.kind === 'prompt' ? (
      stepPreview.autoEnter ? (
        <span className="ceramic-key-tag kind-prompt">↵ 发送</span>
      ) : stepPreview.inputMethod === 'typeText' ? (
        <span className="ceramic-key-tag kind-prompt">输入</span>
      ) : null
    ) : count > 0 ? (
      <span className="ceramic-key-tag">{count}</span>
    ) : null

    return (
      <button
        key={slot.slotId}
        type="button"
        className={`ceramic-key quick-overlay-editor-key ${isTrigger ? 'is-trigger' : stepPreview ? 'is-configured' + slotKindClass(stepPreview.kind) : 'is-idle'} ${isDrop ? 'is-drop-target' : ''} ${extra}`}
        style={style}
        aria-pressed={selected?.id === id}
        aria-label={isTrigger ? label : count ? `${slot.label}，${count} 步，${summaryText}` : slot.label}
        disabled={!input || isTrigger}
        data-quick-overlay-input={isTrigger ? undefined : input?.id}
        onClick={() => input && !isTrigger && selectKeyInput(input.id)}
        title={label}
      >
        <span className="ceramic-key-top">
          <span className="ceramic-key-code">
            {renderKeyGlyph(slot)}
            <span>{short}</span>
          </span>
          {topTag}
        </span>
        {isTrigger && <span className="ceramic-key-exit-text">再按退出</span>}
        {stepPreview?.title ? (
          <span className="ceramic-key-single">
            <strong className="ceramic-key-label is-titled">{stepPreview.title}</strong>
            {stepPreview.text && stepPreview.text !== '（空文本）' && (
              <span className="ceramic-key-excerpt">{stepPreview.text}</span>
            )}
          </span>
        ) : (
          stepPreview?.text && <strong className="ceramic-key-label">{stepPreview.text}</strong>
        )}
      </button>
    )
  }

  const dropIndex = dropTarget && 'index' in dropTarget ? dropTarget.index : undefined
  const menuBehavior = menu && sequence.find(behavior => behavior.id === menu.id)
  const selectedMeta = selected && isMouse ? mouseInputParts(selected.id as InputId) : null

  return (
    <section
      className={`quick-overlay-configurator${dragging ? ' is-dragging' : ''}`}
      aria-label="快捷交互窗配置"
      onPointerDownCapture={() => {
        suppressClick.current = false
      }}
      onPointerMove={moveDrag}
      onPointerUp={finishDrag}
      onPointerCancel={finishDrag}
      onClickCapture={event => {
        if (!suppressClick.current || event.detail === 0) return
        event.preventDefault()
        event.stopPropagation()
      }}
      onKeyDown={event => {
        if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 's') {
          event.preventDefault()
          flushPendingPrompt()
        }
      }}
    >
      <header className="quick-overlay-config-header">
        <button
          className="reset-button"
          type="button"
          onClick={() => {
            flushPendingPrompt()
            onClose()
          }}
        >
          <ArrowLeft size={16} /> 返回
        </button>
        <input
          className="behavior-launch-input quick-overlay-config-name"
          aria-label="快捷交互窗名称"
          value={name}
          maxLength={40}
          onChange={event => setName(event.target.value)}
          onBlur={saveName}
          onKeyDown={event => {
            if (event.key === 'Enter' && !event.nativeEvent.isComposing) event.currentTarget.blur()
          }}
        />
        <span className="quick-overlay-config-device">
          {deviceName} · 已配 {configuredCount} 键
        </span>
        <div className="quick-overlay-prompt-toggle">
          <span id={`${fieldId}-prompt-mode-label`}>纯 Prompt</span>
          <button
            type="button"
            role="switch"
            className={`switch${isPromptMode ? ' on' : ''}`}
            aria-labelledby={`${fieldId}-prompt-mode-label`}
            aria-checked={isPromptMode}
            onClick={handleTogglePromptMode}
          >
            <span />
          </button>
          <SettingsHelp id={`${fieldId}-prompt-mode-help`} label="纯 Prompt 模式">
            开启后每个按键直接配置 Prompt
            标题与内容，浮层中突出展示标题并可悬停查看全文；关闭后恢复自由编排行为序列，已有文本内容会保留。
          </SettingsHelp>
        </div>
        <div className="quick-overlay-config-actions">
          <BehaviorHistoryActions {...history} />
          <details className="quick-overlay-config-menu profile-manager profile-manager-compact">
            <summary aria-label="配置操作">
              <MoreHorizontal size={17} />
            </summary>
            <div className="profile-manager-popover profile-manager-actions">
              <button
                type="button"
                onClick={() => {
                  flushPendingPrompt()
                  onDuplicate()
                }}
              >
                <Copy size={15} /> 复制配置
              </button>
              <button
                type="button"
                className="profile-delete-button"
                onClick={event => {
                  event.currentTarget.closest('details')!.open = false
                  onDelete()
                }}
              >
                <Trash2 size={15} /> 删除配置
              </button>
            </div>
          </details>
          <button
            className="reset-button"
            type="button"
            onClick={() => {
              flushPendingPrompt()
              setPreview(true)
            }}
          >
            <Eye size={16} /> 实时模拟
          </button>
        </div>
      </header>
      {onBindTrigger && (
        <div className="quick-overlay-trigger-bar">
          <label className="quick-overlay-trigger-field">
            <span>唤起按键</span>
            <SelectControl
              aria-label="快捷交互窗唤起按键"
              value={triggerInput ?? ''}
              onChange={event => onBindTrigger(event.target.value as Id | '', triggerType)}
            >
              <option value="">暂未绑定</option>
              {triggerSelectInputs.map(item => (
                <option key={item.id} value={item.id}>
                  {item.label}
                </option>
              ))}
            </SelectControl>
          </label>
          <label className="quick-overlay-trigger-field">
            <span>唤起方式</span>
            <SelectControl
              aria-label="快捷交互窗唤起方式"
              disabled={!triggerInput}
              value={triggerType}
              onChange={event => {
                if (triggerInput) onBindTrigger(triggerInput as Id, event.target.value as TriggerType)
              }}
            >
              <option value="click">单击</option>
              <option value="doubleClick">双击</option>
              <option value="longPress">长按</option>
            </SelectControl>
          </label>
          {triggerBindingWarning && (
            <span className="quick-overlay-trigger-note" role="status">
              {triggerBindingWarning}
            </span>
          )}
        </div>
      )}
      <div className={`quick-overlay-config-body${isPromptMode ? ' is-prompt-mode' : ''}`}>
        <div className="quick-overlay-config-workspace">
          <div className="quick-overlay-config-stage">
            {isMouse && (
              <SelectControl
                aria-label="鼠标触发位置"
                value={scope}
                onChange={event => {
                  flushPendingPrompt()
                  setScope(event.target.value as MouseScopeId)
                }}
              >
                {mouseScopes.map(option => (
                  <option key={option.id} value={option.id}>
                    {option.label}
                  </option>
                ))}
              </SelectControl>
            )}
            <QuickOverlaySurface view={view} renderKeySlot={renderKey} />
          </div>
          {!isPromptMode && selected && (
            <section className="quick-overlay-track" aria-label={`${selected.label}单击序列`}>
              <header>
                <h2>{selected.label}</h2>
                <span>单击 · {sequence.length} 步</span>
                {sequence.length > 0 && (
                  <button type="button" className="quick-overlay-track-clear" onClick={() => writeClick(selected, [])}>
                    清空
                  </button>
                )}
              </header>
              <div className="quick-overlay-track-scroll" key={selected.id}>
                <div className="quick-overlay-step-rail">
                  {sequence.map((behavior, index) => {
                    const node = behaviorToWorkflowStep(behavior, step => behaviorSummary(step, platform))
                    const summary = behaviorSummary(behavior, platform)
                    const type = behaviorTypeLabels[behavior.type]
                    const promptBehavior =
                      (behavior.type === 'paste' || behavior.type === 'typeText') && behavior.title ? behavior : null
                    const stepTitle = promptBehavior?.title ?? type
                    const stepDetail = promptBehavior
                      ? promptBehavior.text || type
                      : summary !== type
                        ? summary
                        : undefined
                    return (
                      <div className="quick-overlay-step-segment" key={behavior.id}>
                        <span
                          className={`quick-overlay-step-gap${dropIndex === index ? ' is-drop-target' : ''}`}
                          data-quick-overlay-insert={index}
                          aria-hidden="true"
                        >
                          <ChevronRight size={14} />
                        </span>
                        <div className="quick-overlay-step-card">
                          <button
                            type="button"
                            className={`quick-overlay-step${behavior.enabled ? '' : ' is-disabled'}`}
                            data-quick-overlay-insert={index}
                            aria-label={`编辑第 ${index + 1} 步：${summary}`}
                            aria-keyshortcuts="Alt+ArrowLeft Alt+ArrowRight"
                            title={summary}
                            onPointerDown={event => beginDrag(event, { stepId: behavior.id })}
                            onClick={() => {
                              if (!suppressClick.current) editStep(selected, behavior)
                            }}
                            onContextMenu={event => {
                              event.preventDefault()
                              const anchor = event.currentTarget
                              const rect = anchor.getBoundingClientRect()
                              setMenu({
                                id: behavior.id,
                                x: Math.min(event.clientX || rect.left, window.innerWidth - 140),
                                y: Math.min(event.clientY || rect.bottom, window.innerHeight - 112),
                                anchor,
                              })
                            }}
                            onKeyDown={event => {
                              if (!event.altKey || (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight')) return
                              const target = event.key === 'ArrowLeft' ? index - 1 : index + 2
                              if (target < 0 || target > sequence.length) return
                              event.preventDefault()
                              writeClick(selected, moveQuickOverlayStep(sequence, behavior.id, target))
                            }}
                          >
                            {iconUrls[node.type] && <img alt="" src={iconUrls[node.type]} draggable={false} />}
                            <span>
                              <strong>{stepTitle}</strong>
                              {stepDetail && <small>{stepDetail}</small>}
                            </span>
                          </button>
                          <button
                            type="button"
                            className="quick-overlay-step-remove"
                            aria-label={`删除第 ${index + 1} 步`}
                            title="删除步骤"
                            onClick={() =>
                              writeClick(
                                selected,
                                sequence.filter(step => step.id !== behavior.id),
                              )
                            }
                          >
                            <X size={12} aria-hidden="true" />
                          </button>
                        </div>
                      </div>
                    )
                  })}
                  <span
                    className={`quick-overlay-step-gap${dropIndex === sequence.length ? ' is-drop-target' : ''}`}
                    data-quick-overlay-insert={sequence.length}
                    aria-hidden="true"
                  >
                    {sequence.length ? <ChevronRight size={14} /> : null}
                  </span>
                  <button
                    type="button"
                    className="quick-overlay-step-add"
                    data-quick-overlay-insert={sequence.length}
                    onClick={() => toolboxRef.current?.querySelector<HTMLInputElement>('input[type="search"]')?.focus()}
                  >
                    <Plus size={16} /> 添加行为
                  </button>
                  {sequence.length === 0 && (
                    <div className="quick-overlay-quick-chips" role="group" aria-label="常用快速添加">
                      {(
                        [
                          ['key', '按键'],
                          ['shortcut', '快捷键'],
                          ['paste', '粘贴文本'],
                        ] as const
                      ).map(([type, label]) => (
                        <button
                          key={type}
                          type="button"
                          className="quick-overlay-quick-chip"
                          onClick={() =>
                            addAction(
                              {
                                componentType: 'task',
                                type,
                                name: label,
                                properties: {},
                              },
                              selected,
                              0,
                            )
                          }
                        >
                          <Plus size={12} aria-hidden="true" /> {label}
                        </button>
                      ))}
                    </div>
                  )}
                </div>
              </div>
            </section>
          )}
        </div>
        {isPromptMode ? (
          <aside className="quick-overlay-prompt-editor" aria-label="Prompt 编辑器">
            {!selected ? (
              <div className="quick-overlay-prompt-empty">
                <p>没有可配置的按键</p>
                <span>当前所有按键均已被设为触发键或不可编辑</span>
              </div>
            ) : (
              <>
                <header className="quick-overlay-prompt-head">
                  <div className="quick-overlay-prompt-key">
                    {selectedMeta && selectedMeta.scope.id !== 'global' && (
                      <span className="quick-overlay-prompt-scope">{selectedMeta.scope.label}</span>
                    )}
                    <strong>{selectedMeta ? selectedMeta.control.label : selected.label}</strong>
                  </div>
                  <button
                    type="button"
                    className="quick-overlay-track-clear"
                    disabled={sequence.length === 0 && !promptDirty && !promptDraft.title && !promptDraft.content}
                    onClick={clearPromptSlot}
                  >
                    清空
                  </button>
                </header>
                {promptInspection.kind === 'other' && !promptDirty && (
                  <div className="quick-overlay-prompt-notice" role="note">
                    <span>
                      当前按键已配置其他行为（{promptInspection.summary}），输入 Prompt 内容后将替换该按键行为
                    </span>
                  </div>
                )}
                <div className="quick-overlay-prompt-field">
                  <label htmlFor={`${fieldId}-prompt-title`}>标题</label>
                  <input
                    id={`${fieldId}-prompt-title`}
                    className="behavior-launch-input"
                    type="text"
                    maxLength={40}
                    value={promptDraft.title}
                    placeholder="显示在交互窗键帽上的短标题"
                    onChange={event => updatePromptDraft({ ...promptDraft, title: event.target.value })}
                    onBlur={flushPendingPrompt}
                  />
                </div>
                <div className="quick-overlay-prompt-field is-content">
                  <div className="quick-overlay-prompt-label-row">
                    <label htmlFor={`${fieldId}-prompt-content`}>Prompt 内容</label>
                    <span className="quick-overlay-prompt-count">{promptDraft.content.length} 字</span>
                  </div>
                  <textarea
                    id={`${fieldId}-prompt-content`}
                    className="behavior-paste-input quick-overlay-prompt-textarea"
                    value={promptDraft.content}
                    placeholder="输入按下该键后自动发送的完整内容…"
                    onChange={event => updatePromptDraft({ ...promptDraft, content: event.target.value })}
                    onBlur={flushPendingPrompt}
                  />
                </div>
                <div className="quick-overlay-prompt-options">
                  <div className="quick-overlay-prompt-method" role="group" aria-label="发送方式">
                    <button
                      type="button"
                      aria-pressed={promptDraft.method === 'paste'}
                      onClick={() => updatePromptDraft({ ...promptDraft, method: 'paste' }, true)}
                    >
                      粘贴
                    </button>
                    <button
                      type="button"
                      aria-pressed={promptDraft.method === 'typeText'}
                      onClick={() => updatePromptDraft({ ...promptDraft, method: 'typeText' }, true)}
                    >
                      模拟输入
                    </button>
                  </div>
                  <label className="quick-overlay-prompt-autoenter">
                    <input
                      type="checkbox"
                      checked={promptDraft.autoEnter}
                      onChange={event => updatePromptDraft({ ...promptDraft, autoEnter: event.target.checked }, true)}
                    />
                    <span>发送后自动回车</span>
                  </label>
                </div>
              </>
            )}
          </aside>
        ) : (
          <aside className="quick-overlay-config-toolbox workflow-axonkey" ref={toolboxRef}>
            <div className="sqd-toolbox workflow-toolbox">
              <WorkflowToolbox
                api={null}
                platform={platform}
                palettes={palettes}
                iconUrls={iconUrls}
                selectedCategory={category}
                onCategoryChange={setCategory}
                addLabel="追加到当前按键"
                allowStep={quickOverlayAllowsToolboxStep}
                savedError={saved.error}
                getStepPreview={step =>
                  quickOverlayToolboxInsertion(step, platform, 'preview').additions.map(behavior =>
                    behaviorSummary(behavior, platform),
                  )
                }
                onStepPointerDown={(event, action) => beginDrag(event, { action })}
                onAddStep={step => {
                  if (selected) addAction(step, selected, sequence.length)
                }}
              />
            </div>
          </aside>
        )}
      </div>

      {menu &&
        selected &&
        menuBehavior &&
        createPortal(
          <div
            ref={menuRef}
            className="quick-overlay-step-menu"
            role="group"
            aria-label="步骤操作"
            style={{ left: menu.x, top: menu.y }}
            onKeyDown={event => {
              if (event.key === 'Escape') {
                setMenu(null)
                menu.anchor.focus()
              }
            }}
            onBlur={event => {
              if (!event.currentTarget.contains(event.relatedTarget)) setMenu(null)
            }}
          >
            <button
              type="button"
              onClick={() => {
                setMenu(null)
                menu.anchor.focus()
                editStep(selected, menuBehavior)
              }}
            >
              <Pencil size={14} /> 编辑
            </button>
            <button
              type="button"
              disabled={menuBehavior.type === 'disabled' && menuBehavior.enabled}
              onClick={() => {
                const copy = createBehavior({ ...menuBehavior, id: undefined })
                writeClick(selected, insertQuickOverlaySteps(sequence, sequence.indexOf(menuBehavior) + 1, [copy]))
                setMenu(null)
                menu.anchor.focus()
              }}
            >
              <Copy size={14} /> 复制
            </button>
            <button
              type="button"
              onClick={() => {
                writeClick(
                  selected,
                  sequence.filter(step => step.id !== menuBehavior.id),
                )
                setMenu(null)
              }}
            >
              <Trash2 size={14} /> 删除
            </button>
          </div>,
          document.body,
        )}
      {edit &&
        createPortal(
          <WorkflowStepDialog
            key={edit.step.stepId}
            edit={edit.step}
            platform={platform}
            button={edit.input}
            onClose={() => setEdit(null)}
          />,
          document.body,
        )}
      {previewView &&
        createPortal(
          <dialog
            ref={previewRef}
            className="quick-overlay-config-preview"
            aria-label="快捷交互窗实时模拟"
            onCancel={() => setPreview(false)}
          >
            <QuickOverlayPresentation view={previewView} preview onDismiss={() => setPreview(false)} />
          </dialog>,
          document.body,
        )}
    </section>
  )
}
