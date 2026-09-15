import type { CSSProperties } from 'react'
import { Command, ExternalLink, Info, Keyboard, Mouse, Power, RotateCcw, ShieldCheck } from 'lucide-react'
import { AutostartControl } from './AutostartControl'
import type { MacPermissionKind, MacPermissions, Platform } from '../appTypes'
import type { SetupState } from '../setupModel'

export type SettingsSection = 'startup' | 'permissions' | 'mouse'

type SettingsPageProps = {
  section: SettingsSection
  onSectionChange: (section: SettingsSection) => void
  platform: Platform
  nativeRuntime: boolean
  mouseIgnoreScrollAcceleration: boolean
  onMouseIgnoreScrollAccelerationChange: (value: boolean) => void
  mouseScrollSensitivity: number
  onMouseScrollSensitivityChange: (value: number) => void
  mouseVerticalScrollIntervalMs: number
  onMouseVerticalScrollIntervalMsChange: (ms: number) => void
  mouseHorizontalScrollIntervalMs: number
  onMouseHorizontalScrollIntervalMsChange: (ms: number) => void
  mouseKeyHoldMs: number
  onMouseKeyHoldMsChange: (ms: number) => void
  systemProbeState: 'loading' | 'ready' | 'error'
  permissions: MacPermissions
  inputAuthorizationStale: boolean
  inputDriver: SetupState['drivers']['input']
  onRequestPermission: (kind: MacPermissionKind) => void
  onOpenSettings: (kind: MacPermissionKind) => void
  onRefresh: () => void
  onOpenDriver: () => void
}

export function SettingsPage({ section, onSectionChange, platform, nativeRuntime, mouseIgnoreScrollAcceleration, onMouseIgnoreScrollAccelerationChange, mouseScrollSensitivity, onMouseScrollSensitivityChange, mouseVerticalScrollIntervalMs, onMouseVerticalScrollIntervalMsChange, mouseHorizontalScrollIntervalMs, onMouseHorizontalScrollIntervalMsChange, mouseKeyHoldMs, onMouseKeyHoldMsChange, systemProbeState, permissions, inputAuthorizationStale, inputDriver, onRequestPermission, onOpenSettings, onRefresh, onOpenDriver }: SettingsPageProps) {
  const supportsMouse = platform === 'windows' || platform === 'macos'
  const currentSection = section === 'mouse' && !supportsMouse ? 'startup' : section
  const sections = [
    { id: 'startup' as const, label: '启动设置', icon: <Power size={16} /> },
    { id: 'permissions' as const, label: '系统权限', icon: <ShieldCheck size={16} /> },
    ...(supportsMouse ? [{ id: 'mouse' as const, label: '鼠标映射', icon: <Mouse size={16} /> }] : []),
  ]
  const loading = systemProbeState === 'loading'
  const failed = systemProbeState === 'error'
  const items = [
    { kind: 'inputMonitoring' as const, title: '输入监控', description: '读取 RC003 遥控器的按键，让自定义映射能够响应。', granted: permissions.inputMonitoring && !inputAuthorizationStale, stale: inputAuthorizationStale, icon: <Keyboard size={18} /> },
    { kind: 'accessibility' as const, title: '辅助功能', description: '发送映射后的按键、快捷键和文本。', granted: permissions.accessibility, stale: false, icon: <Command size={18} /> },
  ]
  const grantedCount = items.filter((item) => item.granted).length
  return <div className="settings-page">
    <header className="settings-page-head">
      <div><h2>设置</h2><p>管理 Axonkey 的启动方式、输入选项和系统权限。</p></div>
      {currentSection === 'permissions' && <button type="button" className="dialog-secondary" disabled={!nativeRuntime || loading || platform === 'unsupported'} onClick={onRefresh}><RotateCcw size={14} />{loading ? '检测中' : '重新检测'}</button>}
    </header>
    <div className="settings-layout">
      <nav className="settings-nav" aria-label="设置分类">
        {sections.map((item) => <button key={item.id} id={`settings-nav-${item.id}`} type="button"
          aria-current={currentSection === item.id ? 'page' : undefined} aria-controls={`settings-panel-${item.id}`}
          onClick={() => onSectionChange(item.id)}>{item.icon}<span>{item.label}</span></button>)}
      </nav>
      <div className="settings-panels">
    <section id="settings-panel-startup" aria-labelledby="settings-nav-startup" hidden={currentSection !== 'startup'}>
      <h3 className="settings-section-title">启动设置</h3>
      <AutostartControl supported={nativeRuntime && (platform === 'macos' || platform === 'windows')} />
    </section>
    <section id="settings-panel-permissions" aria-labelledby="settings-nav-permissions" hidden={currentSection !== 'permissions'}>
    <h3 className="settings-section-title">系统权限</h3>
    {!nativeRuntime && <p className="permission-drag-note"><Info size={17} />浏览器预览无法检测或更改系统权限，请在桌面版中操作。</p>}
    {platform === 'macos' ? <>
      <div className={`settings-permission-summary ${nativeRuntime && !loading && !failed && grantedCount === 2 ? 'ready' : ''}`} aria-live="polite">
        <span className="settings-permission-icon"><ShieldCheck size={18} /></span>
        <div><strong>{!nativeRuntime ? '等待桌面版检测' : loading ? '正在检测权限' : failed ? '权限检测失败' : grantedCount === 2 ? '系统权限已就绪' : `已完成 ${grantedCount} / 2 项授权`}</strong><span>{failed ? '请重新检测以获取最新的授权状态。' : grantedCount === 2 ? '可以读取遥控器按键并执行自定义映射。' : '授权后返回应用，状态会自动刷新。'}</span></div>
      </div>
      <div className="settings-permission-list">
        {items.map((item) => {
          const known = nativeRuntime && !loading && !failed
          const granted = known && item.granted
          return <section key={item.kind} className={`settings-permission-row ${granted ? 'granted' : ''}`}>
            <span className="settings-permission-icon">{item.icon}</span>
            <div className="settings-permission-copy"><div><h3>{item.title}</h3><span className="settings-permission-status">{!nativeRuntime ? '未检测' : loading ? '检测中' : failed ? '检测失败' : item.stale ? '需要重新授权' : granted ? '已授权' : '未授权'}</span></div><p>{item.description}</p></div>
            <button type="button" className="dialog-secondary" disabled={!nativeRuntime || loading} onClick={() => granted ? onOpenSettings(item.kind) : onRequestPermission(item.kind)}>{granted ? '打开设置' : item.stale ? '重新授权' : '开始授权'}<ExternalLink size={14} /></button>
          </section>
        })}
      </div>
      {grantedCount < 2 && <div className="permission-drag-note"><Info size={17} /><div><strong>{inputAuthorizationStale ? '需要重新授权当前应用' : '系统列表中没有 Axonkey？'}</strong><span>{inputAuthorizationStale ? inputDriver.message ?? '当前应用的输入监控授权已失效，请重新授权后再使用按键映射。' : '点击开始授权后，可通过授权小窗在 Finder 中定位应用，再将 Axonkey.app 拖入系统设置列表。'}</span></div></div>}
    </> : platform === 'windows' ? <section className="settings-platform-note"><ShieldCheck size={28} /><h3>Windows 输入服务</h3><p>按键映射通过输入驱动运行，需要安装驱动并在系统提示时授予管理员权限。</p><p>驱动状态：{!nativeRuntime ? '未检测' : loading ? '检测中' : failed ? '检测失败' : inputDriver.status === 'installed' ? '已安装' : inputDriver.status === 'restartRequired' ? '需要重启' : '需要检查'}</p><button type="button" className="dialog-secondary" onClick={onOpenDriver}>打开驱动设置</button></section>
      : <section className="settings-platform-note"><Info size={28} /><h3>当前系统暂不支持</h3><p>请在 macOS 或 Windows 桌面版中配置系统权限。</p></section>}
    </section>
    {supportsMouse && <section id="settings-panel-mouse" aria-labelledby="settings-nav-mouse" hidden={currentSection !== 'mouse'}>
      <div className="settings-mouse-heading"><h3 className="settings-section-title">鼠标映射</h3><span>更改自动保存</span></div>
      <div className="settings-mouse-options">
      <section className="settings-permission-row settings-mouse-row">
        <span className="settings-permission-icon"><RotateCcw size={18} /></span>
        <div className="settings-permission-copy">
          <div><h3 id="mouse-ignore-acceleration-label">忽略滚动加速</h3></div>
          <p id="mouse-ignore-acceleration-help">按事件次数触发，避免快速滚动时触发量激增。100% 灵敏度下每条事件触发一次；不会过滤惯性产生的额外事件。</p>
        </div>
        <div className="settings-mouse-control">
          <button type="button" role="switch" aria-checked={mouseIgnoreScrollAcceleration}
            aria-labelledby="mouse-ignore-acceleration-label" aria-describedby="mouse-ignore-acceleration-help"
            className={`switch ${mouseIgnoreScrollAcceleration ? 'on' : ''}`}
            onClick={() => onMouseIgnoreScrollAccelerationChange(!mouseIgnoreScrollAcceleration)}><span /></button>
        </div>
      </section>
      <section className="settings-permission-row settings-mouse-row">
        <span className="settings-permission-icon"><RotateCcw size={18} /></span>
        <div className="settings-permission-copy">
          <div><h3><label htmlFor="mouse-scroll-sensitivity">滚动灵敏度</label></h3></div>
          <p id="mouse-scroll-sensitivity-help">调高可让轻微滚动更容易触发；调低可减少误触。适用于所有滚轮映射。</p>
        </div>
        <div className="settings-mouse-control">
          <div className="settings-sensitivity-control">
          <input id="mouse-scroll-sensitivity" type="range" min={25} max={400} step={25}
            style={{ '--sensitivity-progress': `${(mouseScrollSensitivity - 25) / 375 * 100}%` } as CSSProperties}
            aria-describedby="mouse-scroll-sensitivity-help" aria-valuetext={`${mouseScrollSensitivity}%`} value={mouseScrollSensitivity}
            onChange={(event) => {
              const value = Number(event.target.value)
              if (Number.isFinite(value)) onMouseScrollSensitivityChange(Math.max(25, Math.min(400, Math.round(value))))
            }} />
          <output htmlFor="mouse-scroll-sensitivity">{mouseScrollSensitivity}<span>%</span></output>
          </div>
          <div className="settings-control-caption"><span>低 · 25%</span><span>默认 100%</span><span>高 · 400%</span></div>
        </div>
      </section>
      {([
        { axis: 'vertical', label: '垂直滚轮触发间隔', directions: '向上、向下', value: mouseVerticalScrollIntervalMs, onChange: onMouseVerticalScrollIntervalMsChange },
        { axis: 'horizontal', label: '横向滚轮触发间隔', directions: '向左、向右', value: mouseHorizontalScrollIntervalMs, onChange: onMouseHorizontalScrollIntervalMsChange },
      ] as const).map(({ axis, label, directions, value, onChange }) => <section key={axis} className="settings-permission-row settings-mouse-row">
        <span className="settings-permission-icon"><RotateCcw size={18} /></span>
        <div className="settings-permission-copy">
          <div><h3><label htmlFor={`mouse-${axis}-interval`}>{label}</label></h3></div>
          <p id={`mouse-${axis}-interval-help`}>{directions}共用间隔。设为 100 毫秒时，每次触发后 100 毫秒内忽略同轴滚动，不补发；两轴独立计时。</p>
        </div>
        <div className="settings-mouse-control">
          <div className="settings-hold-control">
            <input id={`mouse-${axis}-interval`} className="behavior-delay-input" type="number" min={0} max={10000} step={10}
              aria-describedby={`mouse-${axis}-interval-help`} value={value}
              onChange={(event) => {
                const ms = Number(event.target.value)
                if (Number.isFinite(ms)) onChange(Math.max(0, Math.min(10000, Math.round(ms))))
              }} />
            <span>毫秒</span>
          </div>
          <div className="settings-control-caption"><span>默认 0 毫秒 · 不限制触发间隔</span></div>
        </div>
      </section>)}
      <section className="settings-permission-row settings-mouse-row">
        <span className="settings-permission-icon"><Keyboard size={18} /></span>
        <div className="settings-permission-copy">
          <div><h3><label htmlFor="mouse-key-hold-ms">按键保持时间</label></h3></div>
          <p id="mouse-key-hold-help">按下到松开的间隔。若按键或快捷键漏识别，可尝试 50 毫秒；数值越大，连续触发越慢。</p>
        </div>
        <div className="settings-mouse-control">
          <div className="settings-hold-control">
          <input id="mouse-key-hold-ms" className="behavior-delay-input" type="number" min={0} max={1000} step={1}
            aria-describedby="mouse-key-hold-help" value={mouseKeyHoldMs}
            onChange={(event) => {
              const value = Number(event.target.value)
              if (Number.isFinite(value)) onMouseKeyHoldMsChange(Math.max(0, Math.min(1000, Math.round(value))))
            }} />
          <span>毫秒</span>
          </div>
          <div className="settings-control-caption"><span>默认 0 毫秒 · 即时释放</span></div>
        </div>
      </section>
      </div>
    </section>}
      </div>
    </div>
  </div>
}
