import {
  Check,
  ChevronDown,
  Copy,
  Layers,
  LayoutGrid,
  MoreHorizontal,
  Pencil,
  Plus,
  Sparkles,
  Trash2,
  X,
} from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { SelectControl } from './SelectControl'
import type { MappingProfile } from '../appTypes'

type ProfileManagerProps = {
  profiles: Pick<MappingProfile, 'id' | 'name' | 'quick'>[]
  activeProfileId: string
  onSwitch: (id: string) => void
  onCreate: () => void
  onCreateQuick?: () => void
  onOpenPresets?: () => void
  onDuplicate: () => void
  onRename: (name: string) => void
  onDelete: () => void
  compact?: boolean
  onRemoveApplication?: () => void
}

export function ProfileManager({
  profiles,
  activeProfileId,
  onSwitch,
  onCreate,
  onCreateQuick,
  onOpenPresets,
  onDuplicate,
  onRename,
  onDelete,
  compact = false,
  onRemoveApplication,
}: ProfileManagerProps) {
  const active = profiles.find(profile => profile.id === activeProfileId) ?? profiles[0]
  const regularProfiles = profiles.filter(profile => !profile.quick)
  const quickProfiles = profiles.filter(profile => profile.quick)
  const canDelete = Boolean(active && (active.quick ? true : regularProfiles.length > 1))
  const [renaming, setRenaming] = useState(false)
  const [draft, setDraft] = useState(active?.name ?? '')
  const popupRef = useRef<HTMLDetailsElement>(null)

  useEffect(() => {
    setDraft(active?.name ?? '')
    setRenaming(false)
    if (popupRef.current) popupRef.current.open = false
  }, [active?.id, active?.name])

  useEffect(() => {
    const close = (event: PointerEvent | KeyboardEvent) => {
      if (event instanceof KeyboardEvent ? event.key === 'Escape' : !popupRef.current?.contains(event.target as Node)) {
        if (popupRef.current) popupRef.current.open = false
      }
    }
    document.addEventListener('pointerdown', close)
    document.addEventListener('keydown', close)
    return () => {
      document.removeEventListener('pointerdown', close)
      document.removeEventListener('keydown', close)
    }
  }, [])

  if (!active) return null
  const submitRename = () => {
    const name = draft.trim()
    if (!name) return
    onRename(name.slice(0, 40))
    setRenaming(false)
  }

  const runAction = (action: () => void) => {
    if (popupRef.current) popupRef.current.open = false
    popupRef.current?.querySelector('summary')?.focus()
    action()
  }

  return (
    <>
      {compact && (
        <SelectControl
          containerClassName="application-profile-select"
          aria-label="配置"
          value={activeProfileId}
          onChange={event => onSwitch(event.target.value)}
        >
          {quickProfiles.length === 0 ? (
            profiles.map(profile => (
              <option key={profile.id} value={profile.id}>
                {profile.name}
              </option>
            ))
          ) : (
            <>
              <optgroup label="常驻配置">
                {regularProfiles.map(profile => (
                  <option key={profile.id} value={profile.id}>
                    {profile.name}
                  </option>
                ))}
              </optgroup>
              <optgroup label="快捷交互配置">
                {quickProfiles.map(profile => (
                  <option key={profile.id} value={profile.id}>
                    {profile.name}
                  </option>
                ))}
              </optgroup>
            </>
          )}
        </SelectControl>
      )}
      <details ref={popupRef} className={`profile-manager${compact ? ' profile-manager-compact' : ''}`}>
        <summary
          aria-label={compact ? '配置操作' : `当前配置文件：${active.name}`}
          title={compact ? '配置操作' : undefined}
        >
          {compact ? (
            <MoreHorizontal size={17} />
          ) : (
            <>
              <span className="profile-manager-icon">
                {active.quick ? <LayoutGrid size={18} /> : <Layers size={18} />}
              </span>
              <span className="profile-manager-current">
                <strong>{active.name}</strong>
                <small>{active.quick ? '快捷交互配置' : '配置文件'}</small>
              </span>
              <ChevronDown size={14} />
            </>
          )}
        </summary>
        <div className="profile-manager-popover">
          <div className="profile-manager-heading">{compact ? '配置操作' : '切换配置文件'}</div>
          {!compact && (
            <div className="profile-manager-list" role="group" aria-label="配置文件">
              {regularProfiles.map(profile => (
                <button
                  key={profile.id}
                  type="button"
                  aria-pressed={profile.id === activeProfileId}
                  onClick={() => runAction(() => onSwitch(profile.id))}
                >
                  <Layers size={15} />
                  <span>{profile.name}</span>
                  {profile.id === activeProfileId && <Check size={15} />}
                </button>
              ))}
              {quickProfiles.map(profile => (
                <button
                  key={profile.id}
                  type="button"
                  aria-pressed={profile.id === activeProfileId}
                  onClick={() => runAction(() => onSwitch(profile.id))}
                >
                  <LayoutGrid size={15} />
                  <span>{profile.name} · 快捷</span>
                  {profile.id === activeProfileId && <Check size={15} />}
                </button>
              ))}
            </div>
          )}
          {renaming ? (
            <form
              className="profile-rename-form"
              onSubmit={event => {
                event.preventDefault()
                submitRename()
              }}
            >
              <input
                autoFocus
                value={draft}
                maxLength={40}
                aria-label="配置文件名称"
                onChange={event => setDraft(event.target.value)}
              />
              <button
                type="submit"
                className="profile-icon-button"
                title="保存名称"
                aria-label="保存配置文件名称"
                disabled={!draft.trim()}
              >
                <Check size={14} />
              </button>
              <button
                type="button"
                className="profile-icon-button"
                title="取消重命名"
                aria-label="取消重命名"
                onClick={() => {
                  setDraft(active.name)
                  setRenaming(false)
                }}
              >
                <X size={14} />
              </button>
            </form>
          ) : (
            <div className="profile-manager-actions">
              <button type="button" onClick={() => runAction(onCreate)}>
                <Plus size={15} /> 新增空配置文件
              </button>
              {onCreateQuick && (
                <button type="button" onClick={() => runAction(onCreateQuick)}>
                  <LayoutGrid size={15} /> 新增快捷交互配置
                </button>
              )}
              {onOpenPresets && (
                <button type="button" onClick={() => runAction(onOpenPresets)}>
                  <Sparkles size={15} /> 从预制配置导入
                </button>
              )}
              <button type="button" onClick={() => runAction(onDuplicate)}>
                <Copy size={15} /> 复制当前配置文件
              </button>
              <button type="button" onClick={() => setRenaming(true)}>
                <Pencil size={15} /> 重命名当前配置文件
              </button>
              <button
                type="button"
                className="profile-delete-button"
                disabled={!canDelete}
                title={!canDelete ? '至少保留一个常驻配置文件' : undefined}
                onClick={() => runAction(onDelete)}
              >
                <Trash2 size={15} /> 删除当前配置文件
              </button>
              {onRemoveApplication && (
                <button type="button" onClick={() => runAction(onRemoveApplication)}>
                  <Trash2 size={15} /> 移除此应用
                </button>
              )}
            </div>
          )}
        </div>
      </details>
    </>
  )
}
