import { useEffect, useState } from 'react'
import { invoke } from '@tauri-apps/api/core'
import { downloadDir, join } from '@tauri-apps/api/path'
import AppController from '../app/index'
import { ConfigMigrationDialog } from './ConfigMigrationDialog'
import {
  createLegacyConfigExport,
  discardLegacyConfig,
  inspectConfigMigration,
  migrateConfig,
  previewInstancesKey,
} from '../configMigration'
import type { DeviceInstance, DeviceSnapshot } from '../devices/integration/model'
import { migrateBackupImport } from '../backupImport'
import type { LegacyBackupImport } from '../backupImport'

export function ConfigMigrationFlow() {
  const [plan, setPlan] = useState(() => inspectConfigMigration(window.localStorage))
  const [open, setOpen] = useState(plan.found)
  const [imported, setImported] = useState<{ data: LegacyBackupImport; fileName: string } | null>(null)
  const [appRevision, setAppRevision] = useState(0)
  const [skipUserGuide, setSkipUserGuide] = useState(plan.found)
  const [bindingId, setBindingId] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [status, setStatus] = useState('')
  const [error, setError] = useState('')
  const [completed, setCompleted] = useState(false)
  const [exportedPath, setExportedPath] = useState('')
  const [exportOnly, setExportOnly] = useState(false)
  const [remotes, setRemotes] = useState<DeviceInstance[]>([])
  const [remoteTargetId, setRemoteTargetId] = useState('')
  const [migrateMouse, setMigrateMouse] = useState(true)
  const [loadingRemotes, setLoadingRemotes] = useState(!!plan.remote)
  const [remoteLoadError, setRemoteLoadError] = useState('')
  const [remoteLoadAttempt, setRemoteLoadAttempt] = useState(0)

  useEffect(() => {
    if (!open || !plan.remote || plan.error) return
    let cancelled = false
    setLoadingRemotes(true)
    setRemoteLoadError('')
    void readDeviceStore()
      .then(store => {
        if (cancelled) return
        const matching = store.instances.filter(instance => instance.kind === plan.remote!.kind)
        const previousId = plan.remoteTargetId ?? plan.remote!.id
        setRemotes(matching)
        setRemoteTargetId(selected =>
          selected === 'skip'
            ? 'skip'
            : matching.some(instance => instance.id === previousId)
              ? previousId
              : matching.length
                ? ''
                : 'new',
        )
      })
      .catch(error => {
        if (!cancelled) setRemoteLoadError(`无法读取已有遥控器：${String(error)}`)
      })
      .finally(() => {
        if (!cancelled) setLoadingRemotes(false)
      })
    return () => {
      cancelled = true
    }
  }, [open, plan, remoteLoadAttempt])

  const finish = (id: string | null = null) => {
    setBindingId(id)
    setOpen(false)
    if (imported) {
      setImported(null)
      setPlan(inspectConfigMigration(window.localStorage))
      setAppRevision(revision => revision + 1)
    }
  }
  const run = async (skipMigration = false) => {
    setBusy(true)
    setError('')
    let savedPath = ''
    try {
      if (!imported) {
        setStatus('正在导出旧配置…')
        savedPath = await exportLegacyToDownloads()
        setExportedPath(savedPath)
      }
      let id: string | null = null
      if (skipMigration) {
        setStatus('正在删除已导出的旧配置…')
        discardLegacyConfig(window.localStorage, plan)
      } else {
        const target = remotes.find(instance => instance.id === remoteTargetId) ?? null
        const selection = { mouse: migrateMouse, remote: remoteTargetId !== 'skip' }
        id = imported
          ? await migrateBackupImport(window.localStorage, imported.data, saveRemote, setStatus, target, selection)
          : await migrateConfig(window.localStorage, plan, saveRemote, setStatus, target, true, selection)
      }
      setSkipUserGuide(true)
      setExportOnly(skipMigration)
      if (imported && id) finish(id)
      else {
        setBindingId(id)
        setCompleted(true)
      }
    } catch (error) {
      setError(
        `${imported ? '导入未完成。' : !savedPath ? '导出失败，未迁移或删除旧配置。' : skipMigration ? `旧配置已导出到 ${savedPath}，但删除失败：` : `旧配置已导出到 ${savedPath}，但迁移未完成，旧数据已保留。`}${String(error)}`,
      )
    } finally {
      setBusy(false)
    }
  }
  return (
    <>
      {(!open || imported) && (
        <AppController
          key={appRevision}
          initialBindingId={bindingId}
          skipUserGuide={skipUserGuide}
          onImportLegacyConfig={(data, fileName) => {
            setImported({ data, fileName })
            setPlan(data.plan)
            setMigrateMouse(true)
            setRemoteTargetId('')
            setError('')
            setStatus('')
            setCompleted(false)
            setExportedPath('')
            setRemoteLoadError('')
            setOpen(true)
          }}
          onOpenConfigMigration={() => {
            setBindingId(null)
            const nextPlan = inspectConfigMigration(window.localStorage)
            setPlan(nextPlan)
            setMigrateMouse(true)
            setRemoteTargetId('')
            if (nextPlan.found) setSkipUserGuide(true)
            setError('')
            setCompleted(false)
            setExportedPath('')
            setOpen(true)
          }}
        />
      )}
      {open && (
        <ConfigMigrationDialog
          plan={plan}
          busy={busy}
          error={error}
          status={status}
          completed={completed}
          exportedPath={exportedPath}
          exportOnly={exportOnly}
          importFileName={imported?.fileName}
          restoreSettings={!!imported?.data.backup}
          migrateMouse={migrateMouse}
          onSelectMouse={setMigrateMouse}
          remotes={remotes}
          remoteTargetId={remoteTargetId}
          loadingRemotes={loadingRemotes}
          remoteLoadError={remoteLoadError}
          onSelectRemote={setRemoteTargetId}
          onReloadRemotes={() => setRemoteLoadAttempt(attempt => attempt + 1)}
          onStart={() => void run()}
          onExportAndDelete={() => void run(true)}
          onClose={() => {
            if (completed) finish(bindingId)
            else {
              setOpen(false)
              if (imported) {
                setImported(null)
                setPlan(inspectConfigMigration(window.localStorage))
              }
            }
          }}
        />
      )}
    </>
  )
}

async function exportLegacyToDownloads() {
  if (!('__TAURI_INTERNALS__' in window)) throw new Error('请在桌面应用中导出并删除旧配置。')
  const { filename, content } = createLegacyConfigExport(window.localStorage)
  const path = await join(await downloadDir(), filename)
  await invoke('write_mapping_file', { path, content })
  return path
}

async function saveRemote(instance: DeviceInstance) {
  const store = await readDeviceStore()
  if ('__TAURI_INTERNALS__' in window) {
    await invoke('put_device_instance', { revision: store.revision, instance })
  } else {
    const index = store.instances.findIndex(item => item.id === instance.id)
    if (index < 0) store.instances.push(instance)
    else store.instances[index] = instance
    store.revision++
    window.localStorage.setItem(previewInstancesKey, JSON.stringify(store))
  }
}

async function readDeviceStore(): Promise<DeviceSnapshot['store']> {
  if ('__TAURI_INTERNALS__' in window) {
    const snapshot = await invoke<DeviceSnapshot>('device_snapshot')
    if (snapshot.error) throw new Error(snapshot.error)
    return snapshot.store
  } else {
    return JSON.parse(
      window.localStorage.getItem(previewInstancesKey) ?? '{"version":1,"revision":0,"instances":[]}',
    ) as DeviceSnapshot['store']
  }
}
