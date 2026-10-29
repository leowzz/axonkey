import { useEffect, useRef, useState } from 'react'
import { CheckCircle2, Mouse, Radio, ArrowRight, LoaderCircle } from 'lucide-react'
import type { MigrationPlan } from '../configMigration'
import type { DeviceInstance } from '../devices/integration/model'
import './ConfigMigrationDialog.css'

type Props = {
  plan: MigrationPlan
  busy: boolean
  status: string
  error: string
  completed: boolean
  exportedPath: string
  remotes: DeviceInstance[]
  remoteTargetId: string
  loadingRemotes: boolean
  remoteLoadError: string
  onSelectRemote: (id: string) => void
  onReloadRemotes: () => void
  onStart: () => void
  onExportAndDelete: () => void
  onClose: () => void
}

export function ConfigMigrationDialog({
  plan,
  busy,
  status,
  error,
  completed,
  exportedPath,
  remotes,
  remoteTargetId,
  loadingRemotes,
  remoteLoadError,
  onSelectRemote,
  onReloadRemotes,
  onStart,
  onExportAndDelete,
  onClose,
}: Props) {
  const ref = useRef<HTMLDialogElement>(null)
  const [confirmExport, setConfirmExport] = useState(false)
  useEffect(() => {
    const focus = document.activeElement
    const overflow = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    ref.current?.showModal()
    return () => {
      ref.current?.close()
      document.body.style.overflow = overflow
      if (focus instanceof HTMLElement && focus.isConnected) focus.focus()
    }
  }, [])
  const canClose = !plan.found || completed
  const showConfirmExport = confirmExport && !canClose
  return (
    <dialog
      ref={ref}
      className="config-migration-dialog"
      aria-labelledby="config-migration-title"
      onCancel={event => {
        event.preventDefault()
        if (busy) return
        if (canClose) onClose()
        else setConfirmExport(!confirmExport)
      }}
    >
      <header>
        <span className="config-migration-eyebrow">AXONKEY</span>
        <h2 id="config-migration-title">{showConfirmExport ? '导出并删除旧配置？' : '数据迁移'}</h2>
      </header>
      <div className="config-migration-content">
        {showConfirmExport ? (
          <p>将旧配置导出到系统“下载”目录，保存成功后删除应用中的旧配置，不再迁移。</p>
        ) : completed || !plan.found ? (
          <div className="config-migration-result">
            <CheckCircle2 size={28} />
            <div>
              <p>{completed ? (exportedPath ? '旧配置已导出并删除' : '迁移完成') : '没有发现旧配置，无需迁移。'}</p>
              {exportedPath && <p className="config-migration-export-path">已保存到 {exportedPath}</p>}
            </div>
          </div>
        ) : (
          <>
            <p>检测到旧配置</p>
            <ul className="config-migration-devices">
              <li>
                <Mouse size={21} />
                <div>
                  <strong>系统鼠标</strong>
                  <span>{plan.mouse.length ? `${plan.mouse.length} 个配置 · 将覆盖当前鼠标配置` : '未检测到数据'}</span>
                </div>
                {plan.mouse.length > 0 && <ArrowRight size={17} />}
              </li>
              <li>
                <Radio size={21} />
                <div>
                  <strong>小米遥控器</strong>
                  <span>{plan.remote ? `${plan.remote.profiles.length} 个配置` : '未检测到数据'}</span>
                  {plan.remote &&
                    (loadingRemotes ? (
                      <span role="status">正在检查已有遥控器…</span>
                    ) : remoteLoadError ? (
                      <>
                        <p className="config-migration-error" role="alert">
                          {remoteLoadError}
                        </p>
                        <button className="dialog-secondary" onClick={onReloadRemotes}>
                          重新检查
                        </button>
                      </>
                    ) : remotes.length ? (
                      <div className="config-migration-target">
                        <label htmlFor="config-migration-remote">迁移到</label>
                        <select
                          id="config-migration-remote"
                          value={remoteTargetId}
                          disabled={busy}
                          onChange={event => onSelectRemote(event.target.value)}
                        >
                          <option value="" disabled>
                            请选择遥控器或新建
                          </option>
                          {remotes.map(instance => (
                            <option key={instance.id} value={instance.id}>
                              {instance.name} · RC003 · {instance.id.slice(-6)}
                            </option>
                          ))}
                          <option value="new">新建小米遥控器</option>
                        </select>
                        {remoteTargetId && (
                          <span>
                            {remoteTargetId === 'new'
                              ? '新建设备，迁移后绑定物理设备'
                              : '将覆盖该遥控器的全部配置，保留设备名称和物理绑定'}
                          </span>
                        )}
                      </div>
                    ) : (
                      <span>新建设备，迁移后绑定物理设备</span>
                    ))}
                </div>
                {plan.remote && <ArrowRight size={17} />}
              </li>
            </ul>
            {!plan.error && !plan.mouse.length && !plan.remote && <p>旧配置中没有鼠标或小米遥控器数据。</p>}
          </>
        )}
        {busy && (
          <p className="config-migration-progress" role="status">
            <LoaderCircle size={16} />
            {status}
          </p>
        )}
        {(error || (!completed && plan.error)) && (
          <p className="config-migration-error" role="alert">
            {error || plan.error}
          </p>
        )}
      </div>
      <footer>
        {showConfirmExport ? (
          <>
            <button className="dialog-secondary" disabled={busy} onClick={() => setConfirmExport(false)}>
              返回迁移
            </button>
            <button className="config-migration-delete" disabled={busy} onClick={onExportAndDelete}>
              {busy ? '导出中…' : '导出并删除'}
            </button>
          </>
        ) : canClose ? (
          <button className="button primary" onClick={onClose}>
            关闭
          </button>
        ) : (
          <>
            <button className="dialog-secondary" disabled={busy} onClick={() => setConfirmExport(true)}>
              导出并删除
            </button>
            <button
              className="button primary"
              disabled={
                busy ||
                !!plan.error ||
                (!plan.mouse.length && !plan.remote) ||
                (!!plan.remote && (loadingRemotes || !!remoteLoadError || !remoteTargetId))
              }
              onClick={onStart}
            >
              {busy ? '迁移中…' : error ? '重试迁移' : '开始迁移'}
            </button>
          </>
        )}
      </footer>
    </dialog>
  )
}
