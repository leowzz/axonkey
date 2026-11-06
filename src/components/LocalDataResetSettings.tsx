import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import type { CloudSyncController } from '../cloud/useCloudSync'
import './LocalDataResetSettings.css'

export function LocalDataResetSettings({
  cloud,
}: {
  cloud: Pick<CloudSyncController, 'busy' | 'ready' | 'error' | 'clearFeedback' | 'clearLocalData'>
}) {
  const [resetStage, setResetStage] = useState<'warning' | 'confirm' | null>(null)
  const resetDialog = useRef<HTMLElement>(null)
  const resetOpen = resetStage !== null
  useEffect(() => {
    if (!resetOpen) return
    const root = document.getElementById('root')
    const wasInert = root?.inert ?? false
    const previousFocus = document.activeElement
    const overflow = document.body.style.overflow
    if (root) root.inert = true
    document.body.style.overflow = 'hidden'
    return () => {
      if (root) root.inert = wasInert
      document.body.style.overflow = overflow
      if (previousFocus instanceof HTMLElement && previousFocus.isConnected) previousFocus.focus()
    }
  }, [resetOpen])
  useEffect(() => {
    resetDialog.current?.querySelector<HTMLButtonElement>('[data-cancel]')?.focus()
  }, [resetStage])
  return (
    <>
      <div className="settings-form-fields local-data-reset">
        <div className="settings-form-row">
          <span className="settings-form-label">本机数据：</span>
          <div className="settings-form-control">
            <button
              type="button"
              className="dialog-secondary danger"
              disabled={cloud.busy || !cloud.ready}
              onClick={() => {
                cloud.clearFeedback()
                setResetStage('warning')
              }}
            >
              清除本地数据
            </button>
          </div>
        </div>
      </div>
      {resetOpen &&
        createPortal(
          <div
            className="behavior-dialog-backdrop"
            role="presentation"
            onMouseDown={event => {
              if (!cloud.busy && event.target === event.currentTarget) setResetStage(null)
            }}
            onKeyDown={event => {
              event.stopPropagation()
              if (event.key === 'Escape') {
                event.preventDefault()
                if (!cloud.busy) setResetStage(null)
              }
              if (event.key !== 'Tab') return
              const controls = resetDialog.current?.querySelectorAll<HTMLButtonElement>('button:not(:disabled)')
              const first = controls?.[0]
              const last = controls?.[controls.length - 1]
              if (!first) event.preventDefault()
              else if (event.shiftKey && document.activeElement === first) {
                event.preventDefault()
                last?.focus()
              } else if (!event.shiftKey && document.activeElement === last) {
                event.preventDefault()
                first.focus()
              }
            }}
          >
            <section
              ref={resetDialog}
              className="behavior-dialog local-data-reset-dialog"
              role="alertdialog"
              aria-modal="true"
              aria-labelledby="local-data-reset-title"
              aria-describedby="local-data-reset-description"
              aria-busy={cloud.busy}
            >
              <header className="behavior-dialog-head">
                <h2 id="local-data-reset-title">{resetStage === 'warning' ? '清除本地数据' : '确认恢复初始设置？'}</h2>
              </header>
              <div className="behavior-dialog-body" id="local-data-reset-description">
                {resetStage === 'warning' ? (
                  <>
                    <p>将删除本机的设备配置、按键与鼠标映射、已保存的行为，并恢复个人设置。建议先导出备份。</p>
                    <p>云端备份、登录状态、驱动和系统授权保留。清除后将关闭自动同步并重新加载界面。</p>
                  </>
                ) : (
                  <p>本机的个人设置和设备配置将被永久清除，此操作无法撤销。确定继续？</p>
                )}
                {cloud.error && (
                  <p className="local-data-reset-error" role="alert">
                    {cloud.error}
                  </p>
                )}
              </div>
              <footer className="behavior-dialog-actions">
                <div className="behavior-dialog-buttons">
                  <button
                    type="button"
                    className="dialog-secondary"
                    data-cancel
                    disabled={cloud.busy}
                    onClick={() => setResetStage(resetStage === 'confirm' ? 'warning' : null)}
                  >
                    {resetStage === 'warning' ? '取消' : '返回'}
                  </button>
                  <button
                    type="button"
                    className="dialog-secondary danger"
                    disabled={cloud.busy}
                    onClick={() => {
                      if (resetStage === 'warning') setResetStage('confirm')
                      else void cloud.clearLocalData()
                    }}
                  >
                    {cloud.busy ? '正在清除…' : resetStage === 'warning' ? '继续' : '确认清除'}
                  </button>
                </div>
              </footer>
            </section>
          </div>,
          document.body,
        )}
    </>
  )
}
