import { useEffect, useRef, useState } from 'react'
import { invoke } from '@tauri-apps/api/core'
import { LoaderCircle, X } from 'lucide-react'
import type { ManagedDriverCleanupState, ManagedDriverUninstallResult } from '../appTypes'
import type { DeviceInstance, DeviceSnapshot } from '../devices/integration/model'
import './ManagedDriverCleanupDialog.css'

export function ManagedDriverCleanupDialog({
  onClose,
  onDevicesChanged,
}: {
  onClose: () => void
  onDevicesChanged: () => void
}) {
  const dialogRef = useRef<HTMLDialogElement>(null)
  const [devices, setDevices] = useState<DeviceInstance[] | null>(null)
  const [state, setState] = useState<ManagedDriverCleanupState>({ status: 'idle' })
  const busy = state.status === 'running'
  const result = state.result
  const failed = !!state.error || !!result?.failures.length

  useEffect(() => {
    const dialog = dialogRef.current
    const previousFocus = document.activeElement
    dialog?.showModal()
    void loadDevices()
    return () => {
      dialog?.close()
      if (previousFocus instanceof HTMLElement && previousFocus.isConnected) previousFocus.focus()
    }
  }, [])

  async function loadDevices() {
    setDevices(null)
    setState({ status: 'idle' })
    try {
      const snapshot = await invoke<DeviceSnapshot>('device_snapshot')
      setDevices(
        snapshot.store.instances.filter(
          device =>
            (device.kind === 'rc003' || device.kind === 'cmiotA15' || device.kind === 'xboxBluetooth') &&
            device.binding !== null,
        ),
      )
    } catch (error) {
      setState({ status: 'idle', error: `无法读取设备：${String(error)}` })
    }
  }

  async function uninstall() {
    setState({ status: 'running' })
    try {
      const result = await invoke<ManagedDriverUninstallResult>('uninstall_bound_device_drivers')
      setState({ status: 'done', result })
    } catch (error) {
      setState({ status: 'idle', error: String(error) })
    } finally {
      onDevicesChanged()
    }
  }

  return (
    <dialog
      ref={dialogRef}
      className="managed-driver-cleanup-dialog"
      aria-labelledby="managed-driver-cleanup-title"
      aria-describedby="managed-driver-cleanup-description"
      aria-busy={busy}
      onCancel={event => {
        event.preventDefault()
        if (!busy) onClose()
      }}
      onClick={event => {
        if (!busy && event.target === event.currentTarget) onClose()
      }}
    >
      <div className="managed-driver-cleanup-content">
        <header className="behavior-dialog-head">
          <h2 id="managed-driver-cleanup-title">卸载已绑定设备驱动</h2>
          <button
            type="button"
            className="dialog-close"
            aria-label="关闭设备驱动卸载"
            disabled={busy}
            onClick={onClose}
          >
            <X size={18} aria-hidden="true" />
          </button>
        </header>
        <div className="behavior-dialog-body">
          <p id="managed-driver-cleanup-description">
            {devices?.length
              ? result
                ? `本次操作涉及以下 ${devices.length} 台设备，映射配置已保留。`
                : `将卸载所有 Quarbor Universal 驱动，并解除以下 ${devices.length} 台设备的物理绑定。映射配置会保留。`
              : devices
                ? '当前没有需要解绑的设备。'
                : '卸载驱动将解除设备的物理绑定，映射配置会保留。'}
          </p>
          {!!devices?.length && (
            <ul className="managed-driver-cleanup-devices" aria-label="本次解绑设备">
              {devices.map(device => (
                <li key={device.id}>
                  <strong>{device.name}</strong>
                  <span>
                    {device.kind === 'rc003' ? 'RC003' : device.kind === 'cmiotA15' ? 'CMIOT A15' : 'Xbox 蓝牙手柄'} ·{' '}
                    {device.id.slice(-6)}
                  </span>
                </li>
              ))}
            </ul>
          )}
          <div className="managed-driver-cleanup-status" role="status" aria-live="polite">
            {!devices && !state.error && (
              <p>
                <LoaderCircle className="managed-driver-cleanup-spinner" size={16} />
                正在读取已绑定设备…
              </p>
            )}
            {busy && (
              <p>
                <LoaderCircle className="managed-driver-cleanup-spinner" size={16} />
                正在卸载驱动并解除绑定，请完成 Windows 管理员授权。
              </p>
            )}
            {result && (
              <p>
                已找到 {result.deviceCount} 台设备，卸载 {result.uninstalledCount} 台，解除绑定 {result.unboundCount}{' '}
                台。
              </p>
            )}
            {result?.rebootRequired && <p>请重启 Windows 完成卸载。</p>}
          </div>
          {state.error && (
            <p className="settings-form-error" role="alert">
              {state.error}
            </p>
          )}
          {!!result?.failures.length && (
            <ul className="managed-driver-cleanup-errors" role="alert">
              {result.failures.map(failure => (
                <li key={failure.instanceId}>
                  {devices?.find(device => device.id === failure.instanceId)?.name ?? '设备'} ·{' '}
                  {failure.instanceId.slice(-6)}：{failure.error}
                </li>
              ))}
            </ul>
          )}
        </div>
        <footer className="behavior-dialog-actions">
          <div className="behavior-dialog-buttons">
            <button type="button" className="dialog-secondary" disabled={busy} onClick={onClose} autoFocus>
              {result ? '关闭' : '取消'}
            </button>
            {failed ? (
              <button type="button" className="dialog-secondary" onClick={() => void loadDevices()}>
                重新检查
              </button>
            ) : (
              !result && (
                <button
                  type="button"
                  className="dialog-secondary danger"
                  disabled={busy || !devices?.length}
                  onClick={() => void uninstall()}
                >
                  {busy ? '正在卸载…' : '确认卸载并解绑'}
                </button>
              )
            )}
          </div>
        </footer>
      </div>
    </dialog>
  )
}
