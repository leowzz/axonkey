import { useCallback, useEffect, useRef, useState } from 'react'
import { invoke } from '@tauri-apps/api/core'
import { listen } from '@tauri-apps/api/event'
import { emptySnapshot } from './model'
import type { DeviceInformation, DeviceInstance, DeviceSnapshot } from './model'
const previewKey = 'axonkey.device-instances.preview.v1'
type InformationUpdate = { id: string; bluetoothAddress: string | null; deviceInfo: DeviceInformation }
export function useDeviceInstances(native: boolean) {
  const [snapshot, setSnapshot] = useState<DeviceSnapshot>(emptySnapshot)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const [loaded, setLoaded] = useState(false)
  const current = useRef(snapshot)
  const queue = useRef<Promise<unknown>>(Promise.resolve())
  const pendingInformation = useRef(new Set<Map<string, InformationUpdate>>())
  const accept = useCallback((value: DeviceSnapshot, updates: Iterable<InformationUpdate> = []) => {
    if (value.store.revision < current.current.store.revision) return current.current
    const next = applyInformation(value, updates)
    current.current = next
    setSnapshot(next)
    return next
  }, [])
  const receiveSnapshot = useCallback(
    async (operation: () => Promise<DeviceSnapshot>) => {
      const updates = new Map<string, InformationUpdate>()
      pendingInformation.current.add(updates)
      try {
        return accept(await operation(), updates.values())
      } finally {
        pendingInformation.current.delete(updates)
      }
    },
    [accept],
  )
  const refresh = useCallback(
    async (throwOnError = false): Promise<DeviceSnapshot> => {
      if (native) {
        try {
          const value = await receiveSnapshot(() => invoke<DeviceSnapshot>('device_snapshot'))
          setLoaded(true)
          return value
        } catch (e) {
          setError(String(e))
          if (throwOnError) throw e
          return current.current
        }
      }
      return current.current
    },
    [native, receiveSnapshot],
  )
  useEffect(() => {
    if (!native) {
      try {
        const saved = localStorage.getItem(previewKey)
        if (saved) {
          const store: DeviceSnapshot['store'] = JSON.parse(saved)
          accept({ ...emptySnapshot(), store })
        }
        setLoaded(true)
      } catch {
        setError('浏览器预览配置无法读取。')
      }
      return
    }
    let active = true
    let timer: ReturnType<typeof setTimeout>
    let unlisten: (() => void) | undefined
    void listen<InformationUpdate>('axonkey-device-information', ({ payload }) => {
      if (!active) return
      for (const updates of pendingInformation.current) updates.set(payload.id, payload)
      accept(applyInformation(current.current, [payload]))
    })
      .then(stop => {
        if (active) unlisten = stop
        else stop()
      })
      .catch(() => {})
    const poll = async () => {
      await refresh()
      if (active) timer = setTimeout(() => void poll(), 1000)
    }
    void poll()
    return () => {
      active = false
      clearTimeout(timer)
      unlisten?.()
    }
  }, [native, refresh, accept])
  const refreshInformation = useCallback(
    async (binding: string) => {
      if (!native) return
      try {
        await receiveSnapshot(() => invoke<DeviceSnapshot>('refresh_device_information', { binding }))
        setError('')
      } catch (error) {
        setError(String(error))
        throw error
      }
    },
    [native, receiveSnapshot],
  )
  const toggleRecording = useCallback(
    async (instanceId: string) => {
      if (!native) return
      try {
        const recording = await invoke<boolean>('toggle_device_recording', { instanceId })
        const latest = current.current
        accept({
          ...latest,
          runtime: { ...latest.runtime, [instanceId]: { ...latest.runtime[instanceId], recording } },
        })
        setError('')
      } catch (error) {
        setError(String(error))
        throw error
      }
    },
    [native, accept],
  )
  const transact = useCallback(
    (operation: (latest: DeviceSnapshot) => Promise<DeviceSnapshot>) => {
      setBusy(true)
      const task = queue.current
        .catch(() => {})
        .then(async () => {
          const value = await receiveSnapshot(async () => {
            const value = await operation(current.current)
            if (!native) localStorage.setItem(previewKey, JSON.stringify(value.store))
            return value
          })
          setError('')
          return value
        })
      queue.current = task
      void task
        .catch(e => setError(String(e)))
        .finally(() => {
          if (queue.current === task) setBusy(false)
        })
      return task
    },
    [receiveSnapshot, native],
  )
  const put = useCallback(
    (instance: DeviceInstance) =>
      transact(async latest => {
        if (native) return invoke<DeviceSnapshot>('put_device_instance', { revision: latest.store.revision, instance })
        const saved = { ...instance, id: instance.id || crypto.randomUUID() }
        return {
          ...latest,
          store: {
            ...latest.store,
            revision: latest.store.revision + 1,
            instances: [...latest.store.instances.filter(i => i.id !== saved.id), saved],
          },
        }
      }),
    [native, transact],
  )
  const update = useCallback(
    (id: string, change: (instance: DeviceInstance) => DeviceInstance) =>
      transact(async latest => {
        const instance = latest.store.instances.find(i => i.id === id)
        if (!instance) throw new Error('设备已被移除')
        const updated = change(instance)
        if (native)
          return invoke<DeviceSnapshot>('put_device_instance', { revision: latest.store.revision, instance: updated })
        return {
          ...latest,
          store: {
            ...latest.store,
            revision: latest.store.revision + 1,
            instances: latest.store.instances.map(i => (i.id === id ? updated : i)),
          },
        }
      }),
    [native, transact],
  )
  const remove = useCallback(
    (id: string) =>
      transact(async latest => {
        if (native) return invoke<DeviceSnapshot>('remove_device_instance', { revision: latest.store.revision, id })
        return {
          ...latest,
          store: {
            ...latest.store,
            revision: latest.store.revision + 1,
            instances: latest.store.instances.filter(i => i.id !== id),
          },
        }
      }),
    [native, transact],
  )
  const reorder = useCallback(
    (ids: string[]) =>
      transact(async latest => {
        if (native)
          return invoke<DeviceSnapshot>('reorder_device_instances', {
            revision: latest.store.revision,
            ids,
          })
        const byId = new Map(latest.store.instances.map(instance => [instance.id, instance]))
        const instances = ids
          .map(id => byId.get(id))
          .filter((instance): instance is DeviceInstance => Boolean(instance))
        if (instances.length !== latest.store.instances.length) throw new Error('设备顺序无效')
        return {
          ...latest,
          store: {
            ...latest.store,
            revision: latest.store.revision + 1,
            instances,
          },
        }
      }),
    [native, transact],
  )
  return { snapshot, error, busy, loaded, refresh, refreshInformation, toggleRecording, put, update, remove, reorder }
}
export type DeviceController = ReturnType<typeof useDeviceInstances>

function applyInformation(snapshot: DeviceSnapshot, updates: Iterable<InformationUpdate>): DeviceSnapshot {
  const byId = new Map(Array.from(updates, update => [update.id, update]))
  if (!byId.size) return snapshot
  return {
    ...snapshot,
    discovered: snapshot.discovered.map(device => {
      const update = byId.get(device.id)
      return update &&
        device.connected &&
        device.identityQuality !== 'ambiguous' &&
        device.bluetoothAddress === update.bluetoothAddress
        ? { ...device, deviceInfo: update.deviceInfo }
        : device
    }),
  }
}
