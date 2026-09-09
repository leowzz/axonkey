import { useCallback, useEffect, useRef, useState } from 'react'
import { invoke } from '@tauri-apps/api/core'

export type ExtraKeysStatus = {
  state: 'disabled' | 'authorizing' | 'starting' | 'waitingDevice' | 'ready' | 'error'
  message: string
  step: number
}
const storageKey = 'axonkey.extra-keys.v1'
const initialStatus: ExtraKeysStatus = { state: 'disabled', message: '', step: 0 }

export function useExtraKeys(windows: boolean, nativeRuntime: boolean, mappingEnabled: boolean, settingsReady: boolean) {
  const [wanted, setWanted] = useState(() => window.localStorage.getItem(storageKey) === 'true')
  const [status, setStatus] = useState<ExtraKeysStatus>(initialStatus)
  const [busy, setBusy] = useState(false)
  const changing = useRef(false)
  const revision = useRef(0)
  const startupHandled = useRef(false)
  useEffect(() => { window.localStorage.setItem(storageKey, String(wanted)) }, [wanted])
  useEffect(() => {
    if (!windows || !nativeRuntime) return
    let mounted = true
    let running = false
    const refresh = async () => {
      if (running || changing.current) return
      running = true
      const current = revision.current
      try {
        const next = await invoke<ExtraKeysStatus>('get_extra_keys_status')
        if (mounted && current === revision.current) setStatus(next)
      } catch (error) {
        if (mounted && current === revision.current) setStatus({ state: 'error', message: `无法读取按键服务状态：${String(error)}`, step: 0 })
      } finally { running = false }
    }
    void refresh()
    const timer = window.setInterval(refresh, 800)
    return () => { mounted = false; window.clearInterval(timer) }
  }, [windows, nativeRuntime])

  const change = useCallback(async (enable: boolean, automatic = false) => {
    startupHandled.current = true
    if (changing.current) return
    if (!nativeRuntime) {
      setStatus({ state: 'error', message: '请在 Windows 桌面应用中开启此功能。', step: 0 })
      return
    }
    if (enable && !mappingEnabled) {
      setStatus({ state: 'error', message: '请先开启顶部的“启用自定义按键功能”。', step: 0 })
      return
    }
    changing.current = true
    revision.current += 1
    setBusy(true)
    try {
      await invoke('set_extra_keys_enabled', { enabled: enable, automatic })
      setWanted(enable)
      setStatus(await invoke<ExtraKeysStatus>('get_extra_keys_status'))
    } catch (error) {
      setStatus({ state: 'error', message: String(error), step: 0 })
    } finally { changing.current = false; setBusy(false) }
  }, [nativeRuntime, mappingEnabled])

  useEffect(() => {
    // Restore only after the backend has received the saved master switch.
    // Consume this attempt before invoking so cancellation and StrictMode do
    // not cause repeated UAC prompts during the same application run.
    if (!windows || !nativeRuntime || !settingsReady || startupHandled.current) return
    startupHandled.current = true
    if (wanted && mappingEnabled) void change(true, true)
  }, [windows, nativeRuntime, settingsReady, wanted, mappingEnabled, change])
  return { wanted, status, busy, mappingEnabled, change }
}
