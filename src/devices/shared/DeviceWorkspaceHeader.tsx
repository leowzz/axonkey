import { ArrowLeft, Check, ChevronDown, Plus, Settings, SlidersHorizontal } from 'lucide-react'
import { forwardRef, useEffect, useRef, useState, type ReactNode } from 'react'

export type WorkspaceSwitcherItem = {
  id: string
  name: string
  statusLabel?: string
  tone?: 'ready' | 'warning' | 'muted'
  active: boolean
  onSelect: () => void
}

export const GlobalSettingsButton = forwardRef<
  HTMLButtonElement,
  {
    active?: boolean
    hasUpdate?: boolean
    onClick: () => void
  }
>(function GlobalSettingsButton({ active = false, hasUpdate = false, onClick }, ref) {
  return (
    <button
      ref={ref}
      type="button"
      className={`topbar-global-settings${active ? ' is-active' : ''}`}
      aria-label={hasUpdate ? '全局设置，有新版本可用' : '全局设置'}
      aria-expanded={active}
      title={hasUpdate ? '全局设置 · 发现新版本' : '全局设置'}
      onClick={onClick}
    >
      <Settings size={16} aria-hidden="true" />
      {hasUpdate && <span className="topbar-update-dot" aria-hidden="true" />}
    </button>
  )
})

type DeviceWorkspaceHeaderProps = {
  deviceName: string
  profileControls: ReactNode
  onBackToDevices: () => void
  onOpenSettings?: () => void
  settingsLabel?: string
  switcherItems?: WorkspaceSwitcherItem[]
  onOpenAddDevice?: () => void
  statusControls?: ReactNode
  globalControls?: ReactNode
}

export function DeviceWorkspaceHeader({
  deviceName,
  profileControls,
  onBackToDevices,
  onOpenSettings,
  settingsLabel,
  switcherItems,
  onOpenAddDevice,
  statusControls,
  globalControls,
}: DeviceWorkspaceHeaderProps) {
  const [menuOpen, setMenuOpen] = useState(false)
  const switcherRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!menuOpen || typeof window === 'undefined' || typeof window.addEventListener !== 'function') return
    const onPointerDown = (event: PointerEvent) => {
      if (event.target instanceof Node && switcherRef.current?.contains(event.target)) return
      setMenuOpen(false)
    }
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault()
        setMenuOpen(false)
      }
    }
    window.addEventListener('pointerdown', onPointerDown)
    window.addEventListener('keydown', onKeyDown)
    return () => {
      window.removeEventListener('pointerdown', onPointerDown)
      window.removeEventListener('keydown', onKeyDown)
    }
  }, [menuOpen])

  return (
    <header className="device-workspace-header window-topbar" data-tauri-drag-region>
      <div className="device-workspace-title" data-tauri-drag-region>
        <button
          type="button"
          className="device-workspace-back"
          aria-label="返回我的设备"
          title="返回我的设备"
          onClick={onBackToDevices}
        >
          <ArrowLeft size={15} />
          {!switcherItems && '我的设备'}
        </button>
        {switcherItems ? (
          <div ref={switcherRef} className="device-switcher">
            <button
              type="button"
              className="device-switcher-trigger"
              aria-haspopup="menu"
              aria-expanded={menuOpen}
              aria-label={`切换设备，当前为${deviceName}`}
              onClick={() => setMenuOpen(open => !open)}
            >
              <span className="device-switcher-name">{deviceName}</span>
              <ChevronDown size={14} aria-hidden="true" />
            </button>
            {menuOpen && (
              <div className="device-switcher-menu" role="menu" aria-label="已接入设备">
                {switcherItems.map(item => (
                  <button
                    key={item.id}
                    type="button"
                    role="menuitemradio"
                    aria-checked={item.active}
                    className={`device-switcher-option${item.active ? ' is-active' : ''}`}
                    onClick={() => {
                      setMenuOpen(false)
                      if (!item.active) item.onSelect()
                    }}
                  >
                    <span className={`device-switcher-dot ${item.tone ?? 'muted'}`} aria-hidden="true" />
                    <span className="device-switcher-option-name">{item.name}</span>
                    {item.statusLabel && <span className="device-switcher-option-status">{item.statusLabel}</span>}
                    {item.active && <Check size={14} aria-hidden="true" />}
                  </button>
                ))}
                {(onOpenSettings || onOpenAddDevice) && <div className="device-switcher-divider" role="separator" />}
                {onOpenSettings && (
                  <button
                    type="button"
                    role="menuitem"
                    className="device-switcher-action"
                    onClick={() => {
                      setMenuOpen(false)
                      onOpenSettings()
                    }}
                  >
                    <SlidersHorizontal size={14} aria-hidden="true" />
                    <span>当前设备设置与信息…</span>
                  </button>
                )}
                {onOpenAddDevice && (
                  <button
                    type="button"
                    role="menuitem"
                    className="device-switcher-action"
                    onClick={() => {
                      setMenuOpen(false)
                      onOpenAddDevice()
                    }}
                  >
                    <Plus size={14} aria-hidden="true" />
                    <span>添加设备…</span>
                  </button>
                )}
              </div>
            )}
          </div>
        ) : (
          <h1>{deviceName}</h1>
        )}
        {statusControls}
        {onOpenSettings && (
          <button
            type="button"
            className="device-workspace-settings"
            aria-label={`${deviceName}设置`}
            title="设备设置"
            onClick={onOpenSettings}
          >
            <SlidersHorizontal size={14} aria-hidden="true" />
            <span>{settingsLabel ?? '设备设置'}</span>
          </button>
        )}
      </div>
      <div className="device-workspace-controls">{profileControls}</div>
      {globalControls && <div className="topbar-global-tools">{globalControls}</div>}
    </header>
  )
}
