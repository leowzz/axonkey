import { ExternalLink, FileText, Github, ShieldCheck, Star } from 'lucide-react'
import type { DeviceId } from '../deviceModel'
import { openGitHub } from '../openGitHub'
import { MyDevicesPage, type DeviceOverviewItem } from './MyDevicesPage'
import './HomeDashboard.css'

type HomeDashboardProps = {
  nativeRuntime: boolean
  devices: readonly DeviceOverviewItem[]
  onSelectDevice: (deviceId: DeviceId) => void
  onIntegrate: () => void
  onOpenPermissions: () => void
  onOpenLogs: () => void
}

export function HomeDashboard({
  nativeRuntime,
  devices,
  onSelectDevice,
  onIntegrate,
  onOpenPermissions,
  onOpenLogs,
}: HomeDashboardProps) {
  return <div className="home-page">
    <MyDevicesPage devices={devices} onSelect={onSelectDevice} onIntegrate={onIntegrate} />
    <footer className="home-footer">
      <nav className="home-utilities" aria-label="常用入口">
        <button type="button" className="home-utility-button" aria-label="权限设置" onClick={onOpenPermissions}>
          <ShieldCheck size={15} aria-hidden="true" />权限设置
        </button>
        <button type="button" className="home-utility-button home-log-button" aria-label="运行日志" disabled={!nativeRuntime} onClick={nativeRuntime ? onOpenLogs : undefined} title={!nativeRuntime ? '请在桌面应用中查看' : '打开日志目录'}>
          <FileText size={15} aria-hidden="true" />运行日志
        </button>
      </nav>
      <div className="home-project">
        <p><Star size={15} aria-hidden="true" />如果 Axonkey 对你有帮助，欢迎点个 Star，支持项目持续更新。</p>
        <a className="home-project-link" href="https://github.com/leowzz/axonkey" onClick={openGitHub} target="_blank" rel="noopener noreferrer">
          <Github size={14} aria-hidden="true" />leowzz/axonkey<ExternalLink size={12} aria-hidden="true" />
        </a>
      </div>
    </footer>
  </div>
}
