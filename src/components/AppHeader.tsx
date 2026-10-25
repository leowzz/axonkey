import type { ReactNode } from 'react'

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
