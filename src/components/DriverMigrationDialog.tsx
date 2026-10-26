import { useEffect, useRef, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { invoke } from '@tauri-apps/api/core'
import { ArrowRight, CheckCircle2, LoaderCircle, ShieldCheck } from 'lucide-react'
import './DriverMigrationDialog.css'

export type DriverMigrationState = {
  status: 'checking' | 'required' | 'running' | 'failed' | 'ready'
  message: string
  devices: string[]
  rebootRequired: boolean
  logPath: string | null
}

const checking: DriverMigrationState = {
  status: 'checking',
  message: '正在检查旧版按键驱动…',
  devices: [],
  rebootRequired: false,
  logPath: null,
}

export function DriverMigrationDialog({
  state,
  onRetry,
  onContinue,
}: {
  state: DriverMigrationState
  onRetry: () => void
  onContinue?: () => void
}) {
  const ref = useRef<HTMLElement>(null)
  const busy = state.status === 'checking' || state.status === 'running'
  useEffect(() => {
    const root = document.getElementById('root')
    const wasInert = root?.inert ?? false
    const previous = document.activeElement
    const overflow = document.body.style.overflow
    if (root) root.inert = true
    document.body.style.overflow = 'hidden'
    ref.current?.focus()
    return () => {
      if (root) root.inert = wasInert
      document.body.style.overflow = overflow
      if (previous instanceof HTMLElement && previous.isConnected) previous.focus()
    }
  }, [])

  useEffect(() => {
    if (!ref.current?.contains(document.activeElement)) ref.current?.focus()
  }, [state.status])

  return createPortal(
    <div
      className="driver-migration-backdrop"
      role="presentation"
      onKeyDown={event => {
        event.stopPropagation()
        if (event.key === 'Escape') event.preventDefault()
        if (event.key !== 'Tab') return
        const controls = ref.current?.querySelectorAll<HTMLElement>('button:not(:disabled), summary')
        const first = controls?.[0]
        const last = controls?.[controls.length - 1]
        if (!first) {
          event.preventDefault()
          ref.current?.focus()
        } else if (event.shiftKey && (document.activeElement === first || document.activeElement === ref.current)) {
          event.preventDefault()
          last?.focus()
        } else if (!event.shiftKey && (document.activeElement === last || document.activeElement === ref.current)) {
          event.preventDefault()
          first.focus()
        }
      }}
    >
      <section
        ref={ref}
        tabIndex={-1}
        className="driver-migration-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="driver-migration-title"
        aria-describedby="driver-migration-description"
      >
        <div className="driver-migration-icon">
          <ShieldCheck size={28} />
        </div>
        <h2 id="driver-migration-title">升级设备按键驱动</h2>
        <p id="driver-migration-description">升级会保留原设备的对应关系，升级期间会暂停按键驱动连接。</p>
        <div className="driver-migration-route">
          <span>QuarborHIDFilterUserDriver</span>
          <ArrowRight size={16} aria-hidden="true" />
          <span>QuarborUniversalKeyboardDriver</span>
        </div>
        <div className="driver-migration-status" role={state.status === 'failed' ? 'alert' : 'status'}>
          {busy && <LoaderCircle size={18} className="driver-migration-spinner" aria-hidden="true" />}
          {state.status === 'ready' && <CheckCircle2 size={18} aria-hidden="true" />}
          <span>{state.message}</span>
        </div>
        {state.devices.length > 0 && (
          <details>
            <summary>迁移设备（{state.devices.length}）</summary>
            <ul>
              {state.devices.map(device => (
                <li key={device}>{device}</li>
              ))}
            </ul>
          </details>
        )}
        {state.rebootRequired && (
          <p className="driver-migration-warning">Windows 要求重启电脑，重启后才能确保新驱动生效。</p>
        )}
        {state.logPath && <p className="driver-migration-log">日志：{state.logPath}</p>}
        <footer>
          <span>{state.status === 'ready' ? '设备迁移已完成' : '升级完成前无法关闭此窗口'}</span>
          {(state.status === 'required' || state.status === 'failed') && (
            <button type="button" className="button primary" onClick={onRetry}>
              {state.status === 'failed' ? '重试' : '开始升级'}
            </button>
          )}
          {state.status === 'ready' && onContinue && (
            <button type="button" className="button primary" onClick={onContinue}>
              继续
            </button>
          )}
        </footer>
      </section>
    </div>,
    document.body,
  )
}

export function DriverMigrationFlow({ children, onComplete }: { children?: ReactNode; onComplete?: () => void }) {
  const manual = !!onComplete
  const checkRequest = useRef<Promise<unknown>>()
  const native = '__TAURI_INTERNALS__' in window
  const [state, setState] = useState<DriverMigrationState | null>(manual ? checking : null)
  const [ready, setReady] = useState(!native)
  const [requestError, setRequestError] = useState('')
  const [pollAttempt, setPollAttempt] = useState(0)
  useEffect(() => {
    if (!native || ready) return
    let active = true
    let timer: ReturnType<typeof setTimeout>
    const poll = async () => {
      try {
        if (manual) {
          checkRequest.current ??= invoke('check_driver_migration')
          await checkRequest.current
        }
        const next = await invoke<DriverMigrationState | null>('get_driver_migration')
        if (!active) return
        setState(next)
        setRequestError('')
        if (!next || (!manual && next.status === 'ready' && !next.rebootRequired)) {
          setReady(true)
          return
        }
        if (next.status !== 'ready') timer = setTimeout(() => void poll(), 500)
      } catch (error) {
        if (active) setRequestError(`无法读取驱动迁移状态：${String(error)}`)
      }
    }
    void poll()
    return () => {
      active = false
      clearTimeout(timer)
    }
  }, [native, ready, pollAttempt, manual])

  const run = async () => {
    if (requestError) {
      checkRequest.current = undefined
      setRequestError('')
      setPollAttempt(value => value + 1)
      return
    }
    setState(current => current && { ...current, status: 'running', message: '正在准备升级…' })
    try {
      await invoke('run_driver_migration')
    } catch (error) {
      setRequestError(String(error))
    }
  }
  if (ready) return children
  if (!state && !requestError) return null
  return (
    <DriverMigrationDialog
      state={requestError ? { ...(state ?? checking), status: 'failed', message: requestError } : (state ?? checking)}
      onRetry={() => void run()}
      onContinue={() => (onComplete ? onComplete() : setReady(true))}
    />
  )
}
