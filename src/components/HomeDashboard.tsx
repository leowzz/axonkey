import type { ReactNode } from 'react'
import { ExternalLink, FileText, Github, Info, Settings2, Star } from 'lucide-react'
import appPackage from '../../package.json'
import { openGitHub } from '../openGitHub'
import './HomeDashboard.css'

type HomeDashboardProps = {
  deviceContent: ReactNode
  nativeRuntime: boolean
  onOpenSettings: () => void
  onOpenLogs: () => void
  onOpenAbout: () => void
  hasUpdate: boolean
}

export function HomeDashboard({
  deviceContent,
  nativeRuntime,
  onOpenSettings,
  onOpenLogs,
  onOpenAbout,
  hasUpdate,
}: HomeDashboardProps) {
  return (
    <div className="home-page">
      {deviceContent}
      <footer className="home-footer">
        <nav className="home-utilities" aria-label="常用入口">
          <button type="button" className="home-utility-button" aria-label="设置" onClick={onOpenSettings}>
            <Settings2 size={15} aria-hidden="true" />
            设置
          </button>
          <button
            type="button"
            className="home-utility-button home-log-button"
            aria-label="运行日志"
            disabled={!nativeRuntime}
            onClick={nativeRuntime ? onOpenLogs : undefined}
            title={!nativeRuntime ? '请在桌面应用中查看' : '打开日志目录'}
          >
            <FileText size={15} aria-hidden="true" />
            运行日志
          </button>
          <button
            type="button"
            className={`home-utility-button${hasUpdate ? ' has-update' : ''}`}
            aria-label="关于"
            title={hasUpdate ? '关于 · 发现新版本' : '关于'}
            onClick={onOpenAbout}
          >
            <Info size={15} aria-hidden="true" />
            关于{hasUpdate && <span className="update-dot" role="img" aria-label="有新版本可用" />}
          </button>
        </nav>
        <div className="home-project">
          <p>
            <Star size={15} aria-hidden="true" />
            如果 Axonkey 对你有帮助，欢迎点个 Star，支持项目持续更新。
          </p>
          <a
            className="home-project-link"
            href="https://github.com/leowzz/axonkey"
            onClick={openGitHub}
            target="_blank"
            rel="noopener noreferrer"
          >
            <Github size={14} aria-hidden="true" />
            leowzz/axonkey
            <ExternalLink size={12} aria-hidden="true" />
          </a>
          <span className="home-version">版本 {appPackage.version}</span>
        </div>
      </footer>
    </div>
  )
}
