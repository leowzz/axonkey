import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { listen } from '@tauri-apps/api/event'
import { ArrowLeft, ChevronRight, Plus, RefreshCw, Settings2, X } from 'lucide-react'
import type { MacPermissions, Platform } from '../../appTypes'
import type { TriggerBehaviors, ButtonId } from '../../behaviorModel'
import type { DeviceId } from '../../deviceModel'
import { RemoteControl } from '../../components/RemoteControl'
import { InstanceBehaviorEditor } from './InstanceBehaviorEditor'
import { DeviceBindingPicker, InputModePicker } from './IntegrationControls'
import { SettingsHelp } from '../../components/SettingsHelp'
import { ControllerDiagram } from '../xbox-controller/ControllerDiagram'
import { xiaomiRemoteView } from '../xiaomi-remote/view'
import { cmiotA15RemoteDevice } from '../cmiot-a15-remote/definition'
import { emptyTriggers, instanceStatusLabel, newInstance, packageFor, supportPackages } from './model'
import type { DeviceInstance, DeviceKind, DiscoveredDevice, InstanceProfile } from './model'
import type { DeviceController } from './useDeviceInstances'
import './DeviceHub.css'

type Props = {
  controller: DeviceController; native: boolean; platform: Platform; permissions: MacPermissions
  onBrandClick: () => void; onPermissions: () => void; onDriver: () => void; onLegacy: (id: DeviceId) => void
  legacyProfiles: (kind: DeviceKind) => InstanceProfile[]
}
type Integration = { kind?: DeviceKind; device?: DiscoveredDevice; instance?: DeviceInstance }
export function DeviceHub(props: Props) {
  const { controller, native } = props
  const { snapshot, error, busy } = controller
  const [selected, setSelected] = useState<string | null>(null)
  const [integration, setIntegration] = useState<Integration | null>(null)
  const instance = snapshot.store.instances.find(i => i.id === selected)
  const unboundDevices = snapshot.discovered.filter(d => !snapshot.store.instances.some(i => i.binding === d.id))
  const banner = <>{!native && <p className="managed-notice">浏览器预览 · 设备连接需使用桌面应用</p>}{(error || snapshot.error || snapshot.scanError) && <p className="managed-error" role="alert">{error || snapshot.error || snapshot.scanError}</p>}</>
  return <section className={`managed-hub ${instance ? 'has-workspace' : ''}`}>
    {banner}
    {instance ? <InstanceWorkspace key={instance.id} {...props} instance={instance} onBack={() => setSelected(null)} onBind={() => setIntegration({ kind: instance.kind, instance })} /> : <>
      <header className="my-devices-heading"><div className="my-devices-heading-main"><button className="my-devices-brand" aria-label="Axonkey" title="Axonkey" onClick={props.onBrandClick}><img src={new URL('../../../src-tauri/icons/128x128@2x.png', import.meta.url).href} alt="" />Axonkey</button><h1>我的设备</h1></div><button className="my-devices-integrate" onClick={() => setIntegration({})}><Plus size={16} />手动添加设备</button></header>
      <h2 className="my-devices-section-title">发现设备 <button className="managed-icon" aria-label="刷新设备" onClick={() => void controller.refresh()} disabled={!native}><RefreshCw size={14} /></button></h2>
      <div className="managed-device-grid">
        {unboundDevices.map(device => <DeviceCard key={device.id} kind={device.kind} title={packageFor(device.kind).name} subtitle={`${device.transport === 'Bluetooth' ? '蓝牙' : device.transport} · ${device.id.slice(-6)}`} status={device.identityQuality === 'ambiguous' ? '实例标识冲突，无法自动绑定' : device.connected ? '点击集成' : '未连接'} onClick={() => setIntegration({ kind: device.kind, device })} />)}
        {snapshot.store.instances.map(item => <DeviceCard key={item.id} kind={item.kind} title={item.name} subtitle={`实例 ${item.id.slice(-6)} · ${packageFor(item.kind).model}`} status={native ? instanceStatusLabel(item, snapshot) : '预览配置'} profile={item.profiles.find(p => p.id === item.activeProfileId)?.name} onClick={() => setSelected(item.id)} />)}
        <button className="my-devices-card managed-system-mouse" onClick={() => props.onLegacy('mouse')}><div className="my-devices-card-main"><span className="my-devices-artwork"><img src="/mouse-device.svg" alt="" /></span><div className="my-devices-identity"><strong>系统鼠标</strong><span className="my-devices-count">按键、滚轮和屏幕边缘</span></div></div><div className="my-devices-summary"><span className="my-devices-status">系统输入源</span><span className="my-devices-profile"><strong>编辑映射</strong></span></div></button>
      </div>
    </>}
    {integration && createPortal(<IntegrationDialog {...props} initial={integration} onClose={() => setIntegration(null)} onComplete={id => { setIntegration(null); setSelected(id) }} />, document.body)}
    {busy && <span className="managed-saving" role="status">正在保存…</span>}
  </section>
}
function DeviceCard({ kind, title, subtitle, status, profile, onClick }: { kind: DeviceKind; title: string; subtitle: string; status: string; profile?: string; onClick: () => void }) {
  return <button className="my-devices-card" onClick={onClick}><div className="my-devices-card-main"><span className="my-devices-artwork"><img src={packageFor(kind).artwork} alt="" /></span><span className="my-devices-identity"><strong>{title}</strong><span className="my-devices-count">{subtitle}</span></span></div><span className="my-devices-summary"><span className="my-devices-status"><i className="my-devices-status-dot" />{status}</span><span className="my-devices-profile">{profile ? <>当前配置<strong>{profile}</strong></> : <ChevronRight size={15} aria-hidden="true" />}</span></span></button>
}
function IntegrationDialog({ initial, controller, native, platform, permissions, onPermissions, onDriver, onClose, onComplete }: Props & { initial: Integration; onClose: () => void; onComplete: (id: string) => void }) {
  const [kind, setKind] = useState(initial.kind)
  const [name, setName] = useState(initial.instance?.name ?? (initial.kind ? packageFor(initial.kind).name : ''))
  const [binding, setBinding] = useState(initial.device?.id ?? initial.instance?.binding ?? '')
  const [capture, setCapture] = useState<'shared' | 'exclusive'>(platform === 'macos' ? initial.instance?.capture ?? 'shared' : 'shared')
  const [localError, setError] = useState('')
  const dialog = useRef<HTMLElement>(null)
  useEffect(() => {
    const root = document.getElementById('root'); const inert = root?.inert ?? false; const focus = document.activeElement
    if (root) root.inert = true
    dialog.current?.querySelector<HTMLElement>('button')?.focus()
    return () => { if (root) root.inert = inert; if (focus instanceof HTMLElement && focus.isConnected) focus.focus() }
  }, [])
  const candidates = controller.snapshot.discovered.filter(d => d.kind === kind && !controller.snapshot.store.instances.some(i => i.id !== initial.instance?.id && i.binding === d.id))
  const device = candidates.find(d => d.id === binding)
  async function integrate() {
    if (!kind) return
    try {
      const instance = { ...(initial.instance ?? newInstance(kind, null)), name: name.trim(), binding: binding || null, capture }
      const result = await controller.put(instance)
      const saved = instance.id ? result.store.instances.find(i => i.id === instance.id) : result.store.instances[result.store.instances.length - 1]
      if (saved) onComplete(saved.id)
    } catch (e) { setError(String(e)) }
  }
  return <div className="behavior-dialog-backdrop" onKeyDown={event => {
    if (event.key === 'Escape') {
      event.preventDefault()
      if (dialog.current?.querySelector('.settings-help[aria-expanded="true"]')) return
      event.stopPropagation(); onClose()
    }
    if (event.key === 'Tab') {
      const elements = Array.from(dialog.current?.querySelectorAll<HTMLElement>('button:not(:disabled),input:not(:disabled),select:not(:disabled),[tabindex="0"]') ?? [])
      const first = elements[0]; const last = elements[elements.length - 1]
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus() }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus() }
    }
  }}>
    <section ref={dialog} role="dialog" aria-modal="true" aria-labelledby="managed-integration-title" className="behavior-dialog managed-integration-dialog">
      <header className="behavior-dialog-head"><h2 id="managed-integration-title">{initial.instance ? '绑定物理设备' : '集成设备'}</h2><button aria-label="关闭集成" className="dialog-close" onClick={onClose}><X size={17} /></button></header>
      <div className="behavior-dialog-body managed-integration-body">
        {!kind ? <>{supportPackages.map(pkg => <button className="managed-package" key={pkg.kind} onClick={() => { setKind(pkg.kind); setName(pkg.name) }}><img src={pkg.artwork} alt="" /><span><strong>{pkg.name}</strong><small>{pkg.model.split(' · ')[0]}{pkg.kind === 'cmiotA15' ? ' · 仅配置' : ''}</small></span></button>)}</> : <>
          <div className="managed-integration-product"><img src={packageFor(kind).artwork} alt="" /><div><h3>{packageFor(kind).name}</h3><p>{packageFor(kind).model.split(' · ')[0]}</p></div></div>
          <div className="settings-form-fields">
            <label className="settings-form-row"><span className="settings-form-label">设备名称</span><input value={name} maxLength={60} onChange={e => setName(e.target.value)} /></label>
            <div className="settings-form-row"><span className="settings-form-label" id="integration-binding-label">绑定设备</span><DeviceBindingPicker labelledBy="integration-binding-label" value={binding} devices={candidates} onChange={setBinding} /></div>
            <div className="settings-form-row"><span className="settings-form-label integration-mode-label"><span id="integration-mode-label">输入模式</span><SettingsHelp id="integration-mode-help" label="输入模式">独占模式会拦截整个设备，包括未配置的按键；停用设备后恢复原始输入。</SettingsHelp></span><InputModePicker labelledBy="integration-mode-label" value={capture} exclusive={platform === 'macos'} onChange={setCapture} /></div>
          </div>
          {device?.identityQuality === 'session' && <p className="integration-attention">此设备重新连接后需再次绑定。</p>}
          {device?.identityQuality === 'ambiguous' && <p className="managed-error">设备标识冲突，请断开其余同型号设备后重试。</p>}
          {native && platform === 'macos' && (!permissions.inputMonitoring || !permissions.accessibility) && <div className="integration-attention"><span>需要{[!permissions.inputMonitoring && '输入监控', !permissions.accessibility && '辅助功能'].filter(Boolean).join('、')}权限</span><button onClick={() => { onClose(); onPermissions() }}>去授权</button></div>}
          {kind === 'cmiotA15' && <p className="integration-attention">此设备暂不支持输入监听。</p>}
          {platform === 'windows' && kind === 'rc003' && <div className="integration-attention"><span>此设备的 Windows 映射仍需使用原工作区。</span><button onClick={() => { onClose(); onDriver() }}>驱动设置</button></div>}
          {!native && <p className="integration-preview">预览模式，不会连接真实设备。</p>}
        </>}
        {localError && <p className="managed-error" role="alert">{localError}</p>}
      </div>
      <footer className="managed-dialog-footer"><button onClick={onClose}>取消</button>{kind && <button className="managed-primary" disabled={!name.trim() || controller.busy || device?.identityQuality === 'ambiguous' || Boolean(binding && !device)} onClick={() => void integrate()}>{!native ? '保存预览' : initial.instance ? '保存' : binding ? '集成设备' : '添加设备'}</button>}</footer>
    </section>
  </div>
}
function InstanceWorkspace({ instance, controller, native, platform, permissions, onPermissions, legacyProfiles, onBack, onBind }: Props & { instance: DeviceInstance; onBack: () => void; onBind: () => void }) {
  const pkg = packageFor(instance.kind)
  const [selected, setSelected] = useState(pkg.inputs[0].id as string)
  const [settings, setSettings] = useState(false)
  const [confirmRemove, setConfirmRemove] = useState(false)
  const [input, setInput] = useState<{ pressed: string[]; values: Record<string, number> }>({ pressed: [], values: {} })
  const profile = instance.profiles.find(p => p.id === instance.activeProfileId)!
  const selectedInput = pkg.inputs.find(i => i.id === selected) ?? pkg.inputs[0]
  const status = controller.snapshot.runtime[instance.id]
  useEffect(() => {
    if (!native) return
    let alive = true
    const listener = listen<{ instanceId: string; pressed: string[]; values: Record<string, number> }>('axonkey-device-input', event => { if (alive && event.payload.instanceId === instance.id) setInput(event.payload) })
    return () => { alive = false; void listener.then(unlisten => unlisten()) }
  }, [native, instance.id])
  useEffect(() => { setInput({ pressed: [], values: {} }) }, [instance.enabled, instance.activeProfileId, status?.state])
  const update = (change: (item: DeviceInstance) => DeviceInstance) => { void controller.update(instance.id, change).catch(() => {}) }
  const changeSequence = (id: string, sequences: TriggerBehaviors) => update(item => ({ ...item, profiles: item.profiles.map(p => p.id === profile.id ? { ...p, behaviors: { ...p.behaviors, [id]: sequences } } : p) }))
  const mapped = Object.keys(profile.behaviors).filter(id => Object.values(profile.behaviors[id]).some(sequence => sequence.some(b => b.enabled)))
  return <>
    <header className="managed-workspace-header"><button className="managed-back" onClick={onBack}><ArrowLeft size={16} />我的设备</button><strong>{instance.name}</strong><span className="managed-caption">实例 {instance.id.slice(-6)}</span><div className="managed-workspace-actions"><label>配置 <select aria-label="当前设备配置" value={instance.activeProfileId} onChange={e => { const activeProfileId = e.target.value; update(item => ({ ...item, activeProfileId })) }}>{instance.profiles.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}</select></label><button aria-label="新增设备配置" onClick={() => update(item => { const id = crypto.randomUUID(); return { ...item, activeProfileId: id, profiles: [...item.profiles, { id, name: `配置 ${item.profiles.length + 1}`, behaviors: {} }] } })}><Plus size={15} /></button><button aria-label="设备实例设置" aria-pressed={settings} onClick={() => setSettings(v => !v)}><Settings2 size={16} /></button></div></header>
    <div className="managed-status"><span>{native ? instanceStatusLabel(instance, controller.snapshot) : '预览模式'}</span><label><input type="checkbox" checked={instance.enabled} onChange={e => { const enabled = e.target.checked; update(item => ({ ...item, enabled })) }} />启用此设备</label><span>{native ? `已收到 ${status?.reports ?? 0} 份报告` : '真实输入需桌面应用'}</span><button onClick={onBind}>{instance.binding ? '重新绑定' : '绑定设备'}</button></div>
    {status?.error && <p role="alert" className="managed-error">{status.error}</p>}
    {native && platform === 'macos' && !permissions.accessibility && <p className="managed-notice">执行映射需要辅助功能权限。<button onClick={onPermissions}>前往授权</button></p>}
    {settings ? <div className="managed-instance-settings"><div className="settings-form-fields">
      <label className="settings-form-row"><span className="settings-form-label">实例名称：</span><input key={instance.name} defaultValue={instance.name} maxLength={60} onBlur={e => { const name = e.target.value.trim(); if (name && name !== instance.name) update(item => ({ ...item, name })) }} /></label>
      <label className="settings-form-row"><span className="settings-form-label">配置名称：</span><input key={profile.id + profile.name} defaultValue={profile.name} maxLength={60} onBlur={e => { const name = e.target.value.trim(); if (name) update(item => ({ ...item, profiles: item.profiles.map(p => p.id === profile.id ? { ...p, name } : p) })) }} /></label>
      <div className="settings-form-row"><span className="settings-form-label">输入模式：</span><div className="settings-form-control"><span>{instance.capture === 'shared' ? '共享监听' : '独占拦截整个设备'}</span><SettingsHelp id="managed-input-mode" label="输入模式">共享监听不会阻止原始输入；独占模式阻止整个设备的原始输入。重新绑定时可调整。</SettingsHelp></div></div>
      <div className="settings-form-row"><span className="settings-form-label">配置管理：</span><div className="settings-form-control"><button disabled={instance.profiles.length <= 1} onClick={() => update(item => { const profiles = item.profiles.filter(p => p.id !== profile.id); return { ...item, profiles, activeProfileId: profiles[0].id } })}>删除当前配置</button>{instance.kind !== 'xboxBluetooth' && <button onClick={() => update(item => { const copied = legacyProfiles(item.kind).map(p => ({ ...p, id: crypto.randomUUID(), name: `${p.name}（旧配置）` })); return copied.length ? { ...item, profiles: [...item.profiles, ...copied], activeProfileId: copied[0].id } : item })}>复制旧版配置</button>}</div></div>
      <div className="settings-form-row"><span className="settings-form-label">物理设备：</span><div className="settings-form-control"><button disabled={!instance.binding} onClick={() => update(item => ({ ...item, binding: null }))}>解除绑定，保留配置</button></div></div>
    </div><div className="managed-remove">{confirmRemove ? <><span>移除此实例及其全部配置？</span><button onClick={() => void controller.remove(instance.id).then(onBack).catch(() => {})}>确认移除</button><button onClick={() => setConfirmRemove(false)}>取消</button></> : <button onClick={() => setConfirmRemove(true)}>移除设备实例</button>}</div></div> : <div className={`managed-editor ${instance.kind === 'xboxBluetooth' ? 'is-controller' : ''}`}>
      <aside className="managed-diagram-panel">{instance.kind === 'xboxBluetooth' ? <ControllerDiagram selected={selected} pressed={input.pressed} mapped={mapped} onSelect={setSelected} /> : <RemoteControl buttons={[...pkg.inputs] as { id: ButtonId; label: string }[]} activeId={selected as ButtonId} pressedId={(input.pressed[0] ?? null) as ButtonId | null} mappedIds={mapped as ButtonId[]} onSelect={setSelected} remoteView={instance.kind === 'rc003' ? xiaomiRemoteView : cmiotA15RemoteDevice.remoteView} />}
        <p className="managed-diagram-hint">点击图中按键编辑 · 绿色表示实际输入</p>
        {instance.kind === 'xboxBluetooth' && <div className="managed-analog"><label>LT <meter min={0} max={1} value={input.values['xbox.lt'] ?? 0} /></label><label>RT <meter min={0} max={1} value={input.values['xbox.rt'] ?? 0} /></label><SettingsHelp id="managed-analog-help" label="摇杆与扳机映射">摇杆方向与扳机超过 55% 时触发，低于 35% 时释放。支持单击、双击和长按；当前输出为动作序列，不模拟虚拟手柄轴。</SettingsHelp></div>}
        {selected === 'xbox.guide' && <p className="managed-diagram-hint">主键是否上报取决于固件和系统；按下后观察绿色反馈。</p>}
      </aside>
      <div className="managed-flow"><InstanceBehaviorEditor key={profile.id + selected} platform={platform} button={{ ...selectedInput, id: selected, originalDescription: instance.capture === 'shared' ? '原始输入仍会发送给其他应用' : '独占模式下未配置的按键也会被拦截' }} sequences={profile.behaviors[selected] ?? emptyTriggers()} onChange={sequences => changeSequence(selected, sequences)} /></div>
    </div>}
  </>
}
