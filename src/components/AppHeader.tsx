import { Home, Info, Keyboard, ScanLine, Settings2 } from 'lucide-react'
import type { AppPage } from '../appTypes'
import appPackage from '../../package.json'

const appIconUrl = new URL('../../src-tauri/icons/128x128@2x.png', import.meta.url).href

type AppHeaderProps = {
  activePage: AppPage
  hasUpdate: boolean
  enabled: boolean
  onBrandClick: () => void
  onNavigate: (page: AppPage) => void
  onToggleEnabled: () => void
}

const pageTitles: Record<AppPage, string> = {
  home: '主页',
  mapping: '按键映射',
  overview: '映射总览',
  settings: '设置',
  about: '关于',
}

export function AppHeader({ activePage, hasUpdate, enabled, onBrandClick, onNavigate, onToggleEnabled }: AppHeaderProps) {
  return <header className="topbar">
    <div className="topbar-left">
      <button className="brand-lockup compact brand-trigger" type="button" aria-label="Axonkey" title="Axonkey" onClick={onBrandClick}>
        <img src={appIconUrl} alt="" width={28} height={28} style={{ flexShrink: 0, objectFit: 'contain' }} />
        <span>
          <span className="brand-name">axonkey</span>
          <span className="brand-version"><span>{/^[vV]/.test(appPackage.version) ? appPackage.version : `V${appPackage.version}`}</span></span>
        </span>
      </button>
      <div className="title-row"><h1>{pageTitles[activePage]}</h1></div>
    </div>
    <nav className="app-nav" aria-label="主导航">
      <button type="button" className={activePage === 'home' ? 'active' : ''} aria-current={activePage === 'home' ? 'page' : undefined} onClick={() => onNavigate('home')}><Home size={15} /> 主页</button>
      <button type="button" className={activePage === 'overview' ? 'active' : ''} aria-current={activePage === 'overview' ? 'page' : undefined} onClick={() => onNavigate('overview')}><ScanLine size={15} /> 映射总览</button>
      <button type="button" className={activePage === 'mapping' ? 'active' : ''} aria-current={activePage === 'mapping' ? 'page' : undefined} onClick={() => onNavigate('mapping')}><Keyboard size={15} /> 按键映射</button>
      <button type="button" className={activePage === 'settings' ? 'active' : ''} aria-current={activePage === 'settings' ? 'page' : undefined} onClick={() => onNavigate('settings')}><Settings2 size={15} /> 设置</button>
      <button type="button" className={`${activePage === 'about' ? 'active' : ''} ${hasUpdate ? 'has-update' : ''}`} title={hasUpdate ? '发现新版本' : undefined} aria-current={activePage === 'about' ? 'page' : undefined} onClick={() => onNavigate('about')}><Info size={15} /> 关于{hasUpdate && <span className="update-dot" role="img" aria-label="有新版本可用" />}</button>
    </nav>
    <div className="header-actions">
      <label className="enable-control"><span>启用自定义按键功能</span><button className={`switch ${enabled ? 'on' : ''}`} type="button" aria-pressed={enabled} onClick={onToggleEnabled}><span /></button></label>
    </div>
  </header>
}
