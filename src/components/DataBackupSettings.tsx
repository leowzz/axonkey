import { useEffect, useRef, useState } from 'react'
import type { ChangeEvent } from 'react'
import { Download, FileJson, FolderOpen, Upload } from 'lucide-react'
import { invoke } from '@tauri-apps/api/core'
import { save } from '@tauri-apps/plugin-dialog'
import { backupFilename, parseDataBackup } from '../dataBackup'
import type { BackupDocument, ParsedBackup } from '../dataBackup'
import { parseBackupImport } from '../backupImport'
import type { LegacyBackupImport } from '../backupImport'
import { devices } from '../deviceModel'
import { SettingsHelp } from './SettingsHelp'
import { logError } from '../runtimeLogging'

export type DataBackupSettingsProps = {
  nativeRuntime: boolean
  onCreateBackup: () => BackupDocument
  onRestoreBackup: (backup: ParsedBackup) => void
  onImportLegacyConfig: (backup: LegacyBackupImport, fileName: string) => void
}

export function DataBackupSettings({
  nativeRuntime,
  onCreateBackup,
  onRestoreBackup,
  onImportLegacyConfig,
}: DataBackupSettingsProps) {
  const input = useRef<HTMLInputElement>(null)
  const active = useRef(true)
  const readRevision = useRef(0)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [status, setStatus] = useState('')
  const [exportedPath, setExportedPath] = useState<string | null>(null)
  const [pending, setPending] = useState<{ fileName: string; data: ParsedBackup } | null>(null)
  useEffect(() => {
    active.current = true
    return () => {
      active.current = false
      readRevision.current++
    }
  }, [])

  const exportBackup = async () => {
    setBusy(true)
    setError('')
    setStatus('')
    setExportedPath(null)
    try {
      const backup = onCreateBackup()
      const content = JSON.stringify(backup, null, 2)
      // Verify that our export can be restored before offering it as a backup.
      parseDataBackup(content)
      const filename = backupFilename(new Date(backup.exportedAt))
      let displayedFilename = filename
      if (nativeRuntime) {
        const path = await save({
          defaultPath: filename,
          filters: [{ name: 'Axonkey 数据备份', extensions: ['json'] }],
        })
        if (!path) return
        await invoke('write_mapping_file', { path, content })
        displayedFilename = path.split(/[\\/]/).pop() || filename
        if (active.current) setExportedPath(path)
      } else {
        const url = URL.createObjectURL(new Blob([content], { type: 'application/json' }))
        const link = document.createElement('a')
        link.href = url
        link.download = filename
        document.body.appendChild(link)
        link.click()
        link.remove()
        window.setTimeout(() => URL.revokeObjectURL(url), 0)
      }
      if (active.current) setStatus(`已导出 ${displayedFilename}`)
    } catch (error) {
      logError('Failed to export data backup', error)
      if (active.current) setError(`导出失败：${error instanceof Error ? error.message : String(error)}`)
    } finally {
      if (active.current) setBusy(false)
    }
  }

  const openExport = async (directory: boolean) => {
    if (!exportedPath) return
    setBusy(true)
    setError('')
    try {
      await invoke('open_backup_location', { path: exportedPath, directory })
    } catch (error) {
      logError('Failed to open exported backup', error)
      if (active.current)
        setError(`打开${directory ? '目录' : '文件'}失败：${error instanceof Error ? error.message : String(error)}`)
    } finally {
      if (active.current) setBusy(false)
    }
  }

  const readBackup = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0]
    event.target.value = ''
    if (!file) return
    const revision = ++readRevision.current
    setBusy(true)
    setPending(null)
    setError('')
    setStatus('')
    setExportedPath(null)
    try {
      const imported = parseBackupImport(await file.text())
      if (active.current && readRevision.current === revision) {
        if (imported.kind === 'legacy') onImportLegacyConfig(imported, file.name)
        else setPending({ fileName: file.name, data: imported.data })
      }
    } catch (error) {
      if (active.current && readRevision.current === revision)
        setError(`导入失败：${error instanceof Error ? error.message : String(error)}`)
    } finally {
      if (active.current && readRevision.current === revision) setBusy(false)
    }
  }

  return (
    <>
      <div className="settings-form-fields">
        <div className="settings-form-row">
          <span className="settings-form-label">导出数据：</span>
          <div className="settings-form-control">
            <button type="button" className="dialog-secondary" disabled={busy} onClick={() => void exportBackup()}>
              <Upload size={14} />
              导出备份
            </button>
            <SettingsHelp id="data-backup-export-help" label="导出数据备份">
              导出所有配置文件、遥控器和鼠标映射、“已保存”的行为、映射开关、鼠标参数、音频设置及侧栏偏好。JSON
              文件名包含备份时间。系统授权、驱动安装、启动项和蓝牙配对由本机系统管理。
            </SettingsHelp>
          </div>
        </div>
        <div className="settings-form-row">
          <span className="settings-form-label">导入数据：</span>
          <div className="settings-form-control">
            <button type="button" className="dialog-secondary" disabled={busy} onClick={() => input.current?.click()}>
              <Download size={14} />
              导入备份
            </button>
            <input
              ref={input}
              className="mapping-file-input"
              type="file"
              accept=".json,application/json"
              aria-label="选择 Axonkey 数据备份"
              onChange={event => void readBackup(event)}
            />
            <SettingsHelp id="data-backup-import-help" label="导入数据备份">
              选择 Axonkey 数据备份 JSON
              文件，预览后确认。导入将覆盖现有配置文件、“已保存”列表和备份中的设置，并重新加载界面；当前使用的配置也会恢复为备份中的配置。旧版配置会打开迁移向导，开始迁移前可取消导入。
            </SettingsHelp>
          </div>
        </div>
      </div>
      {status && (
        <div className="settings-backup-export-result">
          <p className="settings-backup-status" role="status">
            {status}
          </p>
          {exportedPath && (
            <div className="settings-backup-actions" role="group" aria-label="导出后的操作">
              <button type="button" className="dialog-secondary" disabled={busy} onClick={() => void openExport(false)}>
                <FileJson size={14} />
                打开文件
              </button>
              <button type="button" className="dialog-secondary" disabled={busy} onClick={() => void openExport(true)}>
                <FolderOpen size={14} />
                打开目录
              </button>
            </div>
          )}
        </div>
      )}
      {error && (
        <p className="settings-form-error settings-backup-status" role="alert">
          {error}
        </p>
      )}
      {pending && (
        <section className="settings-backup-preview" aria-label="备份导入预览">
          <dl>
            <dt>备份文件</dt>
            <dd>{pending.fileName}</dd>
            <dt>备份时间</dt>
            <dd>{new Date(pending.data.exportedAt).toLocaleString()}</dd>
            <dt>配置文件</dt>
            <dd>
              <ul>
                {pending.data.profiles.map(profile => {
                  const device = devices.find(device => device.id === profile.deviceId)!
                  return (
                    <li key={profile.id}>
                      <strong>
                        {profile.name}
                        {profile.id === pending.data.activeProfileIds[profile.deviceId] && '（导入后使用）'}
                      </strong>
                      <span>
                        {device.name} ·{' '}
                        {
                          device.inputIds.filter(id => Object.values(profile.behaviors[id]).some(list => list.length))
                            .length
                        }{' '}
                        个映射
                      </span>
                    </li>
                  )
                })}
              </ul>
            </dd>
            <dt>已保存</dt>
            <dd>
              {pending.data.savedSequences.length ? (
                <ul>
                  {pending.data.savedSequences.map(saved => (
                    <li key={saved.id}>{saved.name}</li>
                  ))}
                </ul>
              ) : (
                '无'
              )}
            </dd>
            <dt>其他设置</dt>
            <dd>映射开关、鼠标参数、音频设置、侧栏偏好</dd>
          </dl>
          <p>将覆盖当前所有配置文件、“已保存”列表和上述设置，导入后重新加载界面。</p>
          <div className="settings-backup-actions">
            <button
              type="button"
              className="dialog-secondary"
              disabled={busy}
              onClick={() => {
                setPending(null)
                setError('')
              }}
            >
              取消
            </button>
            <button
              type="button"
              className="button primary"
              disabled={busy}
              onClick={() => {
                setError('')
                setBusy(true)
                try {
                  onRestoreBackup(pending.data)
                } catch (error) {
                  setBusy(false)
                  setError(`导入失败：${error instanceof Error ? error.message : String(error)}`)
                }
              }}
            >
              导入并覆盖
            </button>
          </div>
        </section>
      )}
    </>
  )
}
