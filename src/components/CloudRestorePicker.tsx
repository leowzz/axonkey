import { useState } from 'react'
import type { CloudState } from '../cloud/cloudSync'
import type { RestoreSelection } from '../cloud/cloudData'
import type { DeviceInstance } from '../devices/integration/model'
import { supportPackages } from '../devices/integration/model'

const platformName = (value?: string) => (value === 'windows' ? 'Windows' : value === 'macos' ? 'macOS' : '来源未知')
type Profile = { id: string; name: string; app_version?: string | null; behaviors: Record<string, unknown> }
export function CloudRestorePicker({
  state,
  instances,
  platform,
  busy,
  onConfirm,
  onCancel,
}: {
  state: CloudState
  instances: DeviceInstance[]
  platform: string
  busy: boolean
  onConfirm: (selection: RestoreSelection) => void
  onCancel: () => void
}) {
  const [selected, setSelected] = useState<Record<string, string[]>>({})
  const [targets, setTargets] = useState<Record<string, string>>({})
  const [newTargets] = useState(() =>
    Object.fromEntries(state.documents.map(doc => [doc.id, `new:${crypto.randomUUID()}`])),
  )
  const [settings, setSettings] = useState(false)
  const [savedBehaviors, setSavedBehaviors] = useState(false)
  const [filter, setFilter] = useState('all')
  const count = Object.values(selected).reduce((sum, ids) => sum + ids.length, 0)
  const targetFor = (documentId: string) => {
    const doc = state.documents.find(item => item.id === documentId)!
    const kind = state.models.find(model => model.id === doc.model_id)?.code
    if (kind === 'mouse') return 'legacy:mouse'
    const localDevices = instances.filter(instance => instance.kind === kind)
    const chosen = targets[documentId]
    if (chosen === newTargets[documentId] || localDevices.some(instance => instance.id === chosen)) return chosen
    return localDevices.length === 1 ? localDevices[0].id : localDevices.length === 0 ? newTargets[documentId] : ''
  }
  const missingTarget = Object.entries(selected).some(([id, ids]) => ids.length && !targetFor(id))
  return (
    <section className="cloud-restore" aria-label="选择恢复云端配置">
      <div className="cloud-restore-heading">
        <h4>选择要恢复的方案</h4>
        <select
          aria-label="筛选来源系统"
          value={filter}
          disabled={busy}
          onChange={event => setFilter(event.target.value)}
        >
          <option value="all">全部系统</option>
          <option value="windows">Windows</option>
          <option value="macos">macOS</option>
          <option value="unknown">来源未知</option>
        </select>
      </div>
      <p>追加到本机，不改变已有设备的绑定、启用状态或当前方案。重复内容跳过，变更另存副本。</p>
      <fieldset disabled={busy} className="cloud-restore-devices">
        {state.documents
          .filter(doc => filter === 'all' || (doc.source_platform ?? 'unknown') === filter)
          .map(doc => {
            const kind = state.models.find(model => model.id === doc.model_id)?.code
            const support = supportPackages.find(item => item.kind === kind)
            const supported = !!support || kind === 'mouse'
            const localDevices = instances.filter(instance => instance.kind === kind)
            const target = targetFor(doc.id)
            const profiles = (doc.config.profiles ?? []) as Profile[]
            const checked = selected[doc.id] ?? []
            const crossPlatform =
              doc.source_platform && doc.source_platform !== 'unknown' && doc.source_platform !== platform
            return (
              <div className="cloud-restore-device" key={doc.id}>
                <label className="cloud-restore-device-title">
                  <input
                    type="checkbox"
                    disabled={!supported}
                    checked={profiles.length > 0 && checked.length === profiles.length}
                    ref={input => {
                      if (input) input.indeterminate = checked.length > 0 && checked.length < profiles.length
                    }}
                    onChange={event =>
                      setSelected(current => ({
                        ...current,
                        [doc.id]: event.target.checked ? profiles.map(profile => profile.id) : [],
                      }))
                    }
                  />
                  <strong>{String(doc.config.name)}</strong>
                  <span>{support?.name ?? kind}</span>
                </label>
                <div className="cloud-restore-source">
                  {platformName(doc.source_platform)} · {doc.source_computer_name || '电脑名称未知'}
                  {doc.updated_at ? ` · ${new Date(doc.updated_at).toLocaleString()}` : ''}
                </div>
                {!supported && <p role="status">当前版本不支持此型号，请升级后恢复。</p>}
                <div className="cloud-restore-profiles">
                  {profiles.map(profile => (
                    <label key={profile.id}>
                      <input
                        type="checkbox"
                        checked={checked.includes(profile.id)}
                        disabled={!supported}
                        onChange={event =>
                          setSelected(current => ({
                            ...current,
                            [doc.id]: event.target.checked
                              ? [...checked, profile.id]
                              : checked.filter(id => id !== profile.id),
                          }))
                        }
                      />
                      <span>{profile.name}</span>
                      <small>{profile.app_version ? `Axonkey ${profile.app_version}` : '软件版本未知'}</small>
                      <small>
                        {
                          Object.values(profile.behaviors ?? {}).filter(triggers =>
                            Object.values(triggers as Record<string, unknown[]>).some(actions => actions.length > 0),
                          ).length
                        }{' '}
                        个有动作按键
                      </small>
                    </label>
                  ))}
                </div>
                {checked.length > 0 && (
                  <>
                    {kind !== 'mouse' &&
                      (localDevices.length === 0 ? (
                        <p className="cloud-restore-target">恢复为新设备，之后绑定实物并启用。</p>
                      ) : (
                        <label className="cloud-restore-target">
                          恢复到
                          <select
                            aria-label={`${String(doc.config.name)}恢复到`}
                            value={target.startsWith('new:') ? 'new' : target}
                            onChange={event =>
                              setTargets(current => ({
                                ...current,
                                [doc.id]: event.target.value === 'new' ? newTargets[doc.id] : event.target.value,
                              }))
                            }
                          >
                            {localDevices.length > 1 && <option value="">选择设备</option>}
                            {localDevices.map(instance => (
                              <option key={instance.id} value={instance.id}>
                                {instance.name}
                                {localDevices.filter(item => item.name === instance.name).length > 1
                                  ? ` · ${instance.id.slice(-6)}`
                                  : ''}
                              </option>
                            ))}
                            <option value="new">新建设备</option>
                          </select>
                        </label>
                      ))}
                    {crossPlatform && (
                      <p className="cloud-restore-warning">
                        跨系统恢复：保留原快捷键。应用路径、系统命令和部分动作可能需要调整，请检查后再启用。
                      </p>
                    )}
                    {checked.some(id =>
                      JSON.stringify(profiles.find(p => p.id === id)?.behaviors).includes('openApp'),
                    ) && <p className="cloud-restore-warning">含应用启动动作，请检查本机应用路径。</p>}
                  </>
                )}
              </div>
            )
          })}
        {state.documents.length === 0 && <p>云端没有设备配置。</p>}
        {state.settings && (
          <div className="cloud-restore-options">
            <label>
              <input type="checkbox" checked={settings} onChange={event => setSettings(event.target.checked)} />
              覆盖个人设置
            </label>
            {state.settings.settings.savedBehaviors !== undefined && (
              <label>
                <input
                  type="checkbox"
                  checked={savedBehaviors}
                  onChange={event => setSavedBehaviors(event.target.checked)}
                />
                覆盖个人行为库
              </label>
            )}
            {(settings || savedBehaviors) && (
              <p className="cloud-restore-warning">所选项目将替换本机内容；需要保留时请先导出数据备份。</p>
            )}
          </div>
        )}
      </fieldset>
      <div className="cloud-confirm-actions">
        <button
          type="button"
          className="button primary"
          disabled={busy || missingTarget || (!count && !settings && !savedBehaviors)}
          onClick={() =>
            onConfirm({
              devices: Object.entries(selected)
                .filter(([, ids]) => ids.length)
                .map(([documentId, profileIds]) => ({ documentId, profileIds, targetId: targetFor(documentId) })),
              settings,
              savedBehaviors,
            })
          }
        >
          {busy ? '恢复中…' : `恢复所选${count ? `（${count} 个方案）` : ''}`}
        </button>
        <button type="button" className="dialog-secondary" disabled={busy} onClick={onCancel}>
          取消
        </button>
      </div>
    </section>
  )
}
