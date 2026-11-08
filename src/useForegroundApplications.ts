import { useEffect, useState } from 'react'
import { invoke } from '@tauri-apps/api/core'
import type { ForegroundApplications } from './applications'

export function useForegroundApplications(native: boolean) {
  const [snapshot, setSnapshot] = useState<ForegroundApplications>({
    supported: native,
    current: null,
    recent: [],
    error: null,
  })
  useEffect(() => {
    if (!native) return
    let active = true
    let timer: ReturnType<typeof setTimeout>
    const refresh = async () => {
      try {
        const snapshot = await invoke<ForegroundApplications>('foreground_applications')
        if (active) setSnapshot(snapshot)
      } catch (error) {
        if (active)
          setSnapshot(snapshot => ({ ...snapshot, current: null, error: `无法读取前台应用：${String(error)}` }))
      }
      if (active) timer = setTimeout(() => void refresh(), 1000)
    }
    void refresh()
    return () => {
      active = false
      clearTimeout(timer)
    }
  }, [native])
  return snapshot
}
