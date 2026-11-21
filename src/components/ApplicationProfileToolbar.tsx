import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { invoke } from '@tauri-apps/api/core'
import { open } from '@tauri-apps/plugin-dialog'
import { AppWindow, Check, ChevronDown, FolderOpen, Globe, LayoutGrid, Plus, Sparkles, X } from 'lucide-react'
import type { Application, ForegroundApplications } from '../applications'
import type { Platform } from '../appTypes'
import type { DeviceInstance } from '../devices/integration/model'
import { addApplicationForEditing } from '../devices/integration/instanceProfiles'
import { ProfileManager } from './ProfileManager'
import { SettingsHelp } from './SettingsHelp'
import './ApplicationProfileToolbar.css'

export type ApplicationSelectOption = {
  id: string
  name: string
  path?: string
  detail?: string
}

const applicationIconCache = new Map<string, string>()
const inFlightApplicationIconKeys = new Set<string>()
const resolvedApplicationIconKeys = new Set<string>()
const applicationIconListeners = new Set<() => void>()

function requestApplicationIcons(items: readonly ApplicationSelectOption[]) {
  const seenIds = new Set<string>()
  const missing: { id: string; path: string }[] = []
  const batchKeys: string[] = []
  for (const item of items) {
    if (!item.id || seenIds.has(item.id) || applicationIconCache.has(item.id)) continue
    seenIds.add(item.id)
    const path = item.path ?? ''
    const requestKey = `${item.id}\0${path}`
    if (resolvedApplicationIconKeys.has(requestKey) || inFlightApplicationIconKeys.has(requestKey)) continue
    inFlightApplicationIconKeys.add(requestKey)
    batchKeys.push(requestKey)
    missing.push({ id: item.id, path })
  }
  if (missing.length === 0) return
  void invoke<Record<string, string>>('application_icons', { applications: missing })
    .then(loaded => {
      for (const key of batchKeys) {
        inFlightApplicationIconKeys.delete(key)
        resolvedApplicationIconKeys.add(key)
      }
      if (!loaded || typeof loaded !== 'object') return
      let updated = false
      for (const [id, dataUrl] of Object.entries(loaded)) {
        if (
          typeof dataUrl === 'string' &&
          dataUrl.startsWith('data:image/') &&
          applicationIconCache.get(id) !== dataUrl
        ) {
          applicationIconCache.set(id, dataUrl)
          updated = true
        }
      }
      if (updated) {
        for (const listener of applicationIconListeners) listener()
      }
    })
    .catch(() => {
      for (const key of batchKeys) {
        inFlightApplicationIconKeys.delete(key)
      }
    })
}

function ApplicationIcon({ iconUrl, global = false }: { iconUrl?: string; global?: boolean }) {
  const [failedUrl, setFailedUrl] = useState<string | null>(null)
  if (global) {
    return (
      <span className="application-icon-slot is-global" aria-hidden="true">
        <Globe size={13.5} />
      </span>
    )
  }
  if (iconUrl && failedUrl !== iconUrl) {
    return (
      <span className="application-icon-slot has-image" aria-hidden="true">
        <img
          className="application-icon-image"
          src={iconUrl}
          alt=""
          draggable={false}
          onError={() => setFailedUrl(iconUrl)}
        />
      </span>
    )
  }
  return (
    <span className="application-icon-slot is-fallback" aria-hidden="true">
      <AppWindow size={13.5} />
    </span>
  )
}

export function ApplicationSelect({
  value,
  added,
  recent,
  native,
  disabled = false,
  onSelect,
  onAddApplication,
}: {
  value: string
  added: ApplicationSelectOption[]
  recent: ApplicationSelectOption[]
  native: boolean
  disabled?: boolean
  onSelect: (id: string) => void
  onAddApplication: () => void
}) {
  const [menuOpen, setMenuOpen] = useState(false)
  const [icons, setIcons] = useState<Record<string, string>>(() => Object.fromEntries(applicationIconCache.entries()))
  const rootRef = useRef<HTMLDivElement>(null)
  const triggerRef = useRef<HTMLButtonElement>(null)

  const focusOnOpenRef = useRef(false)

  useEffect(() => {
    if (disabled) setMenuOpen(false)
  }, [disabled])

  useEffect(() => {
    if (menuOpen && focusOnOpenRef.current) {
      focusOnOpenRef.current = false
      moveOptionFocus(0)
    }
  }, [menuOpen])

  useEffect(() => {
    if (!menuOpen) return
    const onPointerDown = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setMenuOpen(false)
    }
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setMenuOpen(false)
        triggerRef.current?.focus()
      }
    }
    document.addEventListener('pointerdown', onPointerDown)
    document.addEventListener('keydown', onKeyDown)
    return () => {
      document.removeEventListener('pointerdown', onPointerDown)
      document.removeEventListener('keydown', onKeyDown)
    }
  }, [menuOpen])

  const selected = [...added, ...recent].find(item => item.id === value) ?? (value ? { id: value, name: value } : null)

  useEffect(() => {
    const sync = () => setIcons(Object.fromEntries(applicationIconCache.entries()))
    applicationIconListeners.add(sync)
    sync()
    return () => {
      applicationIconListeners.delete(sync)
    }
  }, [])

  useEffect(() => {
    if (!native) return
    requestApplicationIcons(selected ? [...added, ...recent, selected] : [...added, ...recent])
  }, [native, added, recent, selected])
  const choose = (id: string) => {
    setMenuOpen(false)
    onSelect(id)
  }
  const moveOptionFocus = (step: number) => {
    const items = Array.from(
      rootRef.current?.querySelectorAll?.<HTMLButtonElement>('.application-select-popover button:not(:disabled)') ?? [],
    )
    if (items.length === 0) return
    const active = typeof document !== 'undefined' ? (document.activeElement as HTMLButtonElement) : null
    const activeIndex = active ? items.indexOf(active) : -1
    const fallbackIndex = Math.max(
      0,
      items.findIndex(item => item.getAttribute('aria-selected') === 'true'),
    )
    const nextIndex = activeIndex < 0 ? fallbackIndex : (activeIndex + step + items.length) % items.length
    items[nextIndex]?.focus()
  }

  return (
    <div
      ref={rootRef}
      className="application-select"
      onKeyDown={event => {
        if (!menuOpen) return
        if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
          event.preventDefault()
          moveOptionFocus(event.key === 'ArrowDown' ? 1 : -1)
        }
      }}
    >
      <button
        ref={triggerRef}
        type="button"
        className="application-select-trigger"
        aria-label="编辑应用"
        aria-haspopup="listbox"
        aria-expanded={menuOpen}
        disabled={disabled}
        onClick={() => setMenuOpen(current => !current)}
        onKeyDown={event => {
          if ((event.key === 'ArrowDown' || event.key === 'ArrowUp') && !menuOpen) {
            event.preventDefault()
            event.stopPropagation?.()
            focusOnOpenRef.current = true
            setMenuOpen(true)
          }
        }}
      >
        <ApplicationIcon iconUrl={selected ? icons[selected.id] : undefined} global={!selected} />
        <span className="application-select-trigger-text">{selected ? selected.name : '全局'}</span>
        <ChevronDown size={14} className="application-select-chevron" aria-hidden="true" />
      </button>
      {menuOpen && (
        <div className="application-select-popover" role="listbox" aria-label="编辑应用选项">
          <div className="application-select-scroll">
            <button
              type="button"
              role="option"
              className="application-select-option"
              aria-selected={value === ''}
              onClick={() => choose('')}
            >
              <ApplicationIcon global />
              <span className="application-select-option-name">全局</span>
              {value === '' && <Check size={14} className="application-select-check" aria-hidden="true" />}
            </button>
            {added.length > 0 && (
              <div className="application-select-group" role="group" aria-label="已添加">
                <div className="application-select-heading" aria-hidden="true">
                  已添加
                </div>
                {added.map(item => (
                  <button
                    key={item.id}
                    type="button"
                    role="option"
                    className="application-select-option"
                    aria-selected={value === item.id}
                    onClick={() => choose(item.id)}
                  >
                    <ApplicationIcon iconUrl={icons[item.id]} />
                    <span className="application-select-option-name">{item.name}</span>
                    {item.detail && <span className="application-select-option-detail">{item.detail}</span>}
                    {value === item.id && <Check size={14} className="application-select-check" aria-hidden="true" />}
                  </button>
                ))}
              </div>
            )}
            {recent.length > 0 && (
              <div className="application-select-group" role="group" aria-label="最近使用">
                <div className="application-select-heading" aria-hidden="true">
                  最近使用
                </div>
                {recent.map(item => (
                  <button
                    key={item.id}
                    type="button"
                    role="option"
                    className="application-select-option"
                    aria-selected={value === item.id}
                    onClick={() => choose(item.id)}
                  >
                    <ApplicationIcon iconUrl={icons[item.id]} />
                    <span className="application-select-option-name">{item.name}</span>
                    {value === item.id && <Check size={14} className="application-select-check" aria-hidden="true" />}
                  </button>
                ))}
              </div>
            )}
          </div>
          <div className="application-select-actions">
            <button
              type="button"
              className="application-select-action"
              onClick={() => {
                setMenuOpen(false)
                onAddApplication()
              }}
            >
              <Plus size={15} aria-hidden="true" />
              <span>添加应用…</span>
            </button>
          </div>
        </div>
      )}
    </div>
  )
}

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
  onCreateQuickProfile,
  onOpenQuickOverlay,
  quickProfileCount,
  onOpenPresets,
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
  onCreateQuickProfile?: () => void
  onOpenQuickOverlay?: () => void
  quickProfileCount?: number
  onOpenPresets?: () => void
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
      <div className="application-edit-target">
        <span>编辑应用</span>
        <ApplicationSelect
          value={editingApplicationId}
          added={bindings.map(binding => ({
            ...binding.application,
            detail: instance.profiles.find(profile => profile.id === binding.profileId)?.name,
          }))}
          recent={recent.map(entry => entry.application)}
          native={native}
          disabled={pending}
          onSelect={id => {
            setError('')
            const application = recent.find(entry => entry.application.id === id)?.application
            if (application) void run(() => add(application))
            else onSelectApplication(id)
          }}
          onAddApplication={() => {
            setError('')
            setAdding(true)
          }}
        />
      </div>
      <div className="application-edit-profile">
        <span>配置</span>
        <ProfileManager
          compact
          profiles={instance.profiles}
          activeProfileId={profileId}
          onSwitch={onSwitchProfile}
          onCreate={onCreateProfile}
          onCreateQuick={onCreateQuickProfile}
          onOpenPresets={onOpenPresets}
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
        {onOpenPresets && (
          <button
            type="button"
            className="application-preset-button"
            title="查看并套用云端或内置预制配置"
            disabled={pending}
            onClick={onOpenPresets}
          >
            <Sparkles size={14} aria-hidden="true" />
            <span>预制</span>
          </button>
        )}
        {onOpenQuickOverlay && (
          <button
            type="button"
            className="application-quick-overlay-button"
            title="打开或新建快捷交互窗配置"
            disabled={pending}
            onClick={onOpenQuickOverlay}
          >
            <LayoutGrid size={14} aria-hidden="true" />
            <span>快捷交互窗</span>
            {Boolean(quickProfileCount && quickProfileCount > 0) && (
              <span className="application-quick-overlay-count">{quickProfileCount}</span>
            )}
          </button>
        )}
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

export function AddApplicationDialog({
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
