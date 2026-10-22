import { Check, ChevronDown, Copy, Layers, Pencil, Plus, Trash2, X } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import type { MappingProfile } from '../appTypes'

type ProfileManagerProps = {
  profiles: MappingProfile[]
  activeProfileId: string
  onSwitch: (id: string) => void
  onCreate: () => void
  onDuplicate: () => void
  onRename: (name: string) => void
  onDelete: () => void
}

export function ProfileManager({ profiles, activeProfileId, onSwitch, onCreate, onDuplicate, onRename, onDelete }: ProfileManagerProps) {
  const active = profiles.find((profile) => profile.id === activeProfileId) ?? profiles[0]
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
    action()
  }

  return <details ref={popupRef} className="profile-manager">
    <summary aria-label={`当前配置文件：${active.name}`}><span className="profile-manager-icon"><Layers size={18} /></span><span className="profile-manager-current"><strong>{active.name}</strong><small>配置文件</small></span><ChevronDown size={14} /></summary>
    <div className="profile-manager-popover">
      <div className="profile-manager-heading">切换配置文件</div>
      <div className="profile-manager-list" role="group" aria-label="配置文件">
        {profiles.map((profile) => <button key={profile.id} type="button" aria-pressed={profile.id === activeProfileId} onClick={() => runAction(() => onSwitch(profile.id))}><Layers size={15} /><span>{profile.name}</span>{profile.id === activeProfileId && <Check size={15} />}</button>)}
      </div>
      {renaming ? <form className="profile-rename-form" onSubmit={(event) => { event.preventDefault(); submitRename() }}>
      <input autoFocus value={draft} maxLength={40} aria-label="配置文件名称" onChange={(event) => setDraft(event.target.value)} />
      <button type="submit" className="profile-icon-button" title="保存名称" aria-label="保存配置文件名称" disabled={!draft.trim()}><Check size={14} /></button>
      <button type="button" className="profile-icon-button" title="取消重命名" aria-label="取消重命名" onClick={() => { setDraft(active.name); setRenaming(false) }}><X size={14} /></button>
    </form> : <div className="profile-manager-actions">
      <button type="button" onClick={() => runAction(onCreate)}><Plus size={15} /> 新增空配置文件</button>
      <button type="button" onClick={() => runAction(onDuplicate)}><Copy size={15} /> 复制当前配置文件</button>
      <button type="button" onClick={() => setRenaming(true)}><Pencil size={15} /> 重命名当前配置文件</button>
      <button type="button" className="profile-delete-button" disabled={profiles.length <= 1} title={profiles.length <= 1 ? '至少保留一个配置文件' : undefined} onClick={() => runAction(onDelete)}><Trash2 size={15} /> 删除当前配置文件</button>
    </div>}
    </div>
  </details>
}

