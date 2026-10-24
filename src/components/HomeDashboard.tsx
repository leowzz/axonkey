import { openGitHub } from '../openGitHub'
import {
  Check,
  CheckCircle2,
  ChevronRight,
  Command,
  FileText,
  Github,
  Keyboard,
  LayoutGrid,
  Monitor,
  RotateCcw,
  Settings2,
  ShieldAlert,
} from 'lucide-react'
import type { MacPermissions, Platform } from '../appTypes'
import type { ReactNode } from 'react'
import './HomeDashboard.css'

type HomeStatusTone = 'ready' | 'warning' | 'error' | 'checking' | 'muted'

type HomeDashboardProps = {
  platform: Platform
  nativeRuntime: boolean
  systemProbeState: 'loading' | 'ready' | 'error'
  refreshing?: boolean
  permissions: MacPermissions
  inputAuthorizationStale: boolean
  enabled: boolean
  onOpenPermissions: () => void
  onRefresh: () => void
  onOpenDevices: () => void
  onOpenSettings: () => void
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
  enabled,
  onOpenPermissions,
  onRefresh,
  onOpenDevices,
  onOpenSettings,
  onOpenLogs,
}: HomeDashboardProps) {
  const macOS = platform === 'macos'
  const supported = macOS || platform === 'windows'
  // The Windows system probe describes individual device integration, not global permissions.
  const permissionsLoading = nativeRuntime && macOS && systemProbeState === 'loading'
  const permissionsFailed = nativeRuntime && macOS && systemProbeState === 'error'
  const permissionsReady = permissions.inputMonitoring && permissions.accessibility && !inputAuthorizationStale
  const refreshBusy = permissionsLoading || refreshing
  const canRefresh = nativeRuntime && supported && !refreshBusy
  const heroTone: HomeStatusTone = !nativeRuntime || !enabled ? 'muted'
    : !supported ? 'warning' : permissionsLoading ? 'checking' : permissionsFailed ? 'error'
      : macOS && !permissionsReady ? 'warning' : 'ready'
  const heroTitle = !nativeRuntime ? '浏览器预览'
    : !enabled ? '软件功能已暂停'
      : !supported ? '当前平台暂不支持'
        : platform === 'windows' ? '自定义功能已启用'
          : permissionsLoading ? '正在检测运行环境'
            : permissionsFailed ? '运行环境检测失败'
              : !permissionsReady ? '需要完成授权' : '运行环境已就绪'
  const heroDescription = !nativeRuntime ? '可编辑配置，实际输入映射请使用桌面应用。'
    : !enabled ? '配置仍会保存；打开左下角的软件总开关后，自定义映射才会生效。'
      : !supported ? '当前平台暂不支持输入映射，可以继续查看设备配置。'
        : platform === 'windows' ? '软件总开关已开启。请在“我的设备”中完成设备接入并管理各自的映射。'
          : permissionsLoading ? '正在检查输入监控与辅助功能权限。'
            : permissionsFailed ? '暂时无法确认系统权限，请重新检测；仍有问题时可查看运行日志。'
              : !permissionsReady ? '请完成输入监控与辅助功能授权，让 Axonkey 读取输入并执行自定义映射。'
                : '系统权限已就绪，软件总开关已开启。请到“我的设备”管理设备和映射。'
  const SummaryIcon = heroTone === 'ready' ? CheckCircle2 : heroTone === 'warning' || heroTone === 'error' ? ShieldAlert : Monitor

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
    <header className="home-page-heading">
      <div><h1>控制中心</h1><p>管理运行状态与系统权限</p></div>
      <button type="button" className="home-refresh-button" disabled={!canRefresh} aria-label={refreshBusy ? '检测中' : '重新检测'} title={!nativeRuntime ? '请在桌面应用中检测' : refreshBusy ? '检测中' : '重新检测'} onClick={canRefresh ? onRefresh : undefined} aria-disabled={!canRefresh} aria-busy={refreshBusy}>
        <RotateCcw className={refreshBusy ? 'home-summary-loading-icon' : ''} size={15} />{refreshBusy ? '检测中' : '重新检测'}
      </button>
    </header>

    <div className="home-dashboard-grid">
      <section className={`home-overview-card ${heroTone}`} aria-labelledby="home-status-title">
        <div className="home-overview-top">
          <span>应用状态</span>
          <div className={`home-feature-state ${enabled ? 'enabled' : 'paused'}`}><span>软件功能</span><strong>{enabled ? '已开启' : '已暂停'}</strong></div>
        </div>
        <div className="home-overview-visual" aria-hidden="true"><span className="home-summary-icon"><SummaryIcon size={40} /></span></div>
        <div className="home-summary-copy">
          <h2 id="home-status-title">{heroTitle}</h2>
          <p>{heroDescription}</p>
        </div>
        <button type="button" className="home-device-action" onClick={onOpenDevices}><LayoutGrid size={17} />打开我的设备<ChevronRight size={17} /></button>
      </section>

      <section className="home-permissions" aria-labelledby="home-permissions-title">
        <header className="home-section-head">
          <h2 id="home-permissions-title">权限与访问</h2>
          <p>系统授权决定输入与执行能力。</p>
        </header>
        <div className="home-status-list">
          {macOS ? <>
            <HomeStatusRow
              icon={<Keyboard size={18} />}
              title="输入监控"
              {...permissionPresentation(permissions.inputMonitoring, inputAuthorizationStale)}
              detail={!nativeRuntime ? '请在桌面应用中检查权限。' : permissionsFailed ? '暂时无法确认当前权限，请重新检测。' : inputAuthorizationStale ? '当前应用的授权已失效，需要重新授予输入监控权限。' : '允许 Axonkey 读取设备输入，用于自定义映射。'}
              action={permissionAction(permissions.inputMonitoring, inputAuthorizationStale)}
            />
            <HomeStatusRow
              icon={<Command size={18} />}
              title="辅助功能"
              {...permissionPresentation(permissions.accessibility)}
              detail={!nativeRuntime ? '请在桌面应用中检查权限。' : permissionsFailed ? '暂时无法确认当前权限，请重新检测。' : '允许 Axonkey 发送映射后的按键、快捷键与文本。'}
              action={permissionAction(permissions.accessibility)}
            />
          </> : <HomeStatusRow
            icon={<Monitor size={18} />}
            title="运行环境"
            status={!nativeRuntime ? '浏览器预览' : supported ? '桌面应用' : '暂不支持'}
            tone={!nativeRuntime || supported ? 'muted' : 'warning'}
            detail={!nativeRuntime ? '浏览器不能检测系统权限或执行输入映射。' : supported ? '设备接入与可用功能请在“我的设备”中查看。' : '当前平台暂不支持输入映射。'}
          />}
        </div>
        <button type="button" className="home-section-link" onClick={onOpenPermissions}>管理系统权限<ChevronRight size={15} /></button>
      </section>
    </div>

    <section className="home-utilities" aria-label="常用入口">
      <button type="button" className="home-quick-button" onClick={onOpenSettings}>
        <span className="home-quick-icon"><Settings2 size={17} /></span>
        <span><strong>设置</strong><small>启动偏好与功能设置</small></span>
        <ChevronRight size={15} />
      </button>
      <button type="button" className="home-quick-button" disabled={!nativeRuntime} onClick={nativeRuntime ? onOpenLogs : undefined} aria-disabled={!nativeRuntime}>
        <span className="home-quick-icon"><FileText size={17} /></span>
        <span><strong>运行日志</strong><small>{nativeRuntime ? '打开日志目录' : '请在桌面应用中查看'}</small></span>
        <ChevronRight size={15} />
      </button>
    </section>
    <footer className="home-footer">
      <div className="home-local-note"><Check size={14} aria-hidden="true" /><span>配置保存在本机</span></div>
      <a href="https://github.com/leowzz/axonkey" onClick={openGitHub} target="_blank" rel="noopener noreferrer"><Github size={15} aria-hidden="true" />GitHub</a>
    </footer>
  </div>
}
