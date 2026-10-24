import { Check, FileJson, X } from 'lucide-react'
import { useState } from 'react'
import type { BehaviorMap } from '../behaviorModel'
import { devices, mouseInputParts } from '../deviceModel'
import type { DeviceId } from '../deviceModel'
import { behaviorSummary, buttons, normalizeProfileName } from '../appConfig'
import type { Platform } from '../appTypes'

type ProfileImportDialogProps = {
  fileName: string
  suggestedName: string
  behaviors: BehaviorMap
  deviceId: DeviceId
  platform: Platform
  enabled?: boolean
  onCancel: () => void
  onSave: (name: string) => void
}

export function ProfileImportDialog({ fileName, suggestedName, behaviors, deviceId, platform, enabled, onCancel, onSave }: ProfileImportDialogProps) {
  const [name, setName] = useState(suggestedName)
  const device = devices.find(device => device.id === deviceId)!
  const inputs = device.inputIds.map(id => [id, behaviors[id]] as const)
  const configured = inputs.filter(([, triggers]) => Object.values(triggers).some((list) => list.length > 0))
  const stepCount = inputs.reduce((total, [, triggers]) => total + Object.values(triggers).reduce((sum, list) => sum + list.length, 0), 0)
  const previewItems = configured.slice(0, 8).map(([id, triggers]) => {
    const first = Object.values(triggers).flat()[0]
    const label = id.startsWith('mouse.')
      ? (() => { const { scope, control } = mouseInputParts(id as Parameters<typeof mouseInputParts>[0]); return `${scope.label} · ${control.label}` })()
      : buttons.find((button) => button.id === id)?.label ?? id
    return first ? `${label}：${first.type === 'paste' ? '粘贴文本' : behaviorSummary(first, platform)}` : label
  })
  const save = () => {
    const normalized = normalizeProfileName(name, suggestedName || '导入配置')
    if (normalized) onSave(normalized)
  }

  return <div className="behavior-dialog-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) onCancel() }} onKeyDown={(event) => { if (event.key === 'Escape') { event.stopPropagation(); onCancel() } }}>
    <section className="behavior-dialog profile-import-dialog" role="dialog" aria-modal="true" aria-labelledby="profile-import-title">
      <header className="behavior-dialog-head">
        <div><span className="section-kicker"><FileJson size={13} /> 导入配置文件</span><h2 id="profile-import-title">预览并保存配置</h2></div>
        <button type="button" className="dialog-close" aria-label="取消导入配置文件" onClick={onCancel}><X size={17} /></button>
      </header>
      <div className="behavior-dialog-body profile-import-body">
        <div className="profile-import-file"><FileJson size={17} /><span>{fileName}</span></div>
        <div className="profile-import-name">
          <label htmlFor="profile-import-name-input">配置名称</label>
          <input id="profile-import-name-input" autoFocus value={name} maxLength={40} onChange={(event) => setName(event.target.value)} />
        </div>
        <div className="profile-import-summary" aria-label="配置内容摘要">
          <div><strong>{device.name}</strong><span>所属设备</span></div>
          <div><strong>{configured.length}</strong><span>{deviceId === 'mouse' ? '个鼠标输入' : '个遥控器按键'}</span></div>
          <div><strong>{stepCount}</strong><span>个行为步骤</span></div>
        </div>
        {previewItems.length > 0 ? <div className="profile-import-preview"><strong>映射预览</strong><ul>{previewItems.map((item, index) => <li key={`${item}-${index}`}>{item}</li>)}</ul>{configured.length > previewItems.length && <small>还有 {configured.length - previewItems.length} 个输入未展开</small>}</div> : <div className="profile-import-empty">此配置暂未设置任何映射，保存后可以继续编辑。</div>}
        {enabled !== undefined && <p className="profile-import-note">文件中的{deviceId === 'mouse' ? '系统鼠标映射开关' : '映射总开关'}为“{enabled ? '已开启' : '未开启'}”，保存后会一并应用。</p>}
      </div>
      <footer className="behavior-dialog-actions">
        <span><Check size={13} /> 保存后自动切换到此配置</span>
        <div className="behavior-dialog-buttons"><button type="button" className="dialog-secondary" onClick={onCancel}>取消</button><button type="button" className="button primary" disabled={!name.trim()} onClick={save}>保存并切换</button></div>
      </footer>
    </section>
  </div>
}
