import { Home, Keyboard } from 'lucide-react'
import type { AppPage } from '../appTypes'
import appPackage from '../../package.json'

type AppHeaderProps = {
  activePage: AppPage
  enabled: boolean
  onBrandClick: () => void
  onNavigate: (page: AppPage) => void
  onToggleEnabled: () => void
}

const pageTitles: Record<AppPage, string> = {
  home: '主页',
  mapping: '按键映射',
}

export function AppHeader({ activePage, enabled, onBrandClick, onNavigate, onToggleEnabled }: AppHeaderProps) {
  return <header className="topbar">
    <div className="topbar-left">
      <button className="brand-lockup compact brand-trigger" type="button" aria-label="Axonkey" title="Axonkey" onClick={onBrandClick}>
        <span className="brand-mark">A</span>
        <span>
          <span className="brand-name">axonkey</span>
          <span className="brand-version">RC003 控制台 <span>{appPackage.version}</span></span>
        </span>
      </button>
      <div className="title-row"><h1>{pageTitles[activePage]}</h1><span className="title-divider" /><span className="title-hint">RC003</span></div>
    </div>
    <nav className="app-nav" aria-label="主导航">
      <button type="button" className={activePage === 'home' ? 'active' : ''} onClick={() => onNavigate('home')}><Home size={15} /> 主页</button>
      <button type="button" className={activePage === 'mapping' ? 'active' : ''} onClick={() => onNavigate('mapping')}><Keyboard size={15} /> 按键映射</button>
    </nav>
    <div className="header-actions">
      <label className="enable-control"><span>启用自定义按键功能</span><button className={`switch ${enabled ? 'on' : ''}`} type="button" aria-pressed={enabled} onClick={onToggleEnabled}><span /></button></label>
    </div>
  </header>
}
