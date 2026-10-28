import { useEffect, useRef } from 'react'
import { ExternalLink, RotateCcw, X } from 'lucide-react'
import type { CableDriverController } from '../hooks/useCableDriver'
import './CableDriverDialog.css'

export function CableDriverDialog({
  controller,
  nativeRuntime,
  onOpenSound,
  onClose,
}: {
  controller: CableDriverController
  nativeRuntime: boolean
  onOpenSound: () => void
  onClose: () => void
}) {
  const dialogRef = useRef<HTMLDialogElement>(null)
  useEffect(() => {
    const dialog = dialogRef.current
    const previousFocus = document.activeElement
    dialog?.showModal()
    return () => {
      dialog?.close()
      if (previousFocus instanceof HTMLElement && previousFocus.isConnected) previousFocus.focus()
    }
  }, [])

  return (
    <dialog
      ref={dialogRef}
      className="cable-driver-dialog"
      aria-labelledby="cable-driver-title"
      onCancel={onClose}
      onClick={event => {
        if (event.target === event.currentTarget) onClose()
      }}
    >
      <div className="cable-driver-content">
        <header className="behavior-dialog-head">
          <h2 id="cable-driver-title">CABLE 虚拟麦克风驱动</h2>
          <button type="button" className="dialog-close" aria-label="关闭虚拟麦克风管理" onClick={onClose} autoFocus>
            <X size={18} aria-hidden="true" />
          </button>
        </header>
        <div className="behavior-dialog-body">
          <CableDriverContent controller={controller} nativeRuntime={nativeRuntime} onOpenSound={onOpenSound} />
        </div>
      </div>
    </dialog>
  )
}

export function CableDriverContent({
  controller,
  nativeRuntime,
  onOpenSound,
}: {
  controller: CableDriverController
  nativeRuntime: boolean
  onOpenSound: () => void
}) {
  const { installed, busy, error, message, rebootRequired } = controller
  const status = !nativeRuntime
    ? '未检测'
    : busy === 'checking'
      ? '检测中…'
      : busy === 'install'
        ? '正在安装…'
        : busy === 'uninstall'
          ? '正在卸载…'
          : installed === null
            ? '未检测'
            : installed
              ? '已安装'
              : '未安装'

  return (
    <div className="cable-driver-panel">
      {!nativeRuntime && (
        <p className="cable-driver-message">浏览器预览无法检测或管理系统驱动，请使用 Windows 桌面版。</p>
      )}
      <div className="settings-form-fields">
        <div className="settings-form-row">
          <span className="settings-form-label">驱动状态：</span>
          <div className="settings-form-control" role="status" aria-live="polite">
            <strong className={`settings-permission-status ${nativeRuntime && installed && !busy ? 'granted' : ''}`}>
              {status}
            </strong>
            <button
              type="button"
              className="dialog-secondary"
              disabled={!nativeRuntime || !!busy}
              onClick={() => void controller.probe()}
            >
              <RotateCcw size={14} aria-hidden="true" />
              重新检测
            </button>
          </div>
        </div>
        <div className="settings-form-row">
          <span className="settings-form-label">驱动管理：</span>
          <div className="settings-form-control">
            <button
              type="button"
              className={`dialog-secondary ${installed ? 'danger' : ''}`}
              disabled={!nativeRuntime || !!busy || installed === null}
              onClick={() => void controller.run(installed ? 'uninstall' : 'install')}
            >
              {installed ? '卸载驱动' : '安装驱动'}
            </button>
            <button
              type="button"
              className="dialog-secondary"
              disabled={!nativeRuntime || !!busy}
              onClick={onOpenSound}
            >
              声音设置
              <ExternalLink size={14} aria-hidden="true" />
            </button>
          </div>
        </div>
      </div>
      <p className="cable-driver-routing">
        设备语音输出选择 <strong>CABLE Input</strong>，录音或语音输入软件的麦克风选择 <strong>CABLE Output</strong>。
      </p>
      {(busy === 'install' || busy === 'uninstall') && (
        <p className="cable-driver-message" role="status">
          请完成 Windows 管理员授权及安装器操作。
        </p>
      )}
      {rebootRequired && (
        <p className="cable-driver-message" role="status">
          请重启 Windows 完成驱动变更。
        </p>
      )}
      {error && (
        <p className="settings-form-error cable-driver-message" role="alert">
          {error}
        </p>
      )}
      {message && (
        <p className="cable-driver-message" role="status">
          {message}
        </p>
      )}
    </div>
  )
}
