import {
  ArrowDown,
  ArrowUp,
  Ban,
  Check,
  ChevronDown,
  ChevronRight,
  ClipboardPaste,
  Clock3,
  Keyboard,
  Pencil,
  Play,
  RotateCcw,
  Trash2,
  Volume1,
  Volume2,
  VolumeX,
  X,
} from 'lucide-react'
import type { Behavior, ButtonId, TriggerType } from '../behaviorModel'
import {
  behaviorSummary,
  behaviorTypeLabels,
  isStandaloneModifierKey,
  keyDisplayName,
  keyGroupsForPlatform,
  shortcutModifiers,
  triggerLabels,
} from '../appConfig'
import type { AdvancedBehaviorType, CommonBehaviorPreset, Platform, RemoteButton } from '../appTypes'
import type { KeyboardEvent, ReactNode, RefObject } from 'react'
import { useState } from 'react'

type BehaviorEditorProps = {
  editorRef: RefObject<HTMLElement>
  attention: boolean
  platform: Platform
  button: RemoteButton
  trigger: TriggerType
  behaviors: Behavior[]
  canUndoCommonBehavior: boolean
  onApplyCommonBehavior: (preset: CommonBehaviorPreset) => void
  onUndoCommonBehavior: () => void
  onAddAdvancedBehavior: (type: AdvancedBehaviorType) => void
  onRemoveBehavior: (behaviorId: string) => void
  onMoveBehavior: (behaviorId: string, direction: -1 | 1) => void
  onEditBehavior: (behaviorId: string) => void
  onReturnToMappings: () => void
}

type BehaviorActionButtonProps = {
  icon: ReactNode
  label: string
  detail?: string
  onClick: () => void
}

function BehaviorActionButton({ icon, label, detail, onClick }: BehaviorActionButtonProps) {
  return <button type="button" className="behavior-action-button" onClick={onClick}>
    <span className="behavior-action-icon">{icon}</span>
    <span className="behavior-action-copy"><strong>{label}</strong>{detail && <small>{detail}</small>}</span>
  </button>
}

export function BehaviorEditor({ editorRef, attention, platform, button, trigger, behaviors, canUndoCommonBehavior, onApplyCommonBehavior, onUndoCommonBehavior, onAddAdvancedBehavior, onRemoveBehavior, onMoveBehavior, onEditBehavior, onReturnToMappings }: BehaviorEditorProps) {
  const [activeTab, setActiveTab] = useState<BehaviorEditorTab>('common')
  const tabId = `behavior-${button.id}-${trigger}`
  return <section ref={editorRef} className={`behavior-editor ${attention ? 'attention' : ''}`} aria-label={`${button.label}${triggerLabels[trigger]}行为配置`}>
    <div className="behavior-editor-body">
      <section className="behavior-current-panel" aria-labelledby={`${tabId}-current-title`}>
        <div className="behavior-column-heading">
          <h3 id={`${tabId}-current-title`}>当前序列</h3>
        </div>
        <div className="behavior-list">
          {behaviors.length === 0 && <div className="behavior-empty">{trigger === 'click' ? '保留原按键' : '尚未设置'}</div>}
          {behaviors.map((behavior, index) => <BehaviorItem
            platform={platform}
            key={behavior.id}
            behavior={behavior}
            index={index}
            total={behaviors.length}
            onRemove={onRemoveBehavior}
            onMove={onMoveBehavior}
            onEdit={onEditBehavior}
          />)}
        </div>
      </section>
      <section className="behavior-actions" aria-label="选择行为">
        <div className="behavior-column-heading">
          <h3>添加行为</h3>
          {canUndoCommonBehavior && <button type="button" className="behavior-undo-button" onClick={onUndoCommonBehavior}><RotateCcw size={12} /> 取消</button>}
        </div>
        <div className="behavior-editor-head">
          <div className="behavior-editor-head-actions">
            <div className="behavior-tabs" role="tablist" aria-label="行为分类">
              {([
                ['common', '常用'],
                ['navigation', '导航编辑'],
                ['media', '媒体控制'],
                ['advanced', '追加步骤'],
              ] as const).map(([id, label]) => <button
                key={id}
                id={`${tabId}-${id}-tab`}
                type="button"
                role="tab"
                aria-selected={activeTab === id}
                aria-controls={`${tabId}-${id}-panel`}
                className={activeTab === id ? 'active' : ''}
                onClick={() => setActiveTab(id)}
              >{label}</button>)}
            </div>
            <button type="button" className="icon-button behavior-return-button" title="返回选中按键" aria-label="返回选中按键" onClick={onReturnToMappings}><ArrowUp size={15} /></button>
          </div>
        </div>
        <div
          id={`${tabId}-${activeTab}-panel`}
          role="tabpanel"
          aria-labelledby={`${tabId}-${activeTab}-tab`}
          className="behavior-action-grid"
        >
          {activeTab === 'common' && <>
            <BehaviorActionButton icon={<RotateCcw size={17} />} label={trigger === 'click' ? '保留原按键' : '清除触发方式'} detail={trigger === 'click' ? '使用遥控器原始输入' : '移除当前触发行为'} onClick={() => onApplyCommonBehavior('original')} />
            <BehaviorActionButton icon={<Ban size={17} />} label="禁用按键" detail="不发送任何输入" onClick={() => onApplyCommonBehavior('disabled')} />
            <BehaviorActionButton icon={<kbd>Esc</kbd>} label="返回 / 关闭" onClick={() => onApplyCommonBehavior('escape')} />
            <BehaviorActionButton icon={<kbd>Enter</kbd>} label="确认 / 提交" onClick={() => onApplyCommonBehavior('enter')} />
            <BehaviorActionButton icon={<kbd>Space</kbd>} label="空格" onClick={() => onApplyCommonBehavior('space')} />
            <BehaviorActionButton icon={<ClipboardPaste size={17} />} label="输入文本并回车" detail="等待 30 毫秒后回车" onClick={() => onApplyCommonBehavior('textAndEnter')} />
            <BehaviorActionButton icon={<Keyboard size={17} />} label="其他按键 / 组合键" detail="直接录入目标按键" onClick={() => onApplyCommonBehavior('customKey')} />
          </>}
          {activeTab === 'navigation' && <>
            <BehaviorActionButton icon={<kbd>↑</kbd>} label="方向上" onClick={() => onApplyCommonBehavior('arrowUp')} />
            <BehaviorActionButton icon={<kbd>↓</kbd>} label="方向下" onClick={() => onApplyCommonBehavior('arrowDown')} />
            <BehaviorActionButton icon={<kbd>←</kbd>} label="方向左" onClick={() => onApplyCommonBehavior('arrowLeft')} />
            <BehaviorActionButton icon={<kbd>→</kbd>} label="方向右" onClick={() => onApplyCommonBehavior('arrowRight')} />
            <BehaviorActionButton icon={<kbd>Tab</kbd>} label="切换焦点" onClick={() => onApplyCommonBehavior('tab')} />
            <BehaviorActionButton icon={<kbd>Back</kbd>} label="向前删除" onClick={() => onApplyCommonBehavior('backspace')} />
            <BehaviorActionButton icon={<kbd>Del</kbd>} label="向后删除" onClick={() => onApplyCommonBehavior('delete')} />
            <BehaviorActionButton icon={<kbd>Home</kbd>} label="跳到开头" onClick={() => onApplyCommonBehavior('keyHome')} />
            <BehaviorActionButton icon={<kbd>End</kbd>} label="跳到结尾" onClick={() => onApplyCommonBehavior('keyEnd')} />
            <BehaviorActionButton icon={<kbd>PgUp</kbd>} label="向上翻页" onClick={() => onApplyCommonBehavior('pageUp')} />
            <BehaviorActionButton icon={<kbd>PgDn</kbd>} label="向下翻页" onClick={() => onApplyCommonBehavior('pageDown')} />
          </>}
          {activeTab === 'media' && <>
            <BehaviorActionButton icon={<Play size={17} />} label="播放 / 暂停" onClick={() => onApplyCommonBehavior('mediaPlayPause')} />
            <BehaviorActionButton icon={<Volume2 size={17} />} label="增大音量" onClick={() => onApplyCommonBehavior('volumeUp')} />
            <BehaviorActionButton icon={<Volume1 size={17} />} label="减小音量" onClick={() => onApplyCommonBehavior('volumeDown')} />
            <BehaviorActionButton icon={<VolumeX size={17} />} label="静音" onClick={() => onApplyCommonBehavior('volumeMute')} />
          </>}
          {activeTab === 'advanced' && <>
            <BehaviorActionButton icon={<Keyboard size={17} />} label="按键 / 组合键" onClick={() => onAddAdvancedBehavior('key')} />
            <BehaviorActionButton icon={<ClipboardPaste size={17} />} label="粘贴文本" onClick={() => onAddAdvancedBehavior('paste')} />
            <BehaviorActionButton icon={<Clock3 size={17} />} label="等待" onClick={() => onAddAdvancedBehavior('delay')} />
          </>}
        </div>
      </section>
    </div>
  </section>
}

type BehaviorEditorTab = 'common' | 'navigation' | 'media' | 'advanced'

type BehaviorItemProps = {
  platform: Platform
  behavior: Behavior
  index: number
  total: number
  onRemove: (behaviorId: string) => void
  onMove: (behaviorId: string, direction: -1 | 1) => void
  onEdit: (behaviorId: string) => void
}

function BehaviorItem({ platform, behavior, index, total, onRemove, onMove, onEdit }: BehaviorItemProps) {
  const editable = behavior.type !== 'disabled'
  return <div className="behavior-item">
    <span className="behavior-item-index">{String(index + 1).padStart(2, '0')}</span>
    <button type="button" className="behavior-item-summary" disabled={!editable} onClick={() => onEdit(behavior.id)}>
      <span className="behavior-type-label">{behaviorTypeLabels[behavior.type]}</span>
      <strong>{behaviorSummary(behavior, platform)}</strong>
    </button>
    <div className="behavior-item-actions">
      {editable && <button type="button" className="icon-button" title="编辑" aria-label="编辑行为" onClick={() => onEdit(behavior.id)}><Pencil size={14} /></button>}
      <button type="button" className="icon-button" title="上移" aria-label="上移行为" disabled={index === 0} onClick={() => onMove(behavior.id, -1)}><ArrowUp size={14} /></button>
      <button type="button" className="icon-button" title="下移" aria-label="下移行为" disabled={index === total - 1} onClick={() => onMove(behavior.id, 1)}><ArrowDown size={14} /></button>
      <button type="button" className="icon-button" title="删除" aria-label="删除行为" onClick={() => onRemove(behavior.id)}><Trash2 size={14} /></button>
    </div>
  </div>
}

type BehaviorEditDialogProps = {
  platform: Platform
  button: RemoteButton
  trigger: TriggerType
  behavior: Behavior
  capturing: boolean
  draft?: boolean
  onStartCapture: () => void
  onCancelCapture: () => void
  onCaptureKey: (behavior: Behavior, event: KeyboardEvent<HTMLElement>) => void
  onUpdate: (update: (behavior: Behavior) => Behavior) => void
  onClose: () => void
  onSave?: () => void
}

function ManualKeySelect({ platform, value, onChange, label, includeModifiers = true }: { platform: Platform; value: string; onChange: (value: string) => void; label: string; includeModifiers?: boolean }) {
  const platformGroups = keyGroupsForPlatform(platform)
  const groups = includeModifiers ? platformGroups : platformGroups.filter((group) => group.label !== '单独修饰键')
  const knownValue = groups.some((group) => group.options.some((option) => option.value === value)) ? value : ''
  return <div className="manual-key-select">
    <select value={knownValue} aria-label={label} onChange={(event) => onChange(event.target.value)}>
      <option value="" disabled>{value && !knownValue ? `当前：${value}` : '选择按键'}</option>
      {groups.map((group) => <optgroup key={group.label} label={group.label}>
        {group.options.map((option) => <option key={`${group.label}-${option.value}`} value={option.value}>{option.label}</option>)}
      </optgroup>)}
    </select>
    <span className="manual-key-select-icon" aria-hidden="true"><ChevronDown size={15} /></span>
  </div>
}

export function BehaviorEditDialog({ platform, button, trigger, behavior, capturing, draft = false, onStartCapture, onCancelCapture, onCaptureKey, onUpdate, onClose, onSave }: BehaviorEditDialogProps) {
  const captureValue = behavior.type === 'shortcut'
    ? behavior.keys.map((key) => keyDisplayName(key, platform)).join(' + ')
    : behavior.type === 'key' ? keyDisplayName(behavior.key, platform) : ''
  const shortcutKeys = behavior.type === 'shortcut' ? behavior.keys : []
  const selectedShortcutModifiers = shortcutModifiers.filter((modifier) => shortcutKeys.includes(modifier))
  const shortcutBase = behavior.type === 'key'
    ? behavior.key
    : shortcutKeys.find((key) => !shortcutModifiers.includes(key))
      ?? (shortcutKeys.length === 1 && isStandaloneModifierKey(shortcutKeys[0]) ? shortcutKeys[0] : 'C')
  const standaloneBase = isStandaloneModifierKey(shortcutBase)
  const setShortcut = (modifiers: string[], base: string) => {
    const selectedModifiers = isStandaloneModifierKey(base) ? [] : modifiers.filter((modifier) => modifier !== base)
    onUpdate((current) => current.type === 'key' || current.type === 'shortcut'
      ? selectedModifiers.length > 0
        ? { id: current.id, enabled: current.enabled, type: 'shortcut', keys: [...selectedModifiers, base] }
        : { id: current.id, enabled: current.enabled, type: 'key', key: base }
      : current)
  }
  const canSave = behavior.type === 'key'
    ? Boolean(behavior.key)
    : behavior.type === 'shortcut'
      ? behavior.keys.length > 0
      : behavior.type === 'paste'
        ? Boolean(behavior.text.trim())
        : true
  return <div className="behavior-dialog-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose() }}>
    <section
      className="behavior-dialog"
      role="dialog"
      aria-modal="true"
      aria-labelledby="behavior-dialog-title"
      onKeyDown={(event) => { if (capturing) onCaptureKey(behavior, event) }}
    >
      <header className="behavior-dialog-head">
        <div><span className="section-kicker">{button.label} · {triggerLabels[trigger]}</span><h2 id="behavior-dialog-title">{draft ? '添加' : '编辑'}{behaviorTypeLabels[behavior.type]}行为</h2></div>
        <button type="button" className="dialog-close" aria-label="关闭编辑" onClick={onClose}><X size={17} /></button>
      </header>
      <div className="behavior-dialog-body">
        {behavior.type === 'key' || behavior.type === 'shortcut' ? <>
          <div className="behavior-current-value"><span>当前按键</span><strong>{captureValue || '未设置'}</strong></div>
          <div className="behavior-record-row">
            <button type="button" autoFocus={draft && capturing} className={`record-key-button ${capturing ? 'capturing' : ''}`} onClick={capturing ? onCancelCapture : onStartCapture}>
              <Keyboard size={17} />
              <span><strong>{capturing ? '等待按键输入…' : '开始录入'}</strong><small>{capturing ? '现在按下目标按键或组合键' : '仅在点击后监听下一次按键'}</small></span>
            </button>
          </div>
          <div className="behavior-manual-section">
            <div className="behavior-field-title"><strong>手动选择</strong><span>{standaloneBase ? '当前仅发送这个按键' : '录入不到时直接从列表设置'}</span></div>
            <div className={`shortcut-manual-builder ${standaloneBase ? 'standalone' : ''}`}>
              <div className="shortcut-modifiers">
                {shortcutModifiers.map((modifier) => {
                  const selected = selectedShortcutModifiers.includes(modifier)
                  return <button key={modifier} type="button" disabled={standaloneBase} className={selected ? 'selected' : ''} aria-pressed={selected} onClick={() => {
                    onCancelCapture()
                    const modifiers = shortcutModifiers.filter((item) => item === modifier ? !selected : selectedShortcutModifiers.includes(item))
                    setShortcut(modifiers, shortcutBase)
                  }}>{keyDisplayName(modifier, platform)}</button>
                })}
              </div>
              <span className="shortcut-plus">+</span>
              <ManualKeySelect
                platform={platform}
                value={shortcutBase}
                label="选择主按键或单独修饰键"
                onChange={(base) => { onCancelCapture(); setShortcut(isStandaloneModifierKey(base) ? [] : selectedShortcutModifiers, base) }}
              />
            </div>
          </div>
        </> : behavior.type === 'paste' ? <div className="behavior-dialog-field"><label htmlFor="behavior-paste-text">粘贴内容</label><textarea
          id="behavior-paste-text"
          className="behavior-paste-input"
          autoFocus={draft}
          value={behavior.text}
          placeholder="输入要粘贴的文本"
          onChange={(event) => onUpdate((current) => current.type === 'paste' ? { ...current, text: event.target.value } : current)}
        /></div> : behavior.type === 'delay' ? <div className="behavior-dialog-field"><label htmlFor="behavior-delay-ms">等待时间</label><div className="behavior-delay-row"><Clock3 size={16} /><input id="behavior-delay-ms" className="behavior-delay-input" autoFocus={draft} type="number" min="0" max="300000" step="10" value={behavior.ms} onChange={(event) => onUpdate((current) => current.type === 'delay' ? { ...current, ms: Math.max(0, Math.min(300000, Number(event.target.value) || 0)) } : current)} /><span>毫秒</span></div></div> : <div className="behavior-dialog-field">这个行为不需要编辑。</div>}
      </div>
      <footer className="behavior-dialog-actions">
        <span><Check size={13} /> {draft ? '保存后立即生效' : '更改会自动保存'}</span>
        {draft ? <div className="behavior-dialog-buttons"><button type="button" className="dialog-secondary" onClick={onClose}>取消</button><button type="button" className="button primary" disabled={!canSave} onClick={onSave}>保存</button></div> : <button type="button" className="button primary" onClick={onClose}>关闭</button>}
      </footer>
    </section>
  </div>
}

type TextInputPresetDialogProps = {
  button: RemoteButton
  trigger: TriggerType
  value: string
  onChange: (value: string) => void
  onClose: () => void
  onSave: () => void
}

export function TextInputPresetDialog({ button, trigger, value, onChange, onClose, onSave }: TextInputPresetDialogProps) {
  return <div className="behavior-dialog-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose() }}>
    <section className="behavior-dialog text-input-dialog" role="dialog" aria-modal="true" aria-labelledby="text-input-dialog-title">
      <header className="behavior-dialog-head">
        <div><span className="section-kicker">{button.label} · {triggerLabels[trigger]}</span><h2 id="text-input-dialog-title">输入文本并回车</h2></div>
        <button type="button" className="dialog-close" aria-label="关闭输入文本" onClick={onClose}><X size={17} /></button>
      </header>
      <div className="behavior-dialog-body">
        <div className="text-input-sequence" aria-label="粘贴文本，等待 30 毫秒，然后按下 Enter">
          <span>粘贴文本</span><ChevronRight size={14} /><span>等待 30 ms</span><ChevronRight size={14} /><span>Enter</span>
        </div>
        <div className="behavior-dialog-field text-input-field">
          <label htmlFor="text-input-preset-value">文本内容</label>
          <textarea id="text-input-preset-value" className="behavior-paste-input" autoFocus value={value} placeholder="输入要发送的文本" onChange={(event) => onChange(event.target.value)} />
        </div>
      </div>
      <footer className="behavior-dialog-actions">
        <span><Check size={13} /> 三个步骤会一起保存</span>
        <div className="behavior-dialog-buttons"><button type="button" className="dialog-secondary" onClick={onClose}>取消</button><button type="button" className="button primary" disabled={!value.trim()} onClick={onSave}>应用行为</button></div>
      </footer>
    </section>
  </div>
}
