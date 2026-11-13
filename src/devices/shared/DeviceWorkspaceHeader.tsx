import { ArrowLeft, Check, ChevronDown, Settings } from 'lucide-react'
import { useEffect, useRef, useState, type ReactNode } from 'react'

export type WorkspaceDeviceOption = {
  id: string
  name: string
  artwork?: string
  detail?: string
}

type DeviceWorkspaceHeaderProps = {
  deviceName: string
  activeDeviceId?: string
  deviceOptions?: WorkspaceDeviceOption[]
  onSelectDevice?: (id: string) => void
  profileControls: ReactNode
  onBackToDevices: () => void
  onOpenSettings?: () => void
}

export function DeviceWorkspaceHeader({
  deviceName,
  activeDeviceId,
  deviceOptions,
  onSelectDevice,
  profileControls,
  onBackToDevices,
  onOpenSettings,
}: DeviceWorkspaceHeaderProps) {
  const [menuOpen, setMenuOpen] = useState(false)
  const switcherRef = useRef<HTMLDivElement>(null)
  const triggerRef = useRef<HTMLButtonElement>(null)
  const canSwitch = Boolean(deviceOptions && deviceOptions.length > 0 && activeDeviceId && onSelectDevice)
  const activeOption = deviceOptions?.find(option => option.id === activeDeviceId)

  useEffect(() => {
    setMenuOpen(false)
  }, [activeDeviceId])

  useEffect(() => {
    if (!menuOpen || typeof document === 'undefined' || typeof document.addEventListener !== 'function') return
    const handlePointerDown = (event: PointerEvent) => {
      if (!switcherRef.current?.contains(event.target as Node)) setMenuOpen(false)
    }
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault()
        setMenuOpen(false)
        triggerRef.current?.focus()
      }
    }
    document.addEventListener('pointerdown', handlePointerDown)
    document.addEventListener('keydown', handleKeyDown)
    return () => {
      document.removeEventListener('pointerdown', handlePointerDown)
      document.removeEventListener('keydown', handleKeyDown)
    }
  }, [menuOpen])

  return (
    <header className="device-workspace-header">
      <div className="device-workspace-title">
        <button type="button" className="device-workspace-back" aria-label="返回我的设备" onClick={onBackToDevices}>
          <ArrowLeft size={15} />
          我的设备
        </button>
        {canSwitch ? (
          <div ref={switcherRef} className="device-workspace-switcher">
            <button
              ref={triggerRef}
              type="button"
              className="device-workspace-switcher-trigger"
              aria-label={`切换设备，当前为${deviceName}`}
              aria-haspopup="listbox"
              aria-expanded={menuOpen}
              onClick={() => setMenuOpen(current => !current)}
              onKeyDown={event => {
                if (event.key === 'ArrowDown' && !menuOpen) {
                  event.preventDefault()
                  setMenuOpen(true)
                }
              }}
            >
              {activeOption?.artwork && (
                <span className="device-workspace-switcher-thumb" aria-hidden="true">
                  <img src={activeOption.artwork} alt="" draggable={false} />
                </span>
              )}
              <span className="device-workspace-switcher-name">{deviceName}</span>
              <ChevronDown size={14} className="device-workspace-switcher-chevron" aria-hidden="true" />
            </button>
            {menuOpen && (
              <div className="device-workspace-switcher-popover" role="listbox" aria-label="切换设备">
                <div className="device-workspace-switcher-list">
                  {deviceOptions!.map(option => {
                    const selected = option.id === activeDeviceId
                    return (
                      <button
                        key={option.id}
                        type="button"
                        role="option"
                        className="device-workspace-switcher-option"
                        aria-selected={selected}
                        onClick={() => {
                          setMenuOpen(false)
                          if (!selected) onSelectDevice!(option.id)
                        }}
                      >
                        {option.artwork && (
                          <span className="device-workspace-switcher-thumb" aria-hidden="true">
                            <img src={option.artwork} alt="" draggable={false} />
                          </span>
                        )}
                        <span className="device-workspace-switcher-option-copy">
                          <strong>{option.name}</strong>
                          {option.detail && <small>{option.detail}</small>}
                        </span>
                        {selected && <Check size={14} className="device-workspace-switcher-check" aria-hidden="true" />}
                      </button>
                    )
                  })}
                </div>
              </div>
            )}
          </div>
        ) : (
          <h1>{deviceName}</h1>
        )}
      </div>
      <div className="device-workspace-controls">{profileControls}</div>
      {onOpenSettings ? (
        <button
          type="button"
          className="device-workspace-settings"
          aria-label={`${deviceName}设置`}
          title="设备设置"
          onClick={onOpenSettings}
        >
          <Settings size={16} />
        </button>
      ) : (
        <span aria-hidden="true" />
      )}
    </header>
  )
}
