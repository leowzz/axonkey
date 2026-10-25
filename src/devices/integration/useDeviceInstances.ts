import { useCallback, useEffect, useRef, useState } from 'react'
import { invoke } from '@tauri-apps/api/core'
import { emptySnapshot } from './model'
import type { DeviceInstance, DeviceSnapshot } from './model'
const previewKey = 'axonkey.device-instances.preview.v1'
export function useDeviceInstances(native: boolean) {
  const [snapshot, setSnapshot] = useState<DeviceSnapshot>(emptySnapshot)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const current = useRef(snapshot)
  const queue = useRef<Promise<unknown>>(Promise.resolve())
  const accept = useCallback((value: DeviceSnapshot) => {
    if (value.store.revision < current.current.store.revision) return
    current.current = value
    setSnapshot(value)
  }, [])
  const refresh = useCallback(async () => {
    if (native) { try { accept(await invoke<DeviceSnapshot>('device_snapshot')) } catch (e) { setError(String(e)) } }
  }, [native, accept])
  useEffect(() => {
    if (!native) {
      try { const saved = localStorage.getItem(previewKey); if (saved) accept({ ...emptySnapshot(), store: JSON.parse(saved) }) }
      catch { setError('浏览器预览配置无法读取。') }
      return
    }
    let active = true
    let timer: ReturnType<typeof setTimeout>
    const poll = async () => { await refresh(); if (active) timer = setTimeout(() => void poll(), 1000) }
    void poll()
    return () => { active = false; clearTimeout(timer) }
  }, [native, refresh, accept])
  const transact = useCallback((operation: (latest: DeviceSnapshot) => Promise<DeviceSnapshot>) => {
    setBusy(true)
    const task = queue.current.catch(() => {}).then(async () => {
      const value = await operation(current.current)
      if (!native) localStorage.setItem(previewKey, JSON.stringify(value.store))
      accept(value); setError(''); return value
    })
    queue.current = task
    void task.catch(e => setError(String(e))).finally(() => { if (queue.current === task) setBusy(false) })
    return task
  }, [accept, native])
  const put = useCallback((instance: DeviceInstance) => transact(async latest => {
    if (native) return invoke<DeviceSnapshot>('put_device_instance', { revision: latest.store.revision, instance })
    const saved = { ...instance, id: instance.id || crypto.randomUUID() }
    return { ...latest, store: { ...latest.store, revision: latest.store.revision + 1, instances: [...latest.store.instances.filter(i => i.id !== saved.id), saved] } }
  }), [native, transact])
  const update = useCallback((id: string, change: (instance: DeviceInstance) => DeviceInstance) => transact(async latest => {
    const instance = latest.store.instances.find(i => i.id === id)
    if (!instance) throw new Error('设备已被移除')
    const updated = change(instance)
    if (native) return invoke<DeviceSnapshot>('put_device_instance', { revision: latest.store.revision, instance: updated })
    return { ...latest, store: { ...latest.store, revision: latest.store.revision + 1, instances: latest.store.instances.map(i => i.id === id ? updated : i) } }
  }), [native, transact])
  const remove = useCallback((id: string) => transact(async latest => {
    if (native) return invoke<DeviceSnapshot>('remove_device_instance', { revision: latest.store.revision, id })
    return { ...latest, store: { ...latest.store, revision: latest.store.revision + 1, instances: latest.store.instances.filter(i => i.id !== id) } }
  }), [native, transact])
  return { snapshot, error, busy, refresh, put, update, remove }
}
export type DeviceController = ReturnType<typeof useDeviceInstances>
