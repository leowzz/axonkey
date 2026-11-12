import { useEffect, useRef, type ReactNode, type RefObject } from 'react'
import { X } from 'lucide-react'
import './AppSettingsPanel.css'

export function AppSettingsPanel({
  workspaceRef,
  onClose,
  children,
}: {
  workspaceRef: RefObject<HTMLElement>
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
    <>
      <button
        className="app-settings-panel-dismiss"
        type="button"
        aria-label="点击空白处关闭设置面板"
        tabIndex={-1}
        onClick={onClose}
      />
      <aside className="app-settings-panel" aria-labelledby="app-settings-panel-title">
        <header className="app-settings-panel-header" data-tauri-drag-region>
          <h2 id="app-settings-panel-title">设置</h2>
          <button ref={closeRef} type="button" aria-label="关闭设置面板" title="关闭 · Esc" onClick={onClose}>
            <X size={17} aria-hidden="true" />
          </button>
        </header>
        {children}
      </aside>
    </>
  )
}
