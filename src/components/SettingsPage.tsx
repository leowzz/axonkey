import { Command, ExternalLink, Info, Keyboard, RotateCcw, ShieldCheck } from 'lucide-react'
import { AutostartControl } from './AutostartControl'
import type { MacPermissionKind, MacPermissions, Platform } from '../appTypes'
import type { SetupState } from '../setupModel'

type SettingsPageProps = {
  platform: Platform
  nativeRuntime: boolean
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

export function SettingsPage({ platform, nativeRuntime, mouseKeyHoldMs, onMouseKeyHoldMsChange, systemProbeState, permissions, inputAuthorizationStale, inputDriver, onRequestPermission, onOpenSettings, onRefresh, onOpenDriver }: SettingsPageProps) {
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
      <button type="button" className="dialog-secondary" disabled={!nativeRuntime || loading || platform === 'unsupported'} onClick={onRefresh}><RotateCcw size={14} />{loading ? '检测中' : '重新检测'}</button>
    </header>
    <AutostartControl supported={nativeRuntime && (platform === 'macos' || platform === 'windows')} />
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
    {(platform === 'windows' || platform === 'macos') && <>
      <h3 className="settings-section-title">鼠标映射</h3>
      <section className="settings-permission-row">
        <span className="settings-permission-icon"><Keyboard size={18} /></span>
        <div className="settings-permission-copy">
          <div><h3><label htmlFor="mouse-key-hold-ms">鼠标映射按键保持时间</label></h3></div>
          <p id="mouse-key-hold-help">按键按下到松开的时间，自动保存。默认 0 毫秒，适合快速滚动；若目标应用漏识别按键，可尝试 50 毫秒。数值越大，连续触发越慢。仅影响鼠标映射输出的按键和快捷键。</p>
        </div>
        <div className="behavior-delay-row">
          <input id="mouse-key-hold-ms" className="behavior-delay-input" type="number" min={0} max={1000} step={1}
            aria-describedby="mouse-key-hold-help" value={mouseKeyHoldMs}
            onChange={(event) => {
              const value = Number(event.target.value)
              if (Number.isFinite(value)) onMouseKeyHoldMsChange(Math.max(0, Math.min(1000, Math.round(value))))
            }} />
          <span>毫秒</span>
        </div>
      </section>
    </>}
  </div>
}
