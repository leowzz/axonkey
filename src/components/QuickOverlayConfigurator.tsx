import { useEffect, useMemo, useRef, useState } from 'react'
import type { CSSProperties, PointerEvent } from 'react'
import { createPortal } from 'react-dom'
import { ArrowLeft, ChevronRight, Copy, Eye, MoreHorizontal, Pencil, Plus, Trash2 } from 'lucide-react'
import type { StepDefinition } from 'sequential-workflow-designer'
import { behaviorTypeLabels } from '../appConfig'
import { appStorage } from '../appStorage'
import type { MappingInput, Platform } from '../appTypes'
import { createBehavior, normalizeBehavior } from '../behaviorModel'
import type { Behavior, InputId, TriggerBehaviors } from '../behaviorModel'
import { behaviorSummary } from '../behaviorSummary'
import { recordLibraryAdditions } from '../cloud/libraryUsage'
import { mouseInputId, mouseInputParts, mouseScopes } from '../devices'
import type { MouseScopeId } from '../devices'
import { parseSavedSequences, savedSequencesStorageKey } from '../savedSequences'
import { BehaviorHistoryActions } from './BehaviorHistoryActions'
import { QuickOverlayPresentation } from './QuickOverlay'
import { QuickOverlaySurface, conciseSlotShort, renderKeyGlyph, slotKindClass } from './QuickOverlaySurface'
import {
  insertQuickOverlaySteps,
  moveQuickOverlayStep,
  quickOverlayAllowsToolboxStep,
  quickOverlayClickBehaviors,
  quickOverlayToolboxInsertion,
} from './quickOverlayConfiguration'
import { buildQuickOverlayView } from './quickOverlayModel'
import type { QuickOverlayKeySlot } from './quickOverlayModel'
import { SelectControl } from './SelectControl'
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

export function QuickOverlayConfigurator<Id extends string>({
  deviceKind,
  deviceName,
  profileId,
  profileName,
  triggerInput,
  inputs,
  behaviors,
  platform,
  onChange,
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
  triggerInput?: string
  inputs: readonly MappingInput<Id>[]
  behaviors: Record<string, TriggerBehaviors>
  platform: Platform
  onChange: (inputId: Id, sequences: TriggerBehaviors) => void | false
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
  const [selectedId, setSelectedId] = useState<Id>()
  const [name, setName] = useState(profileName)
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
      behaviors: clickBehaviors,
    }),
    [clickBehaviors, deviceKind, deviceName, profileId, profileName, triggerInput],
  )
  const view = useMemo(
    () =>
      buildQuickOverlayView(
        {
          ...session,
          behaviors: isMouse
            ? Object.fromEntries(
                scopeInputs
                  .filter(input => clickBehaviors[input.id])
                  .map(input => [input.id, clickBehaviors[input.id]]),
              )
            : clickBehaviors,
        },
        platform,
        { includeUnconfiguredAxes: true },
      ),
    [clickBehaviors, isMouse, platform, scopeInputs, session],
  )
  const editableInputs = scopeInputs.filter(input => input.id !== view.triggerInputId)
  const selected = editableInputs.find(input => input.id === selectedId) ?? editableInputs[0]
  const sequence = selected ? (behaviors[selected.id]?.click ?? emptySequence.click) : emptySequence.click
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

  const addAction = (action: StepDefinition, input: MappingInput<Id>, index: number) => {
    const { additions, libraryItems, needsEdit } = quickOverlayToolboxInsertion(action, platform, crypto.randomUUID())
    if (!additions.length) return
    setSelectedId(input.id)
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
    const steps = input && !isTrigger ? behaviors[input.id]?.click : undefined
    const first = steps?.[0]
    const summary = first ? behaviorSummary(first, platform) : undefined
    const count = steps?.length ?? 0
    const isDrop = dropTarget && 'inputId' in dropTarget && dropTarget.inputId === id
    const short = conciseSlotShort(slot)
    const label = isTrigger ? `${slot.label}：触发键，再按退出，不可配置` : (summary ?? slot.label)
    return (
      <button
        key={slot.slotId}
        type="button"
        className={`ceramic-key quick-overlay-editor-key ${isTrigger ? 'is-trigger' : first ? 'is-configured' + slotKindClass(slot.primaryKind) : 'is-idle'} ${isDrop ? 'is-drop-target' : ''} ${extra}`}
        style={style}
        aria-pressed={selected?.id === id}
        aria-label={isTrigger ? label : count ? `${slot.label}，${count} 步，${summary}` : slot.label}
        disabled={!input || isTrigger}
        data-quick-overlay-input={isTrigger ? undefined : input?.id}
        onClick={() => input && !isTrigger && setSelectedId(input.id)}
        title={label}
      >
        <span className="ceramic-key-top">
          <span className="ceramic-key-code">
            {renderKeyGlyph(slot)}
            <span>{short}</span>
          </span>
          {isTrigger ? (
            <span className="ceramic-key-tag is-exit">触发键</span>
          ) : count > 0 ? (
            <span className="ceramic-key-tag">{count}</span>
          ) : null}
        </span>
        {isTrigger && <span className="ceramic-key-exit-text">再按退出</span>}
        {summary && <strong className="ceramic-key-label">{summary}</strong>}
      </button>
    )
  }

  const dropIndex = dropTarget && 'index' in dropTarget ? dropTarget.index : undefined
  const menuBehavior = menu && sequence.find(behavior => behavior.id === menu.id)

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
    >
      <header className="quick-overlay-config-header">
        <button className="reset-button" type="button" onClick={onClose}>
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
        <span className="quick-overlay-config-device">{deviceName}</span>
        <div className="quick-overlay-config-actions">
          <BehaviorHistoryActions {...history} />
          <details className="quick-overlay-config-menu profile-manager profile-manager-compact">
            <summary aria-label="配置操作">
              <MoreHorizontal size={17} />
            </summary>
            <div className="profile-manager-popover profile-manager-actions">
              <button type="button" onClick={onDuplicate}>
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
          <button className="reset-button" type="button" onClick={() => setPreview(true)}>
            <Eye size={16} /> 实时模拟
          </button>
        </div>
      </header>
      <div className="quick-overlay-config-body">
        <div className="quick-overlay-config-workspace">
          <div className="quick-overlay-config-stage">
            {isMouse && (
              <SelectControl
                aria-label="鼠标触发位置"
                value={scope}
                onChange={event => setScope(event.target.value as MouseScopeId)}
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
          {selected && (
            <section className="quick-overlay-track" aria-label={`${selected.label}单击序列`}>
              <header>
                <h2>{selected.label}</h2>
                <span>单击 · {sequence.length} 步</span>
              </header>
              <div className="quick-overlay-track-scroll" key={selected.id}>
                <div className="quick-overlay-step-rail">
                  {sequence.map((behavior, index) => {
                    const node = behaviorToWorkflowStep(behavior, step => behaviorSummary(step, platform))
                    const summary = behaviorSummary(behavior, platform)
                    const type = behaviorTypeLabels[behavior.type]
                    return (
                      <div className="quick-overlay-step-segment" key={behavior.id}>
                        <span
                          className={`quick-overlay-step-gap${dropIndex === index ? ' is-drop-target' : ''}`}
                          data-quick-overlay-insert={index}
                          aria-hidden="true"
                        >
                          <ChevronRight size={14} />
                        </span>
                        <button
                          type="button"
                          className={`quick-overlay-step${behavior.enabled ? '' : ' is-disabled'}`}
                          data-quick-overlay-insert={index}
                          aria-label={`编辑第 ${index + 1} 步：${summary}`}
                          aria-keyshortcuts="Alt+ArrowLeft Alt+ArrowRight"
                          title={summary}
                          onPointerDown={event => beginDrag(event, { stepId: behavior.id })}
                          onClick={event => {
                            if (event.detail === 0) editStep(selected, behavior)
                          }}
                          onDoubleClick={() => editStep(selected, behavior)}
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
                            <strong>{type}</strong>
                            {summary !== type && <small>{summary}</small>}
                          </span>
                        </button>
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
                </div>
              </div>
            </section>
          )}
        </div>
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
