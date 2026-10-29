import { useEffect, useState } from 'react'
import { invoke } from '@tauri-apps/api/core'

const previewStorageKey = 'axonkey.onboarding-completed.v1'

export function useUserGuide(enabled: boolean, nativeRuntime: boolean, autoOpen = true) {
  const [open, setOpen] = useState(false)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')

  useEffect(() => {
    if (!enabled || !autoOpen) return
    let active = true
    const load = async () => {
      try {
        const completed = nativeRuntime
          ? await invoke<boolean>('get_onboarding_completed')
          : window.localStorage.getItem(previewStorageKey) === 'true'
        if (active) setOpen(!completed)
      } catch (error) {
        if (active) {
          setError(String(error))
          setOpen(true)
        }
      }
    }
    void load()
    return () => {
      active = false
    }
  }, [enabled, nativeRuntime, autoOpen])

  const complete = async () => {
    setSaving(true)
    setError('')
    try {
      if (nativeRuntime) await invoke('complete_onboarding')
      else window.localStorage.setItem(previewStorageKey, 'true')
      setOpen(false)
      return true
    } catch (error) {
      setError(`无法保存引导完成状态：${String(error)}`)
      return false
    } finally {
      setSaving(false)
    }
  }

  return { open: enabled && open, saving, error, complete, show: () => setOpen(true) }
}
