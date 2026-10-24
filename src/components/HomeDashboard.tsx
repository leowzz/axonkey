import { ChevronRight, Command, FileText, Github, Keyboard, Monitor, RotateCcw } from 'lucide-react'
import type { ReactNode } from 'react'
import type { MacPermissions, Platform } from '../appTypes'
import type { DeviceId } from '../deviceModel'
import { openGitHub } from '../openGitHub'
import { MyDevicesPage, type DeviceOverviewItem } from './MyDevicesPage'
import './HomeDashboard.css'

type HomeStatusTone = 'ready' | 'warning' | 'error' | 'checking' | 'muted'

type HomeDashboardProps = {
  platform: Platform
  nativeRuntime: boolean
  systemProbeState: 'loading' | 'ready' | 'error'
  refreshing?: boolean
  permissions: MacPermissions
  inputAuthorizationStale: boolean
  devices: readonly DeviceOverviewItem[]
  onSelectDevice: (deviceId: DeviceId) => void
  onIntegrate: () => void
  onOpenPermissions: () => void
  onRefresh: () => void
  onOpenLogs: () => void
}

type HomeStatusRowProps = {
  icon: ReactNode
  title: string
  status: string
  detail: string
  tone: HomeStatusTone
  action?: ReactNode
}

function HomeStatusRow({ icon, title, status, detail, tone, action }: HomeStatusRowProps) {
  return <article className={`home-status-row ${tone}`}>
    <header className="home-status-heading">
      <span className="home-status-icon">{icon}</span>
      <h3>{title}</h3>
      <span className="home-status-label"><span className="home-status-dot" />{status}</span>
    </header>
    <p className="home-status-copy">{detail}</p>
    {action && <div className="home-status-tools">{action}</div>}
  </article>
}

export function HomeDashboard({
  platform,
  nativeRuntime,
  systemProbeState,
  refreshing = false,
  permissions,
  inputAuthorizationStale,
  devices,
  onSelectDevice,
  onIntegrate,
  onOpenPermissions,
  onRefresh,
  onOpenLogs,
}: HomeDashboardProps) {
  const macOS = platform === 'macos'
  const supported = macOS || platform === 'windows'
  // Windows probes describe individual device integration, not global permissions.
  const permissionsLoading = nativeRuntime && macOS && systemProbeState === 'loading'
  const permissionsFailed = nativeRuntime && macOS && systemProbeState === 'error'
  const refreshBusy = permissionsLoading || refreshing
  const canRefresh = nativeRuntime && supported && !refreshBusy
  const permissionPresentation = (granted: boolean, stale = false) => {
    if (!nativeRuntime) return { status: '浏览器预览', tone: 'muted' as const }
    if (permissionsLoading) return { status: '检测中', tone: 'checking' as const }
    if (permissionsFailed) return { status: '检测失败', tone: 'error' as const }
    if (stale) return { status: '需要重新授权', tone: 'warning' as const }
    return granted ? { status: '已授权', tone: 'ready' as const } : { status: '未授权', tone: 'warning' as const }
  }
  const permissionAction = (granted: boolean, stale = false) => {
    if (!nativeRuntime || permissionsLoading) return undefined
    if (permissionsFailed) return <button type="button" className="home-row-action" disabled={refreshBusy} onClick={onRefresh}>重新检测<ChevronRight size={13} /></button>
    if (!granted || stale) return <button type="button" className="home-row-action" onClick={onOpenPermissions}>{stale ? '重新授权' : '开始授权'}<ChevronRight size={13} /></button>
    return undefined
  }

  return <div className="home-page">
    <MyDevicesPage devices={devices} onSelect={onSelectDevice} onIntegrate={onIntegrate} />
    <aside className="home-permissions" aria-labelledby="home-permissions-title">
      <header className="home-permissions-heading">
        <div><h2 id="home-permissions-title">系统权限</h2><p>用于读取输入并执行映射。</p></div>
        <button type="button" className="home-refresh-button" disabled={!canRefresh} aria-label={refreshBusy ? '检测中' : '重新检测'} title={!nativeRuntime ? '请在桌面应用中检测' : refreshBusy ? '检测中' : '重新检测'} onClick={canRefresh ? onRefresh : undefined} aria-disabled={!canRefresh} aria-busy={refreshBusy}>
          <RotateCcw className={refreshBusy ? 'home-summary-loading-icon' : ''} size={15} />
        </button>
      </header>
      <div className="home-status-list">
        {macOS ? <>
          <HomeStatusRow
            icon={<Keyboard size={16} />}
            title="输入监控"
            {...permissionPresentation(permissions.inputMonitoring, inputAuthorizationStale)}
            detail={!nativeRuntime ? '请在桌面应用中检查权限。' : permissionsFailed ? '暂时无法确认当前权限，请重新检测。' : inputAuthorizationStale ? '当前应用的授权已失效，需要重新授予输入监控权限。' : '允许 Axonkey 读取设备输入。'}
            action={permissionAction(permissions.inputMonitoring, inputAuthorizationStale)}
          />
          <HomeStatusRow
            icon={<Command size={16} />}
            title="辅助功能"
            {...permissionPresentation(permissions.accessibility)}
            detail={!nativeRuntime ? '请在桌面应用中检查权限。' : permissionsFailed ? '暂时无法确认当前权限，请重新检测。' : '允许发送按键、快捷键与文本。'}
            action={permissionAction(permissions.accessibility)}
          />
        </> : <HomeStatusRow
          icon={<Monitor size={16} />}
          title="运行环境"
          status={!nativeRuntime ? '浏览器预览' : supported ? '桌面应用' : '暂不支持'}
          tone={!nativeRuntime || supported ? 'muted' : 'warning'}
          detail={!nativeRuntime ? '浏览器不能检测系统权限或执行输入映射。' : supported ? '请通过设备卡片查看接入状态并编辑映射。' : '当前平台暂不支持输入映射。'}
        />}
      </div>
      <button type="button" className="home-section-link" onClick={onOpenPermissions}>管理系统权限<ChevronRight size={15} /></button>
      {!nativeRuntime && <p className="home-permissions-note">浏览器预览无法检测或修改系统授权。</p>}
      <footer className="home-permissions-footer">
        <button type="button" className="home-log-button" disabled={!nativeRuntime} onClick={nativeRuntime ? onOpenLogs : undefined} title={!nativeRuntime ? '请在桌面应用中查看' : '打开日志目录'}><FileText size={14} />运行日志</button>
        <a href="https://github.com/leowzz/axonkey" onClick={openGitHub} target="_blank" rel="noopener noreferrer"><Github size={14} />GitHub</a>
      </footer>
    </aside>
  </div>
}
