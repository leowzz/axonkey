import { useEffect, useRef, type ReactNode, type RefObject } from 'react'
import { ArrowLeft } from 'lucide-react'
import './AppSettingsPanel.css'

export function AppSettingsPanel({
  workspaceRef,
  backLabel = '返回',
  onClose,
  children,
}: {
  workspaceRef: RefObject<HTMLElement>
  backLabel?: string
  onClose: () => void
  children: ReactNode
}) {
  const closeRef = useRef<HTMLButtonElement>(null)

  useEffect(() => {
    const previousFocus = document.activeElement
    const workspace = workspaceRef.current
    if (workspace) workspace.inert = true
    closeRef.current?.focus({ preventScroll: true })
    return () => {
      if (workspace) workspace.inert = false
      if (previousFocus instanceof HTMLElement && previousFocus.isConnected)
        previousFocus.focus({ preventScroll: true })
    }
  }, [workspaceRef])

  useEffect(() => {
    let closeTimer: number | undefined
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return
      if (event.target instanceof Element && event.target.closest('dialog[open]')) return
      // Help popovers also handle Escape on window; let them consume it first.
      closeTimer = window.setTimeout(() => {
        if (!event.defaultPrevented) onClose()
      }, 0)
    }
    window.addEventListener('keydown', onKeyDown)
    return () => {
      window.removeEventListener('keydown', onKeyDown)
      window.clearTimeout(closeTimer)
    }
  }, [onClose])

  return (
    <section className="app-settings-panel" aria-labelledby="app-settings-panel-title">
      <header className="device-workspace-header app-settings-panel-header">
        <div className="device-workspace-title">
          <button
            ref={closeRef}
            type="button"
            className="device-workspace-back"
            aria-label={backLabel === '返回' ? '退出设置' : `返回${backLabel}`}
            title="退出设置 · Esc"
            onClick={onClose}
          >
            <ArrowLeft size={15} aria-hidden="true" />
            {backLabel}
          </button>
          <h2 id="app-settings-panel-title">设置</h2>
        </div>
      </header>
      {children}
    </section>
  )
}
