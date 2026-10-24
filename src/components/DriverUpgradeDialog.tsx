import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { invoke } from '@tauri-apps/api/core'
import { AlertCircle, Check, LoaderCircle, RefreshCw, ShieldCheck, X } from 'lucide-react'
import { logError } from '../runtimeLogging'
import './DriverUpgradeDialog.css'

export type DriverUpgradeSnapshot = {
  status: 'checking' | 'notNeeded' | 'pending' | 'running' | 'failed' | 'complete' | 'dismissed'
  stage: 'checking' | 'recorded' | 'uninstalling' | 'installing' | 'verifying' | 'complete'
  message: string
  devices: string[]
  rebootRequired: boolean
  logPath: string | null
}

export function DriverUpgradeDialog({ state, onRetry, onClose }: {
  state: DriverUpgradeSnapshot
  onRetry: () => void
  onClose: () => void
}) {
  const ref = useRef<HTMLElement>(null)
  const failed = state.status === 'failed'
  useEffect(() => {
    const root = document.getElementById('root')
    const inert = root?.inert ?? false
    const focus = document.activeElement
    const overflow = document.body.style.overflow
    if (root) root.inert = true
    document.body.style.overflow = 'hidden'
    ref.current?.focus()
    return () => {
      if (root) root.inert = inert
      document.body.style.overflow = overflow
      if (focus instanceof HTMLElement && focus.isConnected) focus.focus()
    }
  }, [])
  // A retry removes the buttons, so move focus back to the progress message.
  useEffect(() => { ref.current?.focus() }, [failed])
  const stages = ['记录原设备', '卸载旧驱动', '安装新版驱动']
  const step = state.stage === 'uninstalling' ? 1 : ['installing', 'verifying', 'complete'].includes(state.stage) ? 2 : 0
  return <div className="driver-upgrade-backdrop" role="presentation" onKeyDown={event => {
    event.stopPropagation()
    if (event.key === 'Escape') { event.preventDefault(); if (failed) onClose() }
    if (event.key !== 'Tab') return
    const buttons = Array.from(ref.current?.querySelectorAll<HTMLElement>('button, summary') ?? [])
    if (!buttons.length) { event.preventDefault(); ref.current?.focus(); return }
    const first = buttons[0]
    const last = buttons[buttons.length - 1]
    if (event.shiftKey && (document.activeElement === first || document.activeElement === ref.current)) { event.preventDefault(); last.focus() }
    else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus() }
  }}>
    <section ref={ref} tabIndex={-1} className="driver-upgrade-dialog" role="dialog" aria-modal="true" aria-labelledby="driver-upgrade-title" aria-describedby="driver-upgrade-description">
      <header>
        <span className={`driver-upgrade-icon${failed ? ' failed' : ''}`}>{failed ? <AlertCircle size={25} /> : <ShieldCheck size={25} />}</span>
        <div><h2 id="driver-upgrade-title">{failed ? '驱动升级未完成' : '正在升级驱动'}</h2><p id="driver-upgrade-description">{failed ? '请查看错误详情，处理问题后可再次尝试。' : '检测到旧版 Quarbor 驱动，正在自动升级。升级期间无法关闭窗口。'}</p></div>
        {failed && <button type="button" className="driver-upgrade-close" aria-label="关闭升级窗口" onClick={onClose}><X size={18} /></button>}
      </header>
      <ol className="driver-upgrade-steps" aria-label="升级步骤">{stages.map((label, index) => <li key={label} className={index === step ? 'current' : index < step ? 'done' : ''} aria-current={index === step ? 'step' : undefined}>
        <span>{index < step ? <Check size={14} /> : index + 1}</span>{label}
      </li>)}</ol>
      <div className={`driver-upgrade-message${failed ? ' failed' : ''}`} role={failed ? 'alert' : 'status'}>
        {!failed && <LoaderCircle size={18} className="driver-upgrade-spinner" />}<p>{state.message}</p>
      </div>
      {state.devices.length > 0 && <details><summary>原设备记录（{state.devices.length}）</summary><ul>{state.devices.map(device => <li key={device}>{device}</li>)}</ul></details>}
      {state.rebootRequired && <p className="driver-upgrade-reboot">Windows 要求重启后才能完成驱动切换。</p>}
      {failed ? <>
        {state.logPath && <p className="driver-upgrade-log">日志：{state.logPath}</p>}
        <footer><button type="button" className="button secondary" onClick={onClose}>关闭窗口</button><button type="button" className="button primary" onClick={onRetry}><RefreshCw size={15} />再次尝试升级</button></footer>
      </> : <p className="driver-upgrade-hint">请保持设备连接，并允许 Windows 弹出的管理员授权。</p>}
    </section>
  </div>
}

export function StartupDriverUpgrade({ enabled, onComplete }: { enabled: boolean; onComplete: () => void }) {
  const [state, setState] = useState<DriverUpgradeSnapshot | null>(null)
  const complete = useRef(onComplete)
  complete.current = onComplete
  const started = useRef(false)
  const [restartNotice, setRestartNotice] = useState(false)

  useEffect(() => {
    if (!enabled) return
    let active = true
    let timer: ReturnType<typeof setTimeout>
    const poll = async () => {
      try {
        const next = await invoke<DriverUpgradeSnapshot | null>('get_driver_upgrade_state')
        if (!active) return
        setState(next)
        if (!next || ['notNeeded', 'dismissed', 'complete'].includes(next.status)) {
          if (next?.status === 'complete') { setRestartNotice(next.rebootRequired); complete.current() }
          return
        }
      } catch (error) { logError('Cannot read driver upgrade state', error) }
      if (active) timer = setTimeout(() => void poll(), 400)
    }
    void poll()
    return () => { active = false; clearTimeout(timer) }
  }, [enabled])

  const run = async () => {
    setState(current => current ? { ...current, status: 'running', message: '正在准备驱动升级…' } : current)
    try { await invoke('start_driver_upgrade') }
    catch (error) {
      logError('Cannot start driver upgrade', error)
      setState(current => current ? { ...current, status: 'failed', message: String(error) } : current)
    }
  }
  useEffect(() => {
    if (state?.status !== 'pending' || started.current) return
    // Start only after the blocking modal has committed and had a chance to paint.
    let inner = 0
    const outer = requestAnimationFrame(() => {
      inner = requestAnimationFrame(() => { started.current = true; void run() })
    })
    return () => { cancelAnimationFrame(outer); cancelAnimationFrame(inner) }
  }, [state?.status])

  const dismiss = async () => {
    try { await invoke('dismiss_driver_upgrade'); setState(null); complete.current() }
    catch (error) { logError('Cannot dismiss driver upgrade', error) }
  }
  if (!enabled) return null
  if (restartNotice) return createPortal(<aside className="driver-upgrade-notice" role="status">驱动升级已提交，请重启 Windows 后使用。<button type="button" aria-label="关闭重启提示" onClick={() => setRestartNotice(false)}><X size={16} /></button></aside>, document.body)
  if (!state || !['pending', 'running', 'failed'].includes(state.status)) return null
  return createPortal(<DriverUpgradeDialog state={state} onRetry={() => void run()} onClose={() => void dismiss()} />, document.body)
}
