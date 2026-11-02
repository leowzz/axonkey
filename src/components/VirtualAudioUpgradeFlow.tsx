import { useEffect, useRef, useState, type ReactNode } from 'react'
import { invoke } from '@tauri-apps/api/core'
import { CheckCircle2, LoaderCircle, Mic } from 'lucide-react'
import { inspectConfigMigration } from '../configMigration'
import type { DriverActionResult } from '../appTypes'
import './ConfigMigrationDialog.css'
import './VirtualAudioUpgradeFlow.css'

type RemovalResult = { logPath: string; rebootRequired: boolean; error: string | null }

export function VirtualAudioUpgradeFlow({ children }: { children: ReactNode }) {
  const [state, setState] = useState<'checking' | 'required' | 'failed' | 'ready'>(() =>
    '__TAURI_INTERNALS__' in window && inspectConfigMigration(window.localStorage).found ? 'checking' : 'ready',
  )
  const [error, setError] = useState('')
  const request = useRef<Promise<boolean> | null>(null)
  useEffect(() => {
    if (state !== 'checking') return
    let active = true
    request.current ??= invoke<boolean>('probe_legacy_audio_driver')
    request.current.then(
      found => {
        if (active) setState(found ? 'required' : 'ready')
      },
      reason => {
        if (active) {
          setError(String(reason))
          setState('failed')
        }
      },
    )
    return () => {
      active = false
    }
  }, [state])

  if (state === 'ready') return children
  if (state === 'checking')
    return (
      <p className="virtual-audio-checking" role="status">
        正在检查旧版虚拟声卡…
      </p>
    )
  return (
    <VirtualAudioUpgradeDialog
      probeError={state === 'failed' ? error : ''}
      onRetryProbe={() => {
        request.current = null
        setState('checking')
      }}
      onContinue={() => setState('ready')}
    />
  )
}

export function VirtualAudioUpgradeDialog({
  probeError = '',
  manual = false,
  onRetryProbe,
  onContinue,
}: {
  probeError?: string
  manual?: boolean
  onRetryProbe?: () => void
  onContinue: () => void
}) {
  const ref = useRef<HTMLDialogElement>(null)
  const title = useRef<HTMLHeadingElement>(null)
  const running = useRef(false)
  const [phase, setPhase] = useState<'choice' | 'checking' | 'installing' | 'removing' | 'done'>('choice')
  const [installationSkipped, setInstallationSkipped] = useState(false)
  const [confirmSkip, setConfirmSkip] = useState(false)
  const [error, setError] = useState('')
  const [warning, setWarning] = useState('')
  const [installRebootRequired, setInstallRebootRequired] = useState(false)
  const [removalRebootRequired, setRemovalRebootRequired] = useState(false)
  const [logs, setLogs] = useState<string[]>([])
  const [removed, setRemoved] = useState(false)
  const busy = phase === 'checking' || phase === 'installing' || phase === 'removing'

  useEffect(() => {
    const previous = document.activeElement
    const overflow = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    const dialog = ref.current
    dialog?.showModal()
    return () => {
      dialog?.close()
      document.body.style.overflow = overflow
      if (previous instanceof HTMLElement && previous.isConnected) previous.focus()
    }
  }, [])
  useEffect(() => {
    title.current?.focus()
  }, [confirmSkip, phase])

  async function upgrade(removeLegacy: boolean) {
    if (running.current) return
    running.current = true
    setError('')
    try {
      setPhase('checking')
      const installed = await invoke<boolean>('probe_windows_audio_driver')
      setInstallationSkipped(installed)
      if (!installed) {
        setPhase('installing')
        const result = await invoke<DriverActionResult>('launch_driver_action', { driver: 'audio', action: 'install' })
        setInstallRebootRequired(value => value || result.rebootRequired)
        setLogs(value => [...new Set([...value, result.logPath])])
        setWarning(result.warning ?? '')
        if (result.driverInstalled !== true) {
          throw new Error(
            result.rebootRequired
              ? '新版驱动需要重启后才能确认安装，请重启电脑后重新打开 Axonkey。VB-CABLE 已保留。'
              : '无法确认新版驱动已安装，VB-CABLE 已保留，请重试安装。',
          )
        }
      }
      if (removeLegacy) {
        setPhase('removing')
        const result = await invoke<RemovalResult>('uninstall_legacy_audio_driver')
        setRemovalRebootRequired(value => value || result.rebootRequired)
        setLogs(value => [...new Set([...value, result.logPath])])
        if (result.error) throw new Error(`新版驱动已安装，卸载 VB-CABLE 失败：${result.error}`)
        setRemoved(true)
      }
      setPhase('done')
    } catch (reason) {
      setError(String(reason))
      setPhase('choice')
    } finally {
      running.current = false
    }
  }

  function requestClose() {
    if (running.current) return
    if (phase === 'done') onContinue()
    else setConfirmSkip(value => !value)
  }

  return (
    <dialog
      ref={ref}
      className="config-migration-dialog virtual-audio-upgrade"
      aria-labelledby="virtual-audio-upgrade-title"
      aria-describedby="virtual-audio-upgrade-description"
      aria-busy={busy}
      onKeyDown={event => {
        if (event.key !== 'Escape') return
        event.preventDefault()
        event.stopPropagation()
        requestClose()
      }}
      onCancel={event => {
        event.preventDefault()
        requestClose()
      }}
    >
      <header>
        <span className="virtual-audio-upgrade-icon">
          {phase === 'done' ? <CheckCircle2 size={26} /> : <Mic size={26} />}
        </span>
        <h2 id="virtual-audio-upgrade-title" ref={title} tabIndex={-1}>
          {confirmSkip ? '跳过虚拟声卡升级？' : '虚拟声卡升级'}
        </h2>
      </header>
      <div className="config-migration-content">
        <p id="virtual-audio-upgrade-description">
          {confirmSkip
            ? manual
              ? '尚未安装新版驱动时，遥控器麦克风功能将不可用。仍要跳过升级吗？'
              : '跳过会导致遥控器麦克风功能失效。仍要跳过升级，继续迁移配置吗？'
            : phase === 'done'
              ? `新版驱动已安装${installationSkipped ? '，已跳过安装' : ''}${removed ? '，VB-CABLE 已卸载。' : '，已保留 VB-CABLE。'}`
              : probeError
                ? '无法检查旧版虚拟声卡，请重试。'
                : manual
                  ? '可安装 Quarbor 虚拟麦克风新版驱动，并卸载电脑上检测到的 VB-CABLE 旧驱动。'
                  : '检测到你的电脑安装了 VB-CABLE 虚拟麦克风驱动，我们更换了更先进的驱动。是否需要我帮你卸载 VB-CABLE 这个老驱动并安装新版驱动？'}
        </p>
        {!confirmSkip && (
          <>
            {busy && (
              <p className="virtual-audio-upgrade-progress" role="status">
                <LoaderCircle size={17} />
                {phase === 'checking'
                  ? '正在检查 Quarbor 虚拟麦克风驱动是否已安装…'
                  : phase === 'installing'
                    ? '正在安装 Quarbor 虚拟麦克风驱动…'
                    : '新版驱动已安装，正在卸载 VB-CABLE…'}
              </p>
            )}
            {(probeError || error) && (
              <p className="config-migration-error" role="alert">
                {probeError || error}
              </p>
            )}
            {warning && <p role="status">{warning}</p>}
            {(installRebootRequired || removalRebootRequired) && (
              <p className="virtual-audio-upgrade-reboot" role="alert">
                {installRebootRequired && 'Quarbor 驱动安装需要重启电脑才能完成。'}
                {removalRebootRequired && 'VB-CABLE 卸载需要重启电脑才能完成。'}
                请保存工作后重启。
              </p>
            )}
            {logs.length > 0 && (
              <details className="virtual-audio-upgrade-logs">
                <summary>操作日志</summary>
                {logs.map(path => (
                  <p key={path}>{path}</p>
                ))}
              </details>
            )}
          </>
        )}
      </div>
      <footer>
        {confirmSkip ? (
          <>
            <button className="dialog-secondary" onClick={() => setConfirmSkip(false)}>
              返回升级
            </button>
            <button className="button primary" onClick={onContinue}>
              仍然跳过
            </button>
          </>
        ) : phase === 'done' ? (
          <button className="button primary" onClick={onContinue}>
            {manual ? '完成' : '继续迁移配置'}
          </button>
        ) : (
          <>
            {probeError ? (
              <button className="button primary" onClick={onRetryProbe}>
                重新检查
              </button>
            ) : (
              <>
                <button
                  className="dialog-secondary virtual-audio-install-only"
                  disabled={busy}
                  onClick={() => void upgrade(false)}
                >
                  只安装新版
                </button>
                <button className="button primary" disabled={busy} onClick={() => void upgrade(true)}>
                  卸载VB-CABLE并安装新版
                </button>
              </>
            )}
            <button className="virtual-audio-upgrade-skip" disabled={busy} onClick={() => setConfirmSkip(true)}>
              跳过
            </button>
          </>
        )}
      </footer>
    </dialog>
  )
}
