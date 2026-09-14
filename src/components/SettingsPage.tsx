import { Check, Command, ExternalLink, Info, Keyboard, RotateCcw, ShieldCheck } from 'lucide-react'
import { AutostartControl } from './AutostartControl'
import type { MacPermissionKind, MacPermissions, Platform } from '../appTypes'
import type { SetupState } from '../setupModel'

type SettingsPageProps = {
  platform: Platform
  nativeRuntime: boolean
  systemProbeState: 'loading' | 'ready' | 'error'
  permissions: MacPermissions
  inputAuthorizationStale: boolean
  inputDriver: SetupState['drivers']['input']
  onRequestPermission: (kind: MacPermissionKind) => void
  onOpenSettings: (kind: MacPermissionKind) => void
  onRefresh: () => void
  onOpenDriver: () => void
}

export function SettingsPage({ platform, nativeRuntime, systemProbeState, permissions, inputAuthorizationStale, inputDriver, onRequestPermission, onOpenSettings, onRefresh, onOpenDriver }: SettingsPageProps) {
  const loading = systemProbeState === 'loading'
  const failed = systemProbeState === 'error'
  const items = [
    { kind: 'inputMonitoring' as const, title: '输入监控', description: '读取 RC003 遥控器的按键，让自定义映射能够响应。', granted: permissions.inputMonitoring && !inputAuthorizationStale, stale: inputAuthorizationStale, icon: <Keyboard size={18} /> },
    { kind: 'accessibility' as const, title: '辅助功能', description: '发送映射后的按键、快捷键和文本。', granted: permissions.accessibility, stale: false, icon: <Command size={18} /> },
  ]
  const grantedCount = items.filter((item) => item.granted).length
  return <div className="settings-page">
    <header className="settings-page-head">
      <div><h2>设置</h2><p>管理 Axonkey 的启动方式和系统权限。</p></div>
      <button type="button" className="dialog-secondary" disabled={!nativeRuntime || loading || platform === 'unsupported'} onClick={onRefresh}><RotateCcw size={14} />{loading ? '检测中' : '重新检测'}</button>
    </header>
    <AutostartControl supported={nativeRuntime && (platform === 'macos' || platform === 'windows')} />
    <h3 className="settings-section-title">系统权限</h3>
    {!nativeRuntime && <p className="permission-drag-note"><Info size={17} />浏览器预览无法检测或更改系统权限，请在桌面版中操作。</p>}
    {platform === 'macos' ? <>
      <div className={`permission-progress-summary ${nativeRuntime && !loading && !failed && grantedCount === 2 ? 'ready' : ''}`} aria-live="polite">
        <span className="permission-progress-icon"><ShieldCheck size={24} /></span>
        <div><strong>{!nativeRuntime ? '等待桌面版检测' : loading ? '正在检测权限' : failed ? '权限检测失败' : grantedCount === 2 ? '系统权限已就绪' : `已完成 ${grantedCount} / 2 项授权`}</strong><span>{failed ? '请重新检测以获取最新的授权状态。' : '授权后返回应用，状态会自动刷新。'}</span></div>
      </div>
      <div className="mac-permission-list">
        {items.map((item, index) => {
          const known = nativeRuntime && !loading && !failed
          const granted = known && item.granted
          return <section key={item.kind} className={`mac-permission-step ${granted ? 'granted' : ''}`}>
            <div className="permission-step-number">{granted ? <Check size={16} /> : index + 1}</div>
            <span className="permission-step-icon">{item.icon}</span>
            <div className="permission-step-copy"><div><h3>{item.title}</h3><span className="permission-status-label">{!nativeRuntime ? '未检测' : loading ? '检测中' : failed ? '检测失败' : item.stale ? '需要重新授权' : granted ? '已授权' : '未授权'}</span></div><p>{item.description}</p></div>
            <button type="button" className="dialog-secondary" disabled={!nativeRuntime || loading} onClick={() => granted ? onOpenSettings(item.kind) : onRequestPermission(item.kind)}>{granted ? '打开设置' : item.stale ? '重新授权' : '开始授权'}<ExternalLink size={14} /></button>
          </section>
        })}
      </div>
      {grantedCount < 2 && <div className="permission-drag-note"><Info size={17} /><div><strong>{inputAuthorizationStale ? '需要重新授权当前应用' : '系统列表中没有 Axonkey？'}</strong><span>{inputAuthorizationStale ? inputDriver.message ?? '当前应用的输入监控授权已失效，请重新授权后再使用按键映射。' : '点击开始授权后，可通过授权小窗在 Finder 中定位应用，再将 Axonkey.app 拖入系统设置列表。'}</span></div></div>}
    </> : platform === 'windows' ? <section className="settings-platform-note"><ShieldCheck size={28} /><h3>Windows 输入服务</h3><p>按键映射通过输入驱动运行，需要安装驱动并在系统提示时授予管理员权限。</p><p>驱动状态：{!nativeRuntime ? '未检测' : loading ? '检测中' : failed ? '检测失败' : inputDriver.status === 'installed' ? '已安装' : inputDriver.status === 'restartRequired' ? '需要重启' : '需要检查'}</p><button type="button" className="dialog-secondary" onClick={onOpenDriver}>打开驱动设置</button></section>
      : <section className="settings-platform-note"><Info size={28} /><h3>当前系统暂不支持</h3><p>请在 macOS 或 Windows 桌面版中配置系统权限。</p></section>}
  </div>
}
