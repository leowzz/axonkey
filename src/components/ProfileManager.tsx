import { Check, Copy, Pencil, Plus, Trash2, X } from 'lucide-react'
import { useEffect, useState } from 'react'
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

  useEffect(() => {
    setDraft(active?.name ?? '')
    setRenaming(false)
  }, [active?.id, active?.name])

  if (!active) return null
  const submitRename = () => {
    const name = draft.trim()
    if (!name) return
    onRename(name.slice(0, 40))
    setRenaming(false)
  }

  return <div className="profile-manager" aria-label="配置文件管理">
    <span className="profile-manager-label">配置文件</span>
    {renaming ? <form className="profile-rename-form" onSubmit={(event) => { event.preventDefault(); submitRename() }}>
      <input autoFocus value={draft} maxLength={40} aria-label="配置文件名称" onChange={(event) => setDraft(event.target.value)} />
      <button type="submit" className="profile-icon-button" title="保存名称" aria-label="保存配置文件名称" disabled={!draft.trim()}><Check size={14} /></button>
      <button type="button" className="profile-icon-button" title="取消重命名" aria-label="取消重命名" onClick={() => { setDraft(active.name); setRenaming(false) }}><X size={14} /></button>
    </form> : <select value={active.id} aria-label="当前配置文件" onChange={(event) => onSwitch(event.target.value)}>
      {profiles.map((profile) => <option key={profile.id} value={profile.id}>{profile.name}</option>)}
    </select>}
    {!renaming && <button type="button" className="profile-icon-button" title="重命名当前配置文件" aria-label="重命名当前配置文件" onClick={() => setRenaming(true)}><Pencil size={14} /></button>}
    <button type="button" className="profile-icon-button" title="复制当前配置文件" aria-label="复制当前配置文件" onClick={onDuplicate}><Copy size={14} /></button>
    <button type="button" className="profile-icon-button" title="新增空配置文件" aria-label="新增空配置文件" onClick={onCreate}><Plus size={14} /></button>
    <button type="button" className="profile-icon-button profile-delete-button" title={profiles.length > 1 ? '删除当前配置文件' : '至少保留一个配置文件'} aria-label="删除当前配置文件" disabled={profiles.length <= 1} onClick={onDelete}><Trash2 size={14} /></button>
  </div>
}

