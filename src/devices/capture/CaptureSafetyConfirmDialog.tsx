import { useEffect, useRef, useState } from 'react'
import { ShieldAlert, RotateCcw, CheckCircle2 } from 'lucide-react'
import { formatVidPid, type CaptureCandidate } from './model'

export const KEEP_ALIVE_SECONDS = 15

export type CaptureSafetyDialogState =
  | {
      mode: 'caution-pre-attach'
      candidate: CaptureCandidate
    }
  | {
      mode: 'caution-keepalive'
      candidate: CaptureCandidate
    }
  | {
      mode: 'exit-cleanup'
      candidates: CaptureCandidate[]
    }

export type CaptureSafetyConfirmDialogProps = {
  state: CaptureSafetyDialogState
  busy?: boolean
  onCancel: () => void
  onConfirmPreAttach: (candidate: CaptureCandidate, passthroughStandardKeys: boolean) => void
  onConfirmKeepAlive: (candidate: CaptureCandidate) => void
  onRollbackKeepAlive: (candidate: CaptureCandidate) => void
  onExitAndRestore: (candidates: CaptureCandidate[]) => void
  onExitKeepDriver: () => void
}

export function CaptureSafetyConfirmDialog({
  state,
  busy = false,
  onCancel,
  onConfirmPreAttach,
  onConfirmKeepAlive,
  onRollbackKeepAlive,
  onExitAndRestore,
  onExitKeepDriver,
}: CaptureSafetyConfirmDialogProps) {
  const dialogRef = useRef<HTMLDialogElement>(null)
  const [confirmedPrimaryInput, setConfirmedPrimaryInput] = useState(false)
  const [passthroughKeys, setPassthroughKeys] = useState(true)
  const [secondsLeft, setSecondsLeft] = useState(KEEP_ALIVE_SECONDS)
  const rolledBackRef = useRef(false)

  useEffect(() => {
    const dialog = dialogRef.current
    const previousFocus = typeof document !== 'undefined' ? document.activeElement : null
    dialog?.showModal?.()
    return () => {
      dialog?.close?.()
      if (typeof HTMLElement !== 'undefined' && previousFocus instanceof HTMLElement && previousFocus.isConnected) {
        previousFocus.focus()
      }
    }
  }, [])

  useEffect(() => {
    setConfirmedPrimaryInput(false)
    setPassthroughKeys(true)
    setSecondsLeft(KEEP_ALIVE_SECONDS)
    rolledBackRef.current = false
  }, [state])

  useEffect(() => {
    if (state.mode !== 'caution-keepalive') return
    if (secondsLeft <= 0) {
      if (!rolledBackRef.current) {
        rolledBackRef.current = true
        onRollbackKeepAlive(state.candidate)
      }
      return
    }
    const timer = setTimeout(() => {
      setSecondsLeft(current => Math.max(0, current - 1))
    }, 1000)
    return () => clearTimeout(timer)
  }, [state, secondsLeft, onRollbackKeepAlive])

  return (
    <dialog
      ref={dialogRef}
      className="capture-safety-dialog"
      aria-busy={busy || undefined}
      aria-labelledby="capture-safety-dialog-title"
      onCancel={event => {
        event.preventDefault()
        if (busy) return
        if (state.mode === 'caution-keepalive') {
          if (!rolledBackRef.current) {
            rolledBackRef.current = true
            onRollbackKeepAlive(state.candidate)
          }
          return
        }
        onCancel()
      }}
      onClick={event => {
        if (event.target === event.currentTarget && !busy && state.mode !== 'caution-keepalive') {
          onCancel()
        }
      }}
    >
      <div className="capture-safety-dialog-inner">
        {state.mode === 'caution-pre-attach' && (
          <>
            <header className="capture-safety-head">
              <ShieldAlert size={18} className="is-caution" aria-hidden="true" />
              <h2 id="capture-safety-dialog-title">确认挂载副键盘拦截驱动</h2>
            </header>
            <div className="capture-safety-body">
              <div className="capture-safety-device-box">
                <strong>{state.candidate.displayName}</strong>
                <span>
                  {formatVidPid(state.candidate.vid, state.candidate.pid)} · <code>{state.candidate.instanceId}</code>
                </span>
              </div>
              <p>
                挂载 Quarbor 驱动后，该键盘的按键将被采集通道独占拦截，不再直接向系统输入字符。挂载完成后需在 15
                秒内使用主鼠标或主键盘点击确认。
              </p>
              <label className="capture-safety-check">
                <input
                  type="checkbox"
                  checked={confirmedPrimaryInput}
                  disabled={busy}
                  onChange={event => setConfirmedPrimaryInput(event.target.checked)}
                />
                <span>我确认当前电脑仍有另一把可用的主键盘与鼠标</span>
              </label>
              <label className="capture-safety-check">
                <input
                  type="checkbox"
                  checked={passthroughKeys}
                  disabled={busy}
                  onChange={event => setPassthroughKeys(event.target.checked)}
                />
                <span>会话期间开启标准按键紧急透传</span>
              </label>
            </div>
            <footer className="capture-safety-footer">
              <button type="button" className="capture-btn-secondary" disabled={busy} onClick={onCancel} autoFocus>
                取消
              </button>
              <button
                type="button"
                className="capture-btn-primary"
                disabled={busy || !confirmedPrimaryInput}
                onClick={() => onConfirmPreAttach(state.candidate, passthroughKeys)}
              >
                {busy ? '正在挂载…' : '继续挂载拦截驱动'}
              </button>
            </footer>
          </>
        )}

        {state.mode === 'caution-keepalive' && (
          <>
            <header className="capture-safety-head">
              <ShieldAlert size={18} className="is-caution" aria-hidden="true" />
              <h2 id="capture-safety-dialog-title">请确认主键盘与鼠标输入正常</h2>
              <span className="capture-keepalive-timer" aria-live="polite">
                {secondsLeft}s
              </span>
            </header>
            <div className="capture-safety-body">
              <p>
                已对 <strong>{state.candidate.displayName}</strong>{' '}
                挂载拦截驱动。请用您的主鼠标或主键盘点击下方确认按钮；倒计时归零或按 Esc 将立即请求恢复系统原驱动。
              </p>
              <code className="capture-recovery-cli">
                {`axonkey-cli capture detach --instance-id "${state.candidate.instanceId}"`}
              </code>
            </div>
            <footer className="capture-safety-footer">
              <button
                type="button"
                className="capture-btn-warning"
                disabled={busy}
                onClick={() => {
                  rolledBackRef.current = true
                  onRollbackKeepAlive(state.candidate)
                }}
              >
                <RotateCcw size={14} aria-hidden="true" />
                {busy ? '正在恢复原驱动…' : '立即恢复原驱动'}
              </button>
              <button
                type="button"
                className="capture-btn-primary"
                disabled={busy}
                onClick={() => onConfirmKeepAlive(state.candidate)}
                autoFocus
              >
                <CheckCircle2 size={14} aria-hidden="true" />
                确认主输入正常
              </button>
            </footer>
          </>
        )}

        {state.mode === 'exit-cleanup' && (
          <>
            <header className="capture-safety-head">
              <ShieldAlert size={18} className="is-caution" aria-hidden="true" />
              <h2 id="capture-safety-dialog-title">退出前恢复设备系统驱动？</h2>
            </header>
            <div className="capture-safety-body">
              <p>
                本次适配期间挂载了尚未正式注册到 Axonkey
                的拦截驱动。若保留拦截驱动，退出工作台后该实体设备在系统中将暂时无法触发原生按键：
              </p>
              <ul className="capture-safety-list" aria-label="本次挂载的未注册设备">
                {state.candidates.map(item => (
                  <li key={item.instanceId}>
                    <strong>{item.displayName}</strong>
                    <span>
                      {formatVidPid(item.vid, item.pid)} · {item.instanceId}
                    </span>
                  </li>
                ))}
              </ul>
            </div>
            <footer className="capture-safety-footer">
              <button type="button" className="capture-btn-secondary" disabled={busy} onClick={onCancel}>
                取消
              </button>
              <button type="button" className="capture-btn-secondary" disabled={busy} onClick={onExitKeepDriver}>
                保留驱动
              </button>
              <button
                type="button"
                className="capture-btn-primary"
                disabled={busy}
                onClick={() => onExitAndRestore(state.candidates)}
                autoFocus
              >
                {busy ? '正在恢复…' : '退出并恢复原驱动（推荐）'}
              </button>
            </footer>
          </>
        )}
      </div>
    </dialog>
  )
}
