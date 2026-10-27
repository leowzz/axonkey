import { useRef, useState } from 'react'
import { invoke } from '@tauri-apps/api/core'
import type { DriverActionResult } from '../appTypes'
import type { DriverActionKind } from '../systemState'

export function useCableDriver(nativeRuntime: boolean) {
  const [installed, setInstalled] = useState<boolean | null>(null)
  const [busy, setBusy] = useState<'checking' | DriverActionKind | null>(null)
  const [error, setError] = useState('')
  const [message, setMessage] = useState('')
  const [rebootRequired, setRebootRequired] = useState(false)
  const running = useRef(false)

  const probe = async () => {
    if (!nativeRuntime || running.current) return
    running.current = true
    setBusy('checking')
    setError('')
    try {
      setInstalled(await invoke<boolean>('probe_cable_driver'))
    } catch (cause) {
      setInstalled(null)
      setError(`无法检测 CABLE 驱动：${String(cause)}`)
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
    try {
      const result = await invoke<DriverActionResult>('launch_driver_action', { driver: 'audio', action })
      setInstalled(action === 'install')
      setRebootRequired(current => current || result.rebootRequired)
      setMessage(`${action === 'install' ? '安装' : '卸载'}已完成。日志：${result.logPath}`)
    } catch (cause) {
      setError(`${action === 'install' ? '安装' : '卸载'}失败：${String(cause)}`)
    } finally {
      running.current = false
      setBusy(null)
    }
  }

  return { installed, busy, error, message, rebootRequired, probe, run }
}

export type CableDriverController = ReturnType<typeof useCableDriver>
