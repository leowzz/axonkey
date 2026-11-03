import { useEffect, useRef } from 'react'
import type { ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { X } from 'lucide-react'
import './DeviceSettingsDrawer.css'

export function DeviceSettingsDrawer({
  deviceName,
  onClose,
  children,
}: {
  deviceName: string
  onClose: () => void
  children: ReactNode
}) {
  const ref = useRef<HTMLDialogElement>(null)
  useEffect(() => {
    const dialog = ref.current
    const previousFocus = document.activeElement
    dialog?.showModal()
    return () => {
      dialog?.close()
      if (previousFocus instanceof HTMLElement && previousFocus.isConnected) previousFocus.focus()
    }
  }, [])

  const close = () => {
    const active = document.activeElement
    if (active instanceof HTMLElement && ref.current?.contains(active)) active.blur()
    onClose()
  }

  return createPortal(
    <dialog
      ref={ref}
      className="device-settings-drawer"
      aria-labelledby="device-settings-drawer-title"
      onCancel={event => {
        event.preventDefault()
        close()
      }}
      onClick={event => {
        if (event.target === event.currentTarget) close()
      }}
    >
      <div className="device-settings-drawer-content">
        <header className="device-settings-drawer-header">
          <div>
            <h2 id="device-settings-drawer-title">设备设置</h2>
            <p>{deviceName}</p>
          </div>
          <button type="button" className="dialog-close" aria-label="关闭设备设置" onClick={close} autoFocus>
            <X size={18} aria-hidden="true" />
          </button>
        </header>
        {children}
      </div>
    </dialog>,
    document.body,
  )
}
