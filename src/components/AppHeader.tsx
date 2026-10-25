import { Home, Info, PanelLeftClose, PanelLeftOpen, Settings2 } from 'lucide-react'
import type { ReactNode } from 'react'
import type { AppPage } from '../appTypes'
import appPackage from '../../package.json'
import { SidebarButton } from './SidebarButton'

const appIconUrl = new URL('../../src-tauri/icons/128x128@2x.png', import.meta.url).href

const pages = [
  { id: 'home', label: '首页', icon: Home },
  { id: 'settings', label: '设置', icon: Settings2 },
  { id: 'about', label: '关于', icon: Info },
] as const

type AppSidebarProps = {
  activePage: AppPage
  hasUpdate: boolean
  enabled: boolean
  collapsed: boolean
  onToggleCollapsed: () => void
  onToggleEnabled: () => void
  onBrandClick: () => void
  onNavigate: (page: AppPage) => void
}

export function AppSidebar({ activePage, hasUpdate, enabled, collapsed, onToggleCollapsed, onToggleEnabled, onBrandClick, onNavigate }: AppSidebarProps) {
  const activeNavigationPage = activePage === 'mapping' || activePage === 'overview' || activePage === 'device-settings' ? 'home' : activePage
  return <aside className={`app-sidebar${collapsed ? ' is-collapsed' : ''}`}>
    <SidebarButton collapsed={collapsed} className="brand-lockup compact brand-trigger" type="button" aria-label="Axonkey" title="Axonkey" onClick={onBrandClick}>
      <img src={appIconUrl} alt="" width={28} height={28} />
      <span className="brand-name">axonkey</span>
    </SidebarButton>
    <nav id="app-navigation" className="app-nav" aria-label="主导航">
      {pages.map(({ id, label, icon: Icon }) => <SidebarButton collapsed={collapsed} key={id} type="button"
        className={`${activeNavigationPage === id ? 'active' : ''} ${id === 'about' && hasUpdate ? 'has-update' : ''}`}
        aria-label={label} title={`${id === 'about' && hasUpdate ? '关于 · 发现新版本' : label} · 双击${collapsed ? '展开' : '收起'}侧栏`}
        aria-current={activeNavigationPage === id ? 'page' : undefined} onClick={() => onNavigate(id)} onDoubleClick={onToggleCollapsed}>
        <Icon size={18} /><span className="app-nav-label">{label}</span>
        {id === 'about' && hasUpdate && <span className="update-dot" role="img" aria-label="有新版本可用" />}
      </SidebarButton>)}
    </nav>
    <div className="sidebar-footer">
      <span className="sidebar-version">版本 {appPackage.version}</span>
      <SidebarButton collapsed={collapsed} type="button" className="sidebar-collapse" aria-label={collapsed ? '展开侧栏' : '收起侧栏'} title={collapsed ? '展开侧栏' : '收起侧栏'} aria-expanded={!collapsed} aria-controls="app-navigation" onClick={onToggleCollapsed}>
        {collapsed ? <PanelLeftOpen size={18} /> : <PanelLeftClose size={18} />}<span>收起侧栏</span>
      </SidebarButton>
      <label className="enable-control"><span>软件总开关</span><SidebarButton collapsed={collapsed} className={`switch ${enabled ? 'on' : ''}`} type="button" aria-label="软件功能总开关" title={`软件总开关 · ${enabled ? '已开启' : '已暂停'}`} aria-pressed={enabled} onClick={onToggleEnabled}><span /></SidebarButton></label>
    </div>
  </aside>
}

type AppHeaderProps = {
  context?: ReactNode
  actions?: ReactNode
}

export function AppHeader({ context, actions }: AppHeaderProps) {
  if (!context && !actions) return null
  return <header className="topbar" aria-label="配置工具栏">
    <div className="topbar-left">
      {context && <div className="topbar-context">{context}</div>}
    </div>
    <div className="header-actions">
      {actions}
    </div>
  </header>
}
