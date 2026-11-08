import type { RefObject } from 'react'
import { ChevronRight, FileText, Info, LayoutGrid, Settings2, SlidersHorizontal, UserRound } from 'lucide-react'
import './AppBottomBar.css'

export type AppBottomBarProps = {
  activePanel: 'settings' | 'cloud' | 'about' | null
  workspaceName?: string
  workspaceStatus?: { label: string; tone: 'connected' | 'muted' | 'warning' }
  nativeRuntime: boolean
  hasUpdate: boolean
  settingsButtonRef?: RefObject<HTMLButtonElement>
  onOpenDevices: () => void
  onReturnToWorkspace: () => void
  onOpenSettings: () => void
  onOpenCloud: () => void
  onOpenLogs: () => void
  onOpenAbout: () => void
}

export function AppBottomBar({
  activePanel,
  workspaceName,
  workspaceStatus,
  nativeRuntime,
  hasUpdate,
  settingsButtonRef,
  onOpenDevices,
  onReturnToWorkspace,
  onOpenSettings,
  onOpenCloud,
  onOpenLogs,
  onOpenAbout,
}: AppBottomBarProps) {
  return (
    <footer className="app-bottom-bar" aria-label="应用底栏">
      <nav className="app-bottom-bar-context" aria-label="设备工作区">
        <button
          type="button"
          className={`app-bottom-bar-button${!workspaceName && !activePanel ? ' app-bottom-bar-button-active' : ''}`}
          aria-label="设备"
          aria-current={!workspaceName && !activePanel ? 'page' : undefined}
          title="设备"
          onClick={onOpenDevices}
        >
          <LayoutGrid size={15} strokeWidth={1.8} aria-hidden="true" />
          <span>设备</span>
        </button>
        {workspaceName && (
          <>
            <ChevronRight className="app-bottom-bar-chevron" size={13} aria-hidden="true" />
            <button
              type="button"
              className={`app-bottom-bar-button app-bottom-bar-workspace${!activePanel ? ' app-bottom-bar-button-active' : ''}`}
              aria-label={workspaceName}
              aria-current={!activePanel ? 'page' : undefined}
              title={workspaceName}
              onClick={onReturnToWorkspace}
            >
              <SlidersHorizontal size={15} strokeWidth={1.8} aria-hidden="true" />
              <span className="app-bottom-bar-workspace-name">{workspaceName}</span>
            </button>
            {workspaceStatus && (
              <span className={`app-bottom-bar-status app-bottom-bar-status-${workspaceStatus.tone}`}>
                <span className="app-bottom-bar-status-dot" aria-hidden="true" />
                {workspaceStatus.label}
              </span>
            )}
          </>
        )}
      </nav>
      <nav className="app-bottom-bar-tools" aria-label="全局工具">
        <button
          ref={settingsButtonRef}
          type="button"
          className={`app-bottom-bar-button${activePanel === 'settings' ? ' app-bottom-bar-button-active' : ''}`}
          aria-label="设置"
          aria-current={activePanel === 'settings' ? 'page' : undefined}
          title="设置"
          onClick={onOpenSettings}
        >
          <Settings2 size={15} strokeWidth={1.8} aria-hidden="true" />
          <span>设置</span>
        </button>
        <button
          type="button"
          className={`app-bottom-bar-button${activePanel === 'cloud' ? ' app-bottom-bar-button-active' : ''}`}
          aria-label="账号与同步"
          aria-current={activePanel === 'cloud' ? 'page' : undefined}
          title="账号与同步"
          onClick={onOpenCloud}
        >
          <UserRound size={15} strokeWidth={1.8} aria-hidden="true" />
          <span>账号</span>
        </button>
        <button
          type="button"
          className="app-bottom-bar-button"
          aria-label="运行日志"
          title={nativeRuntime ? '打开日志目录' : '请在桌面应用中查看'}
          disabled={!nativeRuntime}
          onClick={onOpenLogs}
        >
          <FileText size={15} strokeWidth={1.8} aria-hidden="true" />
          <span>日志</span>
        </button>
        <button
          type="button"
          className={`app-bottom-bar-button${activePanel === 'about' ? ' app-bottom-bar-button-active' : ''}`}
          aria-label={hasUpdate ? '关于，有新版本可用' : '关于'}
          aria-current={activePanel === 'about' ? 'page' : undefined}
          title={hasUpdate ? '关于 · 发现新版本' : '关于'}
          onClick={onOpenAbout}
        >
          <Info size={15} strokeWidth={1.8} aria-hidden="true" />
          <span>关于</span>
          {hasUpdate && <span className="app-bottom-bar-update-dot" aria-hidden="true" />}
        </button>
      </nav>
    </footer>
  )
}
