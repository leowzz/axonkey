import type { CSSProperties } from 'react'
import { Bluetooth, ExternalLink, Info, Mouse, Power, Radio, RotateCcw, ShieldCheck } from 'lucide-react'
import { SettingsHelp } from './SettingsHelp'
import { AutostartControl } from './AutostartControl'
import { WindowsAudioEndpointControl } from './WindowsAudioEndpointControl'
import type { AudioProbe, MacPermissionKind, MacPermissions, Platform, WindowsAudioOutput } from '../appTypes'
import type { DriverActionKind, SetupState } from '../setupModel'

export type SettingsSection = 'startup' | 'permissions' | 'remote' | 'mouse'

type SettingsPageProps = {
  section: SettingsSection
  onSectionChange: (section: SettingsSection) => void
  platform: Platform
  nativeRuntime: boolean
  showRemoteKeyGrid: boolean
  onShowRemoteKeyGridChange: (value: boolean) => void
  mouseIgnoreScrollAcceleration: boolean
  onMouseIgnoreScrollAccelerationChange: (value: boolean) => void
  mouseScrollSensitivity: number
  onMouseScrollSensitivityChange: (value: number) => void
  mouseVerticalScrollIntervalMs: number
  onMouseVerticalScrollIntervalMsChange: (ms: number) => void
  mouseHorizontalScrollIntervalMs: number
  onMouseHorizontalScrollIntervalMsChange: (ms: number) => void
  mouseEdgeWidth: number
  onMouseEdgeWidthChange: (value: number) => void
  mouseKeyHoldMs: number
  onMouseKeyHoldMsChange: (ms: number) => void
  systemProbeState: 'loading' | 'ready' | 'error'
  permissions: MacPermissions
  inputAuthorizationStale: boolean
  inputDriver: SetupState['drivers']['input']
  audioDriver: SetupState['drivers']['audio']
  audioProbe?: AudioProbe | null
  onAudioProbeChange: (probe: AudioProbe) => void
  onAudioOutputChange: (output: WindowsAudioOutput) => void
  onAudioAction: (action: DriverActionKind) => void
  audioRestarting: boolean
  audioRestartError: string
  onRestartAudio: () => void
  onProbeAudio: () => void
  onOpenSound: () => void
  device: SetupState['device']
  onOpenBluetooth: () => void
  onCheckDevice: () => void
  onRequestPermission: (kind: MacPermissionKind) => void
  onOpenSettings: (kind: MacPermissionKind) => void
  onRefresh: () => void
  onOpenDriver: () => void
}

export function SettingsPage({ section, onSectionChange, platform, nativeRuntime, mouseEdgeWidth, onMouseEdgeWidthChange, showRemoteKeyGrid, onShowRemoteKeyGridChange, mouseIgnoreScrollAcceleration, onMouseIgnoreScrollAccelerationChange, mouseScrollSensitivity, onMouseScrollSensitivityChange, mouseVerticalScrollIntervalMs, onMouseVerticalScrollIntervalMsChange, mouseHorizontalScrollIntervalMs, onMouseHorizontalScrollIntervalMsChange, mouseKeyHoldMs, onMouseKeyHoldMsChange, systemProbeState, permissions, inputAuthorizationStale, inputDriver, audioDriver, audioProbe, onAudioProbeChange, onAudioOutputChange, onAudioAction, audioRestarting, audioRestartError, onRestartAudio, onProbeAudio, onOpenSound, device, onOpenBluetooth, onCheckDevice, onRequestPermission, onOpenSettings, onRefresh, onOpenDriver }: SettingsPageProps) {
  const supportsMouse = platform === 'windows' || platform === 'macos'
  const currentSection = section === 'mouse' && !supportsMouse ? 'startup' : section
  const sections = [
    { id: 'startup' as const, label: '启动设置', icon: <Power size={16} /> },
    { id: 'permissions' as const, label: '设备与权限', icon: <ShieldCheck size={16} /> },
    { id: 'remote' as const, label: '遥控器映射', icon: <Radio size={16} /> },
    ...(supportsMouse ? [{ id: 'mouse' as const, label: '鼠标映射', icon: <Mouse size={16} /> }] : []),
  ]
  const loading = systemProbeState === 'loading'
  const failed = systemProbeState === 'error'
  const items = [
    { kind: 'inputMonitoring' as const, title: '输入监控', description: '读取 RC003 遥控器的按键，让自定义映射能够响应。', granted: permissions.inputMonitoring && !inputAuthorizationStale, stale: inputAuthorizationStale },
    { kind: 'accessibility' as const, title: '辅助功能', description: '发送映射后的按键、快捷键和文本。', granted: permissions.accessibility, stale: false },
  ]
  const audioInstalled = audioDriver.status === 'installed' || audioDriver.status === 'restartRequired'
  const audioBusy = audioRestarting || audioDriver.action.status === 'running' || audioDriver.status === 'checking'
  const audioStatus = !nativeRuntime ? '未检测' : audioRestarting ? '重启中…' : audioDriver.action.status === 'running' ? '等待授权…' : ({ unknown: '未检测', checking: '检测中', missing: '未安装', installed: '已安装', restartRequired: '需要重启', error: '操作失败' })[audioDriver.status]
  const audioError = audioRestartError || audioDriver.action.error || (audioDriver.status === 'error' ? audioDriver.message : undefined)
  const deviceBusy = device.status === 'checking' || device.status === 'connecting'
  const deviceStatus = !nativeRuntime ? '未检测' : ({ unknown: '未检测', checking: '检测中', disconnected: '未连接', connecting: '连接中', connected: '已连接', unsupported: '暂不支持', error: '检测失败' })[device.status]
  const grantedCount = items.filter((item) => item.granted).length
  return <div className="settings-page settings-form-page">
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
    <div className="settings-permissions-heading">
      <h3 className="settings-section-title">设备与权限</h3>
      <button type="button" className="settings-refresh" aria-label={loading ? '正在检测系统权限' : '重新检测系统权限'}
        title={loading ? '检测中' : '重新检测'} aria-busy={loading}
        disabled={!nativeRuntime || loading || platform === 'unsupported'} onClick={onRefresh}><RotateCcw size={14} /></button>
    </div>
    {!nativeRuntime && <p className="permission-drag-note"><Info size={17} />浏览器预览无法检测或更改系统权限，请在桌面版中操作。</p>}
    {platform === 'macos' ? <>
      <div className="settings-form-fields">
        {items.map((item) => {
          const known = nativeRuntime && !loading && !failed
          const granted = known && item.granted
          return <section key={item.kind} className="settings-form-row" aria-labelledby={`permission-label-${item.kind}`}>
            <span id={`permission-label-${item.kind}`} className="settings-form-label">{item.title}：</span>
            <div className="settings-form-control">
              <span className={`settings-permission-status ${granted ? 'granted' : ''}`} aria-live="polite">{!nativeRuntime ? '未检测' : loading ? '检测中' : failed ? '检测失败' : item.stale ? '需要重新授权' : granted ? '已授权' : '未授权'}</span>
              <button type="button" className="dialog-secondary" disabled={!nativeRuntime || loading} onClick={() => granted ? onOpenSettings(item.kind) : onRequestPermission(item.kind)}>{granted ? '打开设置' : item.stale ? '重新授权' : '开始授权'}<ExternalLink size={14} /></button>
              <SettingsHelp id={`permission-help-${item.kind}`} label={item.title}>{item.description}</SettingsHelp>
            </div>
          </section>
        })}
        <section className="settings-form-row" aria-labelledby="settings-audio-label">
          <span id="settings-audio-label" className="settings-form-label">虚拟麦克风：</span>
          <div className="settings-form-control">
            <span>MiRemoteV 2ch</span>
            <span className={`settings-permission-status ${nativeRuntime && audioInstalled && !audioBusy ? 'granted' : ''}`} aria-live="polite">{audioStatus}</span>
            <button type="button" className={`dialog-secondary ${audioInstalled ? 'danger' : ''}`} disabled={!nativeRuntime || audioBusy} onClick={() => onAudioAction(audioInstalled ? 'uninstall' : 'install')}>{audioInstalled ? '卸载' : '安装驱动'}</button>
            <button type="button" className="dialog-secondary" disabled={!nativeRuntime || !audioInstalled || audioBusy} aria-busy={audioRestarting} onClick={onRestartAudio}>{audioRestarting ? '重启中…' : '重启驱动'}</button>
            <button type="button" className="dialog-secondary" disabled={!nativeRuntime || audioBusy} onClick={onProbeAudio}><RotateCcw size={14} />重新检测</button>
            <button type="button" className="dialog-secondary" disabled={!nativeRuntime || audioBusy} onClick={onOpenSound}>声音设置<ExternalLink size={14} /></button>
            <SettingsHelp id="settings-audio-help" label="虚拟麦克风">将 RC003 遥控器语音转发给语音输入法等应用。安装驱动后，还需在应用中选择 MiRemoteV 2ch 作为麦克风。切换声音设备后若没有声音，可点击“重启驱动”重新连接虚拟麦克风和遥控器；当前语音会中断，请连接恢复后再试。</SettingsHelp>
          </div>
        </section>
        <div className="settings-form-row">
          <span className="settings-form-label">语音输入法：</span>
          <div className="settings-form-control">
            <span>麦克风请选择 MiRemoteV 2ch</span>
            <SettingsHelp id="settings-audio-input-help" label="语音输入法麦克风设置">豆包输入法：设置 → 语音输入 → 麦克风选择 → MiRemoteV 2ch。其他语音输入法请在各自的音频设置中选择此设备。</SettingsHelp>
          </div>
        </div>
      </div>
      {nativeRuntime && audioError && <div className="permission-drag-note" role="alert"><Info size={17} /><div><strong>虚拟麦克风需要处理</strong><span>{audioError}</span></div></div>}
      {grantedCount < 2 && <div className="permission-drag-note"><Info size={17} /><div><strong>{inputAuthorizationStale ? '需要重新授权当前应用' : '系统列表中没有 Axonkey？'}</strong><span>{inputAuthorizationStale ? inputDriver.message ?? '当前应用的输入监控授权已失效，请重新授权后再使用按键映射。' : '点击开始授权后，可通过授权小窗在 Finder 中定位应用，再将 Axonkey.app 拖入系统设置列表。'}</span></div></div>}
    </> : platform === 'windows' ? <>
      <div className="settings-form-fields"><section className="settings-form-row">
        <span className="settings-form-label">Windows 输入服务：</span>
        <div className="settings-form-control"><span>{!nativeRuntime ? '未检测' : loading ? '检测中' : failed ? '检测失败' : inputDriver.status === 'installed' ? '已安装' : inputDriver.status === 'restartRequired' ? '需要重启' : '需要检查'}</span><button type="button" className="dialog-secondary" disabled={!nativeRuntime} onClick={onOpenDriver}>打开驱动设置</button><SettingsHelp id="windows-input-help" label="Windows 输入服务">按键映射通过输入驱动运行，需要安装驱动并在系统提示时授予管理员权限。</SettingsHelp></div>
      </section></div>
      <WindowsAudioEndpointControl supported={nativeRuntime} output={audioProbe?.output} driverBusy={audioBusy} driverError={audioDriver.action.error} onProbeChange={onAudioProbeChange} onOutputChange={onAudioOutputChange} onInstall={() => onAudioAction('install')} onOpenSound={onOpenSound} />
    </>
      : <section className="settings-platform-note"><Info size={28} /><h3>当前系统暂不支持</h3><p>请在 macOS 或 Windows 桌面版中配置系统权限。</p></section>}
    {(platform === 'macos' || platform === 'windows') && <div className="settings-form-fields">
      <section className="settings-form-row" aria-labelledby="settings-device-label">
        <span id="settings-device-label" className="settings-form-label">设备连接：</span>
        <div className="settings-form-control">
          <span>RC003</span>
          <span className={`settings-permission-status ${nativeRuntime && device.status === 'connected' ? 'granted' : ''}`} aria-live="polite">{deviceStatus}</span>
          <button type="button" className="dialog-secondary" disabled={!nativeRuntime} onClick={onOpenBluetooth}><Bluetooth size={14} />打开蓝牙设置</button>
          <button type="button" className="dialog-secondary" disabled={!nativeRuntime || deviceBusy} onClick={onCheckDevice}><RotateCcw size={14} />重新检测</button>
          <SettingsHelp id="settings-device-help" label="连接 RC003">先在系统蓝牙设置中配对小米遥控器 RC003，再按任意按键唤醒，然后返回这里重新检测。</SettingsHelp>
        </div>
      </section>
    </div>}
    </section>
    <section id="settings-panel-remote" aria-labelledby="settings-nav-remote" hidden={currentSection !== 'remote'}>
      <div className="settings-mouse-heading"><h3 className="settings-section-title">遥控器映射</h3><span>更改自动保存</span></div>
      <div className="settings-form-fields">
        <div className="settings-form-row">
          <span className="settings-form-label">按键列表：</span>
          <div className="settings-form-control">
            <label className="settings-checkbox"><input type="checkbox" checked={showRemoteKeyGrid} onChange={(event) => onShowRemoteKeyGridChange(event.target.checked)} />显示遥控器按键列表</label>
            <SettingsHelp id="remote-key-grid-help" label="显示遥控器按键列表">默认开启。在映射页顶部显示所有遥控器按键；关闭后仍可通过左侧遥控器图选择按键。</SettingsHelp>
          </div>
        </div>
      </div>
    </section>
    {supportsMouse && <section id="settings-panel-mouse" aria-labelledby="settings-nav-mouse" hidden={currentSection !== 'mouse'}>
      <div className="settings-mouse-heading"><h3 className="settings-section-title">鼠标映射</h3><span>更改自动保存</span></div>
      <div className="settings-form-fields">
        <div className="settings-form-row">
          <span className="settings-form-label">滚动加速：</span>
          <div className="settings-form-control">
            <label className="settings-checkbox"><input type="checkbox" checked={mouseIgnoreScrollAcceleration} onChange={(event) => onMouseIgnoreScrollAccelerationChange(event.target.checked)} />忽略滚动加速</label>
            <SettingsHelp id="mouse-ignore-acceleration-help" label="忽略滚动加速">按事件次数触发，避免快速滚动时触发量激增。100% 灵敏度下每条事件触发一次；不会过滤惯性产生的额外事件。默认开启。</SettingsHelp>
          </div>
        </div>
        <div className="settings-form-row">
          <label className="settings-form-label" htmlFor="mouse-scroll-sensitivity">滚动灵敏度：</label>
          <div className="settings-form-control">
            <div className="settings-sensitivity-control">
              <input id="mouse-scroll-sensitivity" type="range" min={25} max={400} step={25}
                style={{ '--sensitivity-progress': `${(mouseScrollSensitivity - 25) / 375 * 100}%` } as CSSProperties}
                aria-valuetext={`${mouseScrollSensitivity}%`} value={mouseScrollSensitivity}
                onChange={(event) => onMouseScrollSensitivityChange(Number(event.target.value))} />
              <output htmlFor="mouse-scroll-sensitivity">{mouseScrollSensitivity}<span>%</span></output>
            </div>
            <SettingsHelp id="mouse-scroll-sensitivity-help" label="滚动灵敏度">调高可让轻微滚动更容易触发；调低可减少误触。适用于所有滚轮映射。范围 25%–400%，默认 100%。</SettingsHelp>
          </div>
        </div>
        <div className="settings-form-row">
          <label className="settings-form-label" htmlFor="mouse-edge-width">边缘生效宽度：</label>
          <div className="settings-form-control">
            <input id="mouse-edge-width" className="settings-number" type="number" min={1} max={100} step={1} value={mouseEdgeWidth}
              onChange={(event) => { const value = Number(event.target.value); if (Number.isFinite(value)) onMouseEdgeWidthChange(Math.max(1, Math.min(100, Math.round(value)))) }} />
            <span>px</span>
            <SettingsHelp id="mouse-edge-width-help" label="边缘生效宽度">顶部、左侧和右侧边缘共用，适用于滚动和鼠标按键映射。范围 1–100，默认 8。按屏幕坐标计算：Windows 为像素，macOS 为点；顶部角落优先使用上边缘规则。</SettingsHelp>
          </div>
        </div>
        {([
          { id: 'vertical-interval', label: '垂直触发间隔', value: mouseVerticalScrollIntervalMs, max: 10000, step: 10, onChange: onMouseVerticalScrollIntervalMsChange, help: '向上、向下共用间隔。设为 100 毫秒时，每次触发后 100 毫秒内忽略同轴滚动，不补发；两轴独立计时。默认 50 毫秒；设为 0 时不限制触发间隔。' },
          { id: 'horizontal-interval', label: '横向触发间隔', value: mouseHorizontalScrollIntervalMs, max: 10000, step: 10, onChange: onMouseHorizontalScrollIntervalMsChange, help: '向左、向右共用间隔。设为 100 毫秒时，每次触发后 100 毫秒内忽略同轴滚动，不补发；两轴独立计时。默认 50 毫秒；设为 0 时不限制触发间隔。' },
          { id: 'key-hold-ms', label: '按键保持时间', value: mouseKeyHoldMs, max: 1000, step: 1, onChange: onMouseKeyHoldMsChange, help: '按下到松开的间隔。若按键或快捷键漏识别，可尝试 50 毫秒；数值越大，连续触发越慢。默认 10 毫秒；设为 0 时即时释放。' },
        ] as const).map(({ id, label, value, max, step, onChange, help }) => <div key={id} className="settings-form-row">
          <label className="settings-form-label" htmlFor={`mouse-${id}`}>{label}：</label>
          <div className="settings-form-control">
            <input id={`mouse-${id}`} className="settings-number" type="number" min={0} max={max} step={step} value={value}
              onChange={(event) => { const ms = Number(event.target.value); if (Number.isFinite(ms)) onChange(Math.max(0, Math.min(max, Math.round(ms)))) }} />
            <span>毫秒</span>
            <SettingsHelp id={`mouse-${id}-help`} label={label}>{help}</SettingsHelp>
          </div>
        </div>)}
      </div>
    </section>}
      </div>
    </div>
  </div>
}
