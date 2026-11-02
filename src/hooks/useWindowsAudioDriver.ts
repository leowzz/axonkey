import { useRef, useState } from 'react'
import { invoke } from '@tauri-apps/api/core'
import type { DriverActionResult } from '../appTypes'
import type { DriverActionKind } from '../systemState'

export function useWindowsAudioDriver(nativeRuntime: boolean) {
  const [installed, setInstalled] = useState<boolean | null>(null)
  const [busy, setBusy] = useState<'checking' | DriverActionKind | null>(null)
  const [error, setError] = useState('')
  const [message, setMessage] = useState('')
  const [warning, setWarning] = useState('')
  const [rebootRequired, setRebootRequired] = useState(false)
  const running = useRef(false)

  const probe = async () => {
    if (!nativeRuntime || running.current) return
    running.current = true
    setBusy('checking')
    setError('')
    try {
      setInstalled(await invoke<boolean>('probe_windows_audio_driver'))
      setWarning('')
    } catch (cause) {
      setInstalled(null)
      setError(`无法检测 Quarbor 虚拟麦克风驱动：${String(cause)}`)
    } finally {
      running.current = false
      setBusy(null)
    }
  }

  const run = async (action: DriverActionKind) => {
    if (!nativeRuntime || running.current) return
    running.current = true
    setBusy(action)
    setError('')
    setMessage('')
    setWarning('')
    try {
      const result = await invoke<DriverActionResult>('launch_driver_action', { driver: 'audio', action })
      setInstalled(result.driverInstalled ?? null)
      setRebootRequired(current => current || result.rebootRequired)
      setWarning(result.warning ?? '')
      const outcome = result.rebootRequired ? '已提交' : '已完成'
      setMessage(`${action === 'install' ? '安装' : '卸载'}${outcome}。日志：${result.logPath}`)
    } catch (cause) {
      setError(`${action === 'install' ? '安装' : '卸载'}失败：${String(cause)}`)
      try {
        setInstalled(await invoke<boolean>('probe_windows_audio_driver'))
      } catch {
        setInstalled(null)
      }
    } finally {
      running.current = false
      setBusy(null)
    }
  }

  return { installed, busy, error, message, warning, rebootRequired, probe, run }
}

export type WindowsAudioDriverController = ReturnType<typeof useWindowsAudioDriver>
