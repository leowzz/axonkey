import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { invoke } from '@tauri-apps/api/core'
import { open } from '@tauri-apps/plugin-dialog'
import { FolderOpen, X } from 'lucide-react'
import type { Application, ForegroundApplications } from '../applications'
import type { Platform } from '../appTypes'
import type { DeviceInstance } from '../devices/integration/model'
import { addApplicationForEditing } from '../devices/integration/instanceProfiles'
import { ProfileManager } from './ProfileManager'
import { SettingsHelp } from './SettingsHelp'
import './ApplicationProfileToolbar.css'

export function ApplicationProfileToolbar({
  instance,
  applications,
  native,
  platform,
  editingApplicationId,
  profileId,
  onSelectApplication,
  onUpdate,
  onSwitchProfile,
  onCreateProfile,
  onDuplicateProfile,
  onRenameProfile,
  onDeleteProfile,
}: {
  instance: DeviceInstance
  applications: ForegroundApplications
  native: boolean
  platform: Platform
  editingApplicationId: string
  profileId: string
  onSelectApplication: (id: string) => void
  onUpdate: (change: (instance: DeviceInstance) => DeviceInstance) => Promise<unknown>
  onSwitchProfile: (id: string) => void
  onCreateProfile: () => void
  onDuplicateProfile: () => void
  onRenameProfile: (name: string) => void
  onDeleteProfile: () => void
}) {
  const [adding, setAdding] = useState(false)
  const [pending, setPending] = useState(false)
  const [error, setError] = useState('')
  const bindings = instance.applicationProfiles ?? []
  const recent = applications.recent.filter(
    entry => !bindings.some(binding => binding.application.id === entry.application.id),
  )
  const run = async (operation: () => Promise<unknown>) => {
    setPending(true)
    setError('')
    try {
      await operation()
    } catch (error) {
      setError(String(error))
    } finally {
      setPending(false)
    }
  }
  const add = async (application: Application) => {
    if (!bindings.some(binding => binding.application.id === application.id))
      await onUpdate(instance => addApplicationForEditing(instance, application))
    onSelectApplication(application.id)
  }
  return (
    <div className="application-profile-toolbar">
      <label className="application-edit-target">
        编辑应用
        <select
          aria-label="编辑应用"
          value={editingApplicationId}
          disabled={pending}
          onChange={event => {
            const id = event.target.value
            setError('')
            if (id === '__add_application__') {
              setAdding(true)
              return
            }
            const application = recent.find(entry => entry.application.id === id)?.application
            if (application) void run(() => add(application))
            else onSelectApplication(id)
          }}
        >
          <option value="">全局</option>
          {bindings.length > 0 && (
            <optgroup label="已添加">
              {bindings.map(binding => (
                <option key={binding.application.id} value={binding.application.id}>
                  {binding.application.name}
                </option>
              ))}
            </optgroup>
          )}
          {recent.length > 0 && (
            <optgroup label="最近使用">
              {recent.map(({ application }) => (
                <option key={application.id} value={application.id}>
                  {application.name}
                </option>
              ))}
            </optgroup>
          )}
          <option value="__add_application__">＋ 添加应用…</option>
        </select>
      </label>
      <div className="application-edit-profile">
        <span>配置</span>
        <ProfileManager
          compact
          profiles={instance.profiles}
          activeProfileId={profileId}
          onSwitch={onSwitchProfile}
          onCreate={onCreateProfile}
          onDuplicate={onDuplicateProfile}
          onRename={onRenameProfile}
          onDelete={onDeleteProfile}
          onRemoveApplication={
            editingApplicationId
              ? () =>
                  void run(async () => {
                    await onUpdate(instance => ({
                      ...instance,
                      applicationProfiles: instance.applicationProfiles?.filter(
                        binding => binding.application.id !== editingApplicationId,
                      ),
                    }))
                    onSelectApplication('')
                  })
              : undefined
          }
        />
      </div>
      <div className="application-auto-switch">
        <span>自动切换</span>
        <button
          type="button"
          role="switch"
          className={`switch ${instance.appProfileSwitching ? 'on' : ''}`}
          aria-label="按前台应用自动切换配置"
          aria-checked={instance.appProfileSwitching === true}
          disabled={pending}
          onClick={() =>
            void run(() => onUpdate(instance => ({ ...instance, appProfileSwitching: !instance.appProfileSwitching })))
          }
        >
          <span />
        </button>
        <SettingsHelp id="application-profile-help" label="自动切换">
          未关联的应用使用设备全局配置。已关联的应用中，按键切换会保存该应用的配置关联。应用关联和最近记录保存在本机。
        </SettingsHelp>
      </div>
      {(error || applications.error) && (
        <p className="application-profile-error" role="alert">
          {error || applications.error}
        </p>
      )}
      {adding && (
        <AddApplicationDialog native={native} platform={platform} onAdd={add} onClose={() => setAdding(false)} />
      )}
    </div>
  )
}

function AddApplicationDialog({
  native,
  platform,
  onAdd,
  onClose,
}: {
  native: boolean
  platform: Platform
  onAdd: (application: Application) => Promise<void>
  onClose: () => void
}) {
  const ref = useRef<HTMLDialogElement>(null)
  const [path, setPath] = useState('')
  const [pending, setPending] = useState(false)
  const [error, setError] = useState('')
  useEffect(() => {
    const previous = document.activeElement
    const dialog = ref.current
    dialog?.showModal()
    return () => {
      dialog?.close()
      if (previous instanceof HTMLElement && previous.isConnected) previous.focus()
    }
  }, [])
  const resolve = async (path: string) => {
    setPending(true)
    setError('')
    try {
      await onAdd(await invoke<Application>('resolve_application_path', { path }))
      onClose()
    } catch (error) {
      setError(String(error))
    } finally {
      setPending(false)
    }
  }
  const choose = async () => {
    setError('')
    try {
      const path = await open({
        title: '选择应用',
        multiple: false,
        filters: [{ name: '应用', extensions: platform === 'macos' ? ['app'] : ['exe', 'com'] }],
      })
      if (typeof path === 'string') {
        setPath(path)
        await resolve(path)
      }
    } catch (error) {
      setError(`无法选择应用：${String(error)}`)
    }
  }
  return createPortal(
    <dialog
      ref={ref}
      className="application-add-dialog"
      aria-labelledby="application-add-title"
      onCancel={event => {
        event.preventDefault()
        onClose()
      }}
      onClick={event => {
        if (event.target === event.currentTarget) onClose()
      }}
    >
      <form
        onSubmit={event => {
          event.preventDefault()
          void resolve(path)
        }}
      >
        <header>
          <h2 id="application-add-title">添加应用</h2>
          <button type="button" className="dialog-close" aria-label="关闭添加应用" onClick={onClose}>
            <X size={17} />
          </button>
        </header>
        <label htmlFor="application-add-path">应用路径</label>
        <div className="application-add-path">
          <input
            id="application-add-path"
            autoFocus
            value={path}
            placeholder={platform === 'macos' ? '/Applications/Example.app' : 'C:\\Program Files\\App\\App.exe'}
            onChange={event => {
              setPath(event.target.value)
              setError('')
            }}
          />
          <button
            type="button"
            className="dialog-secondary"
            aria-label="选择应用文件"
            disabled={!native || pending}
            onClick={() => void choose()}
          >
            <FolderOpen size={16} />
            选择应用
          </button>
        </div>
        {!native && <p className="application-add-hint">手动添加应用需使用桌面应用。</p>}
        {error && (
          <p className="application-profile-error" role="alert">
            {error}
          </p>
        )}
        <footer>
          <button type="button" className="dialog-secondary" onClick={onClose}>
            取消
          </button>
          <button type="submit" className="button primary" disabled={!native || pending || !path.trim()}>
            {pending ? '添加中…' : '添加'}
          </button>
        </footer>
      </form>
    </dialog>,
    document.body,
  )
}
