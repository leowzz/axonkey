import {
  lazy,
  Suspense,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
} from 'react'
import { createPortal } from 'react-dom'
import { invoke } from '@tauri-apps/api/core'
import { appStorage } from '../../appStorage'
import {
  ChevronDown,
  ChevronRight,
  Check,
  Clock3,
  Link2Off,
  Pause,
  Plus,
  Radio,
  RefreshCw,
  Search,
  TriangleAlert,
  X,
} from 'lucide-react'
import type { LucideIcon } from 'lucide-react'
import type { MacPermissions, ManagedDriverAction, Platform } from '../../appTypes'
import { BehaviorLibraryContext } from '../../cloud/BehaviorLibraryContext'
import type { CatalogDeviceModel } from '../../cloud/deviceModelCatalog'
import { useDeviceModelCatalog } from '../../cloud/useDeviceModelCatalog'
import type { DeviceId } from '../types.ts'
import { InstanceWorkspace } from './InstanceWorkspace'
import { DeviceBindingPicker } from './IntegrationControls'
import { ModelCatalogBody, ModelTagPills } from './ModelMarkdown'
import { BatteryIndicator } from '../../components/BatteryIndicator'
import {
  buildWorkspaceDeviceOptions,
  getStoredDeviceCardOrder,
  getSupportPackages,
  instanceStatusLabel,
  deviceMatchesKind,
  instanceState,
  isMobileRemoteDevice,
  isMobileRemoteKind,
  mobileRemoteKindForSoftware,
  mobileRemoteKinds,
  mobileRemoteFallbackKind,
  newInstance,
  packageFor,
  batteryForDevice,
  getLocalCloudDescriptorOverrides,
  localCloudOverrideWarningText,
  saveDeviceCardOrder,
  subscribeSupportPackages,
  supportsWindowsDriver,
  supportsDeviceInformation,
  systemMouseCardId,
  usesHidVoice,
} from './model'
import type { DeviceInstance, DeviceKind, DiscoveredDevice } from './model'
import type { DeviceController } from './useDeviceInstances'
import './DeviceHub.css'
import './DeviceCards.css'
import '../capture/DeviceCaptureWorkbench.css'

const DeviceCaptureWorkbench = lazy(() =>
  import('../capture/DeviceCaptureWorkbench').then(mod => ({ default: mod.DeviceCaptureWorkbench })),
)
const ConnectionTroubleshootPage = lazy(() =>
  import('./ConnectionTroubleshootPage').then(mod => ({ default: mod.ConnectionTroubleshootPage })),
)

type Props = {
  bindInstanceId?: string | null
  onBindingOpened?: () => void
  selectedInstanceId: string | null
  onSelectInstance: (id: string | null) => void
  controller: DeviceController
  native: boolean
  platform: Platform
  permissions: MacPermissions
  onBrandClick: () => void
  onPermissions: () => void
  onLegacy: (id: DeviceId) => void
  onOpenAudioCalibration: (instanceId: string) => void
  onOpenAudioDriver: () => void
  onOpenBluetoothSettings: () => void
  onOpenDeviceManager: () => void
  onOpenLogs?: () => void
  driverAction: ManagedDriverAction | null
  onInstallDriver: (instanceId: string) => void
  onUnbindDevice: (instanceId: string) => Promise<void>
  onRemoveDevice: (instanceId: string) => Promise<void>
  mouseProfileName: string
  onToast?: (message: string) => void
}
type Integration = { kind?: DeviceKind; device?: DiscoveredDevice; instance?: DeviceInstance }
const discoveredDevicesExpandedKey = 'axonkey.device-hub-discovered-expanded.v1'

function getDiscoveredDevicesExpanded() {
  if (typeof window === 'undefined') return true
  try {
    return appStorage.getItem(discoveredDevicesExpandedKey) !== '0'
  } catch {
    return true
  }
}
export function DeviceHub(props: Props) {
  useSyncExternalStore(subscribeSupportPackages, getSupportPackages, getSupportPackages)
  const { controller, native } = props
  const { snapshot, error, busy } = controller
  const { selectedInstanceId: selected, onSelectInstance: setSelected } = props
  const [integration, setIntegration] = useState<Integration | null>(null)
  const [captureOpen, setCaptureOpen] = useState(false)
  const [troubleshootOpen, setTroubleshootOpen] = useState(false)
  const [draggingInstanceId, setDraggingInstanceId] = useState<string | null>(null)
  const [dragOverInstanceId, setDragOverInstanceId] = useState<string | null>(null)
  const [savedCardOrder, setSavedCardOrder] = useState<string[]>(getStoredDeviceCardOrder)
  const didDragRef = useRef(false)
  const pointerDragRef = useRef<{
    id: string
    pointerId: number
    startX: number
    startY: number
    overId: string
    active: boolean
  } | null>(null)
  useEffect(() => {
    if (!props.bindInstanceId) return
    const target = snapshot.store.instances.find(item => item.id === props.bindInstanceId)
    if (!target) return
    setIntegration({ kind: target.kind, instance: target })
    props.onBindingOpened?.()
  }, [props.bindInstanceId, props.onBindingOpened, snapshot.store.instances])
  const instance = snapshot.store.instances.find(i => i.id === selected)
  const instanceById = new Map(snapshot.store.instances.map(item => [item.id, item]))
  const allCardIds = [...snapshot.store.instances.map(item => item.id), systemMouseCardId]
  const availableCardIds = new Set(allCardIds)
  const orderedCardIds = [
    ...savedCardOrder.filter(id => availableCardIds.has(id)),
    ...allCardIds.filter(id => !savedCardOrder.includes(id)),
  ]
  const orderedCardIdsKey = orderedCardIds.join('\0')
  useEffect(() => {
    saveDeviceCardOrder(orderedCardIds)
    setSavedCardOrder(current => {
      if (current.length === orderedCardIds.length && current.every((id, index) => id === orderedCardIds[index])) {
        return current
      }
      return orderedCardIds
    })
  }, [orderedCardIdsKey])
  function reorderCards(sourceId: string, targetId: string) {
    if (sourceId === targetId) return
    const ids = [...orderedCardIds]
    const sourceIndex = ids.indexOf(sourceId)
    const targetIndex = ids.indexOf(targetId)
    if (sourceIndex < 0 || targetIndex < 0) return
    ids.splice(sourceIndex, 1)
    const nextTargetIndex = ids.indexOf(targetId)
    ids.splice(sourceIndex < targetIndex ? nextTargetIndex + 1 : nextTargetIndex, 0, sourceId)
    setSavedCardOrder(ids)
    saveDeviceCardOrder(ids)
    const managedIds = ids.filter(id => id !== systemMouseCardId && instanceById.has(id))
    const currentManagedIds = snapshot.store.instances.map(item => item.id)
    if (managedIds.some((id, index) => id !== currentManagedIds[index])) void controller.reorder(managedIds)
  }
  function finishDevicePointerDrag(targetId?: string) {
    const drag = pointerDragRef.current
    if (!drag) return
    const source = document.querySelector<HTMLElement>(`[data-instance-id="${CSS.escape(drag.id)}"]`)
    if (source?.hasPointerCapture(drag.pointerId)) source.releasePointerCapture(drag.pointerId)
    if (drag.active) {
      didDragRef.current = true
      const destinationId = targetId ?? drag.overId
      if (destinationId && destinationId !== drag.id) reorderCards(drag.id, destinationId)
    }
    pointerDragRef.current = null
    setDraggingInstanceId(null)
    setDragOverInstanceId(null)
    window.setTimeout(() => {
      didDragRef.current = false
    }, 0)
  }
  function handleDevicePointerDown(event: ReactPointerEvent<HTMLButtonElement>, id: string) {
    if (event.button !== 0) return
    event.currentTarget.setPointerCapture(event.pointerId)
    didDragRef.current = false
    pointerDragRef.current = {
      id,
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      overId: id,
      active: false,
    }
  }
  useEffect(() => {
    const trackPointer = (event: PointerEvent) => {
      const drag = pointerDragRef.current
      if (!drag || drag.pointerId !== event.pointerId) return
      const target = document.elementFromPoint(event.clientX, event.clientY)?.closest<HTMLElement>('[data-instance-id]')
        ?.dataset.instanceId
      drag.overId = target ?? ''
      if (!drag.active) {
        const distance = Math.hypot(event.clientX - drag.startX, event.clientY - drag.startY)
        if (distance < 6) return
        drag.active = true
        didDragRef.current = true
        setDraggingInstanceId(drag.id)
      }
      event.preventDefault()
      setDragOverInstanceId(target && target !== drag.id ? target : null)
    }
    const finishOutsideCard = (event: PointerEvent) => {
      if (pointerDragRef.current?.pointerId === event.pointerId) {
        event.preventDefault()
        finishDevicePointerDrag()
      }
    }
    window.addEventListener('pointermove', trackPointer)
    window.addEventListener('pointerup', finishOutsideCard)
    window.addEventListener('pointercancel', finishOutsideCard)
    return () => {
      window.removeEventListener('pointermove', trackPointer)
      window.removeEventListener('pointerup', finishOutsideCard)
      window.removeEventListener('pointercancel', finishOutsideCard)
    }
  })
  const localCloudOverrides = getLocalCloudDescriptorOverrides()
  const banner = (
    <>
      {!native && <p className="managed-notice">浏览器预览 · 设备连接需使用桌面应用</p>}
      {(error || snapshot.error || snapshot.scanError) && (
        <p className="managed-error" role="alert">
          {error || snapshot.error || snapshot.scanError}
        </p>
      )}
      {!instance && renderLocalCloudOverrideWarning(localCloudOverrides, native)}
    </>
  )
  return (
    <section
      className={`managed-hub ${instance || captureOpen || troubleshootOpen ? 'has-workspace mapping-active' : ''}`}
    >
      {!captureOpen && !troubleshootOpen && banner}
      {instance ? (
        <InstanceWorkspace
          key={instance.id}
          {...props}
          instance={instance}
          deviceOptions={buildWorkspaceDeviceOptions(snapshot.store.instances, orderedCardIds)}
          onSelectDevice={id => {
            if (id === systemMouseCardId) props.onLegacy('mouse')
            else setSelected(id)
          }}
          batteryLevel={batteryForDevice(instance.binding, snapshot.discovered)}
          onBack={() => setSelected(null)}
          onBind={() => setIntegration({ kind: instance.kind, instance })}
        />
      ) : captureOpen ? (
        <Suspense fallback={null}>
          <DeviceCaptureWorkbench
            native={native}
            onBack={() => setCaptureOpen(false)}
            onDevicesChanged={() => void controller.refresh()}
            onInstalledLocalDevice={installedKind => {
              void (async () => {
                const snap = await controller.refresh()
                const matched = snap.discovered.find(
                  d => deviceMatchesKind(d, installedKind) && !snap.store.instances.some(i => i.binding === d.id),
                )
                setCaptureOpen(false)
                setIntegration({ kind: installedKind, ...(matched ? { device: matched } : {}) })
              })()
            }}
            onToast={props.onToast}
          />
        </Suspense>
      ) : troubleshootOpen ? (
        <Suspense fallback={null}>
          <ConnectionTroubleshootPage
            native={native}
            platform={props.platform}
            onBack={() => setTroubleshootOpen(false)}
            onOpenBluetoothSettings={props.onOpenBluetoothSettings}
            onOpenDeviceManager={props.onOpenDeviceManager}
            onOpenLogs={props.onOpenLogs}
            onToast={props.onToast}
          />
        </Suspense>
      ) : (
        <>
          <header className="my-devices-heading">
            <div className="my-devices-heading-main">
              <button className="my-devices-brand" aria-label="Axonkey" title="Axonkey" onClick={props.onBrandClick}>
                <img src={new URL('../../../src-tauri/icons/128x128@2x.png', import.meta.url).href} alt="" />
                Axonkey
              </button>
              <h1 id="my-devices-title">我的设备</h1>
              <span className="my-devices-total">{orderedCardIds.length} 台已接入</span>
            </div>
            <div className="my-devices-heading-actions">
              <button className="my-devices-integrate" onClick={() => setCaptureOpen(true)}>
                <Radio size={15} />
                适配新设备
              </button>
              <button className="my-devices-integrate" onClick={() => setIntegration({})}>
                <Plus size={15} />
                手动添加设备
              </button>
            </div>
          </header>
          <div className="managed-device-sections">
            <section className="managed-device-section" aria-labelledby="my-devices-title">
              <div className="managed-device-grid">
                {orderedCardIds.map(cardId => {
                  const item = instanceById.get(cardId)
                  if (item) {
                    return (
                      <DeviceCard
                        key={item.id}
                        instanceId={item.id}
                        kind={item.kind}
                        title={item.name}
                        subtitle={`实例 ${item.id.slice(-6)} · ${packageFor(item.kind).model}`}
                        status={native ? instanceStatusLabel(item, snapshot) : '预览配置'}
                        state={native ? instanceState(item, snapshot) : undefined}
                        unbound={!item.binding}
                        batteryLevel={batteryForDevice(item.binding, snapshot.discovered)}
                        profile={
                          item.profiles.find(
                            p =>
                              p.id ===
                              (controller.snapshot.runtime[item.id]?.effectiveProfileId ?? item.activeProfileId),
                          )?.name
                        }
                        applicationProfileCount={item.applicationProfiles?.length ?? 0}
                        applicationProfileSwitching={item.appProfileSwitching === true}
                        onClick={() => {
                          if (didDragRef.current) {
                            didDragRef.current = false
                            return
                          }
                          setSelected(item.id)
                        }}
                        dragging={draggingInstanceId === item.id}
                        dragOver={dragOverInstanceId === item.id}
                        onPointerDown={event => handleDevicePointerDown(event, item.id)}
                      />
                    )
                  }
                  if (cardId !== systemMouseCardId) return null
                  return (
                    <DeviceCard
                      key={systemMouseCardId}
                      instanceId={systemMouseCardId}
                      kind="mouse"
                      title="系统鼠标"
                      subtitle="按键、滚轮和屏幕边缘"
                      status="系统输入源"
                      profile={props.mouseProfileName}
                      dragging={draggingInstanceId === systemMouseCardId}
                      dragOver={dragOverInstanceId === systemMouseCardId}
                      onPointerDown={event => handleDevicePointerDown(event, systemMouseCardId)}
                      onClick={() => {
                        if (didDragRef.current) {
                          didDragRef.current = false
                          return
                        }
                        props.onLegacy('mouse')
                      }}
                    />
                  )
                })}
              </div>
            </section>
            <DeviceDiscoverySection
              {...props}
              onIntegrated={setSelected}
              onOpenTroubleshoot={() => setTroubleshootOpen(true)}
            />
          </div>
        </>
      )}
      {integration &&
        createPortal(
          <IntegrationDialog
            {...props}
            initial={integration}
            onClose={() => setIntegration(null)}
            onOpenCapture={() => {
              setIntegration(null)
              setCaptureOpen(true)
            }}
            onComplete={id => {
              setIntegration(null)
              setSelected(id)
            }}
          />,
          document.body,
        )}
      {busy && (
        <span className="managed-saving" role="status">
          正在保存…
        </span>
      )}
    </section>
  )
}
type IntegrationProps = Pick<Props, 'controller' | 'native' | 'platform' | 'permissions' | 'onPermissions'>
export type DeviceDiscoveryProps = IntegrationProps &
  Pick<Props, 'onOpenBluetoothSettings' | 'onOpenDeviceManager' | 'onOpenLogs' | 'onToast'> & {
    guide?: boolean
    onIntegrated: (id: string) => void
    onOpenTroubleshoot?: () => void
  }

export function DeviceDiscoverySection(props: DeviceDiscoveryProps) {
  const packages = useSyncExternalStore(subscribeSupportPackages, getSupportPackages, getSupportPackages)
  const { controller, native, guide = false } = props
  const { snapshot, error, busy } = controller
  const libraryContext = useContext(BehaviorLibraryContext)
  const retainedKinds = useMemo(() => snapshot.store.instances.map(item => item.kind), [snapshot.store.instances])
  const { refresh: refreshCatalog, loading: catalogLoading } = useDeviceModelCatalog(
    libraryContext?.client,
    libraryContext?.accountReady ?? true,
    {
      native,
      retainedKinds,
      onNativeDescriptorsSynced: () => void controller.refresh(),
    },
  )
  const [integration, setIntegration] = useState<Integration | null>(null)
  const [discoveryHelpOpen, setDiscoveryHelpOpen] = useState(false)
  const [troubleshootModalOpen, setTroubleshootModalOpen] = useState(false)
  const [discoveredExpanded, setDiscoveredExpanded] = useState(() => guide || getDiscoveredDevicesExpanded())
  const unboundDevices = snapshot.discovered.filter(
    d => deviceMatchesKind(d, d.kind) && !snapshot.store.instances.some(i => i.binding === d.id),
  )
  useEffect(() => {
    if (guide || typeof window === 'undefined') return
    try {
      appStorage.setItem(discoveredDevicesExpandedKey, discoveredExpanded ? '1' : '0')
    } catch {
      /* UI preference is best-effort. */
    }
  }, [discoveredExpanded, guide])

  return (
    <>
      {guide && (
        <section className="user-guide-supported" aria-labelledby="user-guide-supported-title">
          <h3 id="user-guide-supported-title">支持的设备</h3>
          <ul className="managed-package-grid">
            {packages.map(pkg => {
              const subtitle = packageSubtitle(pkg)
              return (
                <li key={pkg.kind} className="managed-package" data-kind={pkg.kind}>
                  <span className="managed-package-artwork">
                    <img src={pkg.artwork} alt="" />
                  </span>
                  <span className="managed-package-meta">
                    <strong>{pkg.name}</strong>
                    {subtitle && <small>{subtitle}</small>}
                  </span>
                </li>
              )
            })}
          </ul>
        </section>
      )}
      {guide && !native && <p className="managed-notice">浏览器预览 · 设备连接需使用桌面应用</p>}
      {guide && (error || snapshot.error || snapshot.scanError) && (
        <p className="managed-error" role="alert">
          {error || snapshot.error || snapshot.scanError}
        </p>
      )}
      <details
        className="managed-discovered-section"
        open={discoveredExpanded}
        onToggle={event => setDiscoveredExpanded(event.currentTarget.open)}
      >
        <summary className="managed-discovered-summary">
          <span>发现设备</span>
          <span className="managed-discovered-count">{unboundDevices.length}</span>
          <button
            type="button"
            className="managed-discovery-help"
            aria-haspopup="dialog"
            onClick={event => {
              event.preventDefault()
              event.stopPropagation()
              setDiscoveryHelpOpen(true)
            }}
          >
            找不到设备？
          </button>
          <button
            type="button"
            className={`managed-icon managed-discovery-refresh${catalogLoading ? ' is-spinning' : ''}`}
            aria-label="刷新设备"
            title="刷新设备"
            onClick={event => {
              event.preventDefault()
              event.stopPropagation()
              void (async () => {
                await refreshCatalog().catch(() => {})
                await controller.refresh()
              })()
            }}
            disabled={!native && !libraryContext?.client}
          >
            <RefreshCw size={14} />
          </button>
        </summary>
        <div className="managed-discovered-content">
          {guide && unboundDevices.length === 0 && <p className="managed-notice">暂未发现可添加的设备。</p>}
          <div className="managed-device-grid">
            {unboundDevices.map(device => (
              <DeviceCard
                key={device.id}
                kind={device.kind}
                discovered
                title={isMobileRemoteDevice(device) ? '移动系列遥控器' : packageFor(device.kind).name}
                subtitle={`${device.transport === 'Bluetooth' ? '蓝牙' : device.transport} · ${device.id.slice(-6)}`}
                status={
                  device.identityQuality === 'ambiguous'
                    ? '实例标识冲突，无法自动绑定'
                    : device.connected
                      ? '点击集成'
                      : '未连接'
                }
                batteryLevel={batteryForDevice(device.id, snapshot.discovered)}
                onClick={() => setIntegration({ kind: device.kind, device })}
              />
            ))}
          </div>
        </div>
      </details>
      {discoveryHelpOpen &&
        createPortal(
          <DiscoveryHelpDialog
            native={native}
            platform={props.platform}
            onOpenBluetoothSettings={props.onOpenBluetoothSettings}
            onOpenDeviceManager={props.onOpenDeviceManager}
            onOpenTroubleshoot={() => {
              setDiscoveryHelpOpen(false)
              if (props.onOpenTroubleshoot) {
                props.onOpenTroubleshoot()
              } else {
                setTroubleshootModalOpen(true)
              }
            }}
            onClose={() => setDiscoveryHelpOpen(false)}
          />,
          document.body,
        )}

      {troubleshootModalOpen &&
        createPortal(
          <TroubleshootModalDialog
            native={native}
            platform={props.platform}
            onOpenBluetoothSettings={props.onOpenBluetoothSettings}
            onOpenDeviceManager={props.onOpenDeviceManager}
            onOpenLogs={props.onOpenLogs}
            onToast={props.onToast}
            onClose={() => setTroubleshootModalOpen(false)}
          />,
          document.body,
        )}

      {integration &&
        createPortal(
          <IntegrationDialog
            {...props}
            initial={integration}
            onClose={() => setIntegration(null)}
            onComplete={id => {
              setIntegration(null)
              props.onIntegrated(id)
            }}
          />,
          document.body,
        )}
      {guide && busy && (
        <p className="managed-notice" role="status">
          正在保存…
        </p>
      )}
    </>
  )
}

function DiscoveryHelpDialog({
  native,
  platform,
  onOpenBluetoothSettings,
  onOpenDeviceManager,
  onOpenTroubleshoot,
  onClose,
}: Pick<Props, 'native' | 'platform' | 'onOpenBluetoothSettings' | 'onOpenDeviceManager'> & {
  onOpenTroubleshoot: () => void
  onClose: () => void
}) {
  const dialogRef = useRef<HTMLDialogElement>(null)
  useEffect(() => {
    const dialog = dialogRef.current
    const previousFocus = document.activeElement
    dialog?.showModal()
    return () => {
      dialog?.close()
      if (previousFocus instanceof HTMLElement && previousFocus.isConnected) previousFocus.focus()
    }
  }, [])
  const system = platform === 'windows' ? 'Windows 设置' : platform === 'macos' ? 'macOS 系统设置' : '系统设置'
  return (
    <dialog
      ref={dialogRef}
      className="managed-discovery-help-dialog"
      aria-labelledby="managed-discovery-help-title"
      aria-describedby="managed-discovery-help-description"
      onCancel={onClose}
      onClick={event => {
        if (event.target === event.currentTarget) onClose()
      }}
    >
      <div>
        <header className="behavior-dialog-head">
          <h2 id="managed-discovery-help-title">找不到设备？</h2>
        </header>
        <div className="behavior-dialog-body">
          <p id="managed-discovery-help-description">蓝牙设备需要先在 {system}中进行蓝牙配对。</p>
        </div>
        <footer className="managed-dialog-footer">
          <button type="button" className="managed-discovery-troubleshoot" onClick={onOpenTroubleshoot}>
            设备无法连接排查
          </button>
          {platform === 'windows' && (
            <button type="button" onClick={onOpenDeviceManager} disabled={!native}>
              打开设备管理器
            </button>
          )}
          <button
            type="button"
            className="managed-primary"
            disabled={!native || (platform !== 'windows' && platform !== 'macos')}
            onClick={onOpenBluetoothSettings}
          >
            打开系统蓝牙设置
          </button>
          <button type="button" onClick={onClose} autoFocus>
            关闭
          </button>
        </footer>
      </div>
    </dialog>
  )
}

function TroubleshootModalDialog({
  native,
  platform,
  onOpenBluetoothSettings,
  onOpenDeviceManager,
  onOpenLogs,
  onToast,
  onClose,
}: Pick<Props, 'native' | 'platform' | 'onOpenBluetoothSettings' | 'onOpenDeviceManager' | 'onOpenLogs' | 'onToast'> & {
  onClose: () => void
}) {
  const dialogRef = useRef<HTMLDialogElement>(null)
  useEffect(() => {
    const dialog = dialogRef.current
    const previousFocus = document.activeElement
    dialog?.showModal()
    return () => {
      dialog?.close()
      if (previousFocus instanceof HTMLElement && previousFocus.isConnected) previousFocus.focus()
    }
  }, [])
  return (
    <dialog
      ref={dialogRef}
      className="troubleshoot-dialog"
      aria-label="设备无法连接排查"
      onCancel={onClose}
      onClick={event => {
        if (event.target === event.currentTarget) onClose()
      }}
    >
      <div className="troubleshoot-dialog-shell">
        <Suspense fallback={null}>
          <ConnectionTroubleshootPage
            native={native}
            platform={platform}
            backLabel="关闭"
            onBack={onClose}
            onOpenBluetoothSettings={onOpenBluetoothSettings}
            onOpenDeviceManager={onOpenDeviceManager}
            onOpenLogs={onOpenLogs}
            onToast={onToast}
          />
        </Suspense>
      </div>
    </dialog>
  )
}

const deviceStatusAppearance: Record<
  string,
  { icon: LucideIcon; tone: 'ready' | 'muted' | 'connecting' | 'warning' | 'error' }
> = {
  exclusive: { icon: Check, tone: 'ready' },
  paused: { icon: Pause, tone: 'muted' },
  disconnected: { icon: Link2Off, tone: 'muted' },
  needsRebind: { icon: Link2Off, tone: 'warning' },
  opening: { icon: RefreshCw, tone: 'connecting' },
  unbound: { icon: Link2Off, tone: 'warning' },
  unsupported: { icon: Clock3, tone: 'warning' },
  error: { icon: TriangleAlert, tone: 'error' },
}

function DeviceCard({
  kind,
  instanceId,
  discovered = false,
  unbound = false,
  title,
  subtitle,
  status,
  state,
  profile,
  applicationProfileCount = 0,
  applicationProfileSwitching = false,
  batteryLevel = null,
  onClick,
  dragging = false,
  dragOver = false,
  onPointerDown,
}: {
  kind: DeviceKind | 'mouse'
  instanceId?: string
  discovered?: boolean
  unbound?: boolean
  title: string
  subtitle: string
  status: string
  state?: string
  profile?: string
  applicationProfileCount?: number
  applicationProfileSwitching?: boolean
  batteryLevel?: number | null
  onClick: () => void
  dragging?: boolean
  dragOver?: boolean
  onPointerDown?: (event: ReactPointerEvent<HTMLButtonElement>) => void
}) {
  const appearance = state ? deviceStatusAppearance[state] : undefined
  const StatusIcon = appearance?.icon
  return (
    <button
      className={`my-devices-card${kind === 'mouse' ? ' managed-system-mouse' : ''}`}
      data-instance-id={instanceId}
      data-discovered={discovered || undefined}
      data-unbound={unbound || undefined}
      data-dragging={dragging || undefined}
      data-drag-over={dragOver || undefined}
      onPointerDown={onPointerDown}
      onClick={onClick}
    >
      <div className="my-devices-card-main">
        <span className="my-devices-artwork">
          <img src={kind === 'mouse' ? '/mouse-device.svg' : packageFor(kind).artwork} alt="" />
        </span>
        <span className="my-devices-identity">
          <strong>{title}</strong>
          <span className="my-devices-count">{subtitle}</span>
        </span>
      </div>
      <span className="my-devices-summary">
        <span className="my-devices-telemetry">
          {unbound ? (
            <span className="my-devices-unbound-badge">
              <Link2Off size={14} aria-hidden="true" />
              未绑定
            </span>
          ) : (
            <span className="my-devices-status" data-tone={appearance?.tone}>
              {StatusIcon ? (
                <StatusIcon size={12} aria-hidden="true" />
              ) : (
                <i className="my-devices-status-dot" aria-hidden="true" />
              )}
              <span>{status}</span>
            </span>
          )}
        </span>
        {!unbound && kind !== 'mouse' && supportsDeviceInformation(kind) && (
          <span className="my-devices-power">
            <BatteryIndicator level={batteryLevel} />
          </span>
        )}
        <span className="my-devices-profile">
          {profile ? (
            <strong className="my-devices-profile-current">{profile}</strong>
          ) : (
            <ChevronRight size={15} aria-hidden="true" />
          )}
          {applicationProfileCount > 0 && (
            <small className="my-devices-application-profiles">
              {applicationProfileCount} 个应用配置{applicationProfileSwitching ? ' · 自动切换' : ' · 已暂停'}
            </small>
          )}
        </span>
      </span>
    </button>
  )
}
type IntegrationStep = 'kind' | 'mobile-model' | 'details'

function packageSubtitle(pkg: { kind: DeviceKind; name: string; model: string }, platform?: Platform) {
  const model = pkg.model.split(' · ')[0]
  return [
    pkg.name.includes(model) ? '' : model,
    usesHidVoice(pkg.kind) && platform && platform !== 'windows' && platform !== 'macos' ? '仅配置' : '',
  ]
    .filter(Boolean)
    .join(' · ')
}

function renderLocalCloudOverrideWarning(
  overrides: ReturnType<typeof getLocalCloudDescriptorOverrides>,
  native: boolean,
) {
  if (overrides.length === 0) return null
  return (
    <div className="managed-warning" role="status">
      <TriangleAlert size={15} aria-hidden="true" />
      <span>{localCloudOverrideWarningText(overrides)}</span>
      {native && (
        <button
          type="button"
          onClick={() => {
            void invoke('open_local_custom_devices_dir', { highlightFile: null }).catch(() => {})
          }}
        >
          打开本机目录
        </button>
      )}
    </div>
  )
}

function catalogCardSubtitle(
  pkg: { kind: DeviceKind; name: string; model: string },
  catalogModel: CatalogDeviceModel | undefined,
  platform?: Platform,
) {
  const brand = catalogModel?.brand_name
  const showBrand = brand && !pkg.name.toLowerCase().includes(brand.toLowerCase())
  return [showBrand ? brand : '', packageSubtitle(pkg, platform)].filter(Boolean).join(' · ')
}

function IntegrationDialog({
  initial,
  controller,
  native,
  platform,
  permissions,
  onPermissions,
  onClose,
  onOpenCapture,
  onComplete,
}: IntegrationProps & {
  initial: Integration
  onClose: () => void
  onOpenCapture?: () => void
  onComplete: (id: string) => void
}) {
  const packages = useSyncExternalStore(subscribeSupportPackages, getSupportPackages, getSupportPackages)
  const manualAdd = !initial.kind && !initial.instance
  const mobileModelSelection = Boolean(initial.device && isMobileRemoteDevice(initial.device) && !initial.instance)
  const libraryContext = useContext(BehaviorLibraryContext)
  const retainedKinds = useMemo(
    () => controller.snapshot.store.instances.map(item => item.kind),
    [controller.snapshot.store.instances],
  )
  const {
    modelsByCode,
    loading: catalogLoading,
    refresh: refreshCatalog,
  } = useDeviceModelCatalog(libraryContext?.client, libraryContext?.accountReady ?? true, {
    native,
    retainedKinds,
    onNativeDescriptorsSynced: () => void controller.refresh(),
  })
  const [kind, setKind] = useState<DeviceKind | undefined>(() =>
    mobileModelSelection ? mobileRemoteFallbackKind : (initial.kind ?? packages[0]?.kind),
  )
  const [step, setStep] = useState<IntegrationStep>(() => (initial.kind ? 'details' : 'kind'))
  const [name, setName] = useState(
    () =>
      initial.instance?.name ??
      (mobileModelSelection
        ? packageFor(mobileRemoteFallbackKind).name
        : initial.kind
          ? packageFor(initial.kind).name
          : ''),
  )
  const [nameCustomized, setNameCustomized] = useState(false)
  const [selectedBrand, setSelectedBrand] = useState<string>('all')
  const [searchQuery, setSearchQuery] = useState('')
  const [detailsCatalogExpanded, setDetailsCatalogExpanded] = useState(false)
  // null follows discovery defaults; an empty string is the user's explicit “bind later” choice.
  const [bindingChoice, setBindingChoice] = useState<string | null>(
    initial.device?.id ?? initial.instance?.binding ?? null,
  )
  const [localError, setError] = useState('')
  const [recognizing, setRecognizing] = useState(false)
  const dialog = useRef<HTMLDialogElement>(null)
  const packageGridRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const modal = dialog.current
    const focus = document.activeElement
    modal?.showModal()
    return () => {
      modal?.close()
      if (focus instanceof HTMLElement && focus.isConnected) focus.focus()
    }
  }, [])
  const availableBrands = useMemo(() => {
    const seen = new Set<string>()
    const list: string[] = []
    for (const pkg of packages) {
      const brand = modelsByCode.get(pkg.kind)?.brand_name
      if (brand && !seen.has(brand)) {
        seen.add(brand)
        list.push(brand)
      }
    }
    return list
  }, [modelsByCode, packages])
  const effectiveBrand = selectedBrand !== 'all' && availableBrands.includes(selectedBrand) ? selectedBrand : 'all'
  const filteredPackages = useMemo(() => {
    const normalizedQuery = searchQuery.trim().toLowerCase()
    return packages.filter(pkg => {
      const catalog = modelsByCode.get(pkg.kind)
      if (effectiveBrand !== 'all' && catalog?.brand_name !== effectiveBrand) return false
      if (!normalizedQuery) return true
      return [
        pkg.name,
        pkg.model,
        pkg.kind,
        catalog?.name,
        catalog?.model,
        catalog?.brand_name,
        ...(catalog?.tags ?? []),
      ].some(field => field?.toLowerCase().includes(normalizedQuery))
    })
  }, [effectiveBrand, modelsByCode, packages, searchQuery])
  const effectivePackage =
    (kind ? filteredPackages.find(p => p.kind === kind) : undefined) ?? filteredPackages[0] ?? null
  const activeCatalogModel = effectivePackage ? modelsByCode.get(effectivePackage.kind) : undefined
  const localCloudOverrides = getLocalCloudDescriptorOverrides()
  const effectiveOverrides = effectivePackage
    ? localCloudOverrides.filter(item => item.kind === effectivePackage.kind)
    : []
  const candidates = controller.snapshot.discovered.filter(
    d =>
      (isMobileRemoteKind(kind) ? isMobileRemoteDevice(d) : kind && deviceMatchesKind(d, kind)) &&
      !controller.snapshot.store.instances.some(i => i.id !== initial.instance?.id && i.binding === d.id),
  )
  const binding = bindingChoice ?? candidates.find(d => d.identityQuality !== 'ambiguous')?.id ?? ''
  const device = candidates.find(d => d.id === binding)
  const needsMobileModelSelection = !initial.instance && Boolean(device && isMobileRemoteDevice(device))
  const selectedPackage = kind ? packageFor(kind) : null
  const selectedOverrides = selectedPackage
    ? localCloudOverrides.filter(item => item.kind === selectedPackage.kind)
    : []
  const selectedCatalog = kind ? modelsByCode.get(kind) : undefined
  const hasSelectedCatalogDetails =
    !needsMobileModelSelection &&
    Boolean(
      selectedCatalog &&
      (selectedCatalog.description || selectedCatalog.tags.length > 0 || selectedCatalog.links.length > 0),
    )
  const recognitionError =
    '识别失败，请按下遥控器任意按钮，然后再次尝试 一键识别。如果依然识别失败，请看遥控器背面或者说明书确认型号，并手动选择。'
  function proceedWithPackage(pkg: (typeof packages)[number]) {
    const changed = pkg.kind !== kind || !name.trim()
    setKind(pkg.kind)
    if (changed || !nameCustomized) {
      setName(pkg.name)
      setNameCustomized(false)
    }
    setDetailsCatalogExpanded(false)
    setError('')
    setStep('details')
  }
  function handlePackageKeyDown(event: ReactKeyboardEvent<HTMLButtonElement>, index: number) {
    if (!filteredPackages.length) return
    let nextIndex = -1
    if (event.key === 'ArrowRight' || event.key === 'ArrowDown') {
      nextIndex = (index + 1) % filteredPackages.length
    } else if (event.key === 'ArrowLeft' || event.key === 'ArrowUp') {
      nextIndex = (index - 1 + filteredPackages.length) % filteredPackages.length
    } else if (event.key === 'Home') {
      nextIndex = 0
    } else if (event.key === 'End') {
      nextIndex = filteredPackages.length - 1
    }
    if (nextIndex < 0) return
    event.preventDefault()
    setKind(filteredPackages[nextIndex].kind)
    packageGridRef.current?.querySelectorAll<HTMLButtonElement>('button.managed-package')[nextIndex]?.focus()
  }
  async function identifyMobileRemote() {
    if (!binding || !native) return
    setRecognizing(true)
    setError('')
    try {
      await controller.refreshInformation(binding)
      const deadline = Date.now() + 12_000
      while (Date.now() < deadline) {
        const snapshot = await controller.refresh()
        const current = snapshot.discovered.find(item => item.id === binding)
        const information = current?.deviceInfo
        if (information?.status === 'ready') {
          const detectedKind = information.detectedKind ?? undefined
          const detected = isMobileRemoteKind(detectedKind)
            ? detectedKind
            : (mobileRemoteKindForSoftware(information.softwareRevision) ?? mobileRemoteFallbackKind)
          setKind(detected)
          return
        }
        if (information?.status === 'error') break
        await new Promise(resolve => setTimeout(resolve, 300))
      }
      setError(recognitionError)
    } catch {
      setError(recognitionError)
    } finally {
      setRecognizing(false)
    }
  }
  async function integrate() {
    if (!kind) return
    try {
      const instance = { ...(initial.instance ?? newInstance(kind, null)), name: name.trim(), binding: binding || null }
      const result = await controller.put(instance)
      const saved = instance.id
        ? result.store.instances.find(i => i.id === instance.id)
        : result.store.instances[result.store.instances.length - 1]
      if (saved) onComplete(saved.id)
    } catch (e) {
      setError(String(e))
    }
  }
  return (
    <dialog
      ref={dialog}
      className="managed-integration-modal"
      role="dialog"
      aria-modal="true"
      aria-labelledby="managed-integration-title"
      onCancel={onClose}
    >
      <section className="behavior-dialog managed-integration-dialog">
        <header className="behavior-dialog-head">
          <h2 id="managed-integration-title">
            {initial.instance ? '绑定物理设备' : manualAdd ? '添加设备' : '集成设备'}
          </h2>
          <button aria-label="关闭集成" className="dialog-close" onClick={onClose}>
            <X size={17} />
          </button>
        </header>
        <div className={`behavior-dialog-body managed-integration-body${step === 'kind' ? ' is-catalog-picker' : ''}`}>
          {step === 'kind' ? (
            <>
              <div className="managed-catalog-toolbar">
                {availableBrands.length > 0 && (
                  <div className="managed-brand-pills" role="group" aria-label="按品牌筛选">
                    <button
                      type="button"
                      className="managed-brand-pill"
                      aria-pressed={effectiveBrand === 'all'}
                      onClick={() => setSelectedBrand('all')}
                    >
                      全部
                    </button>
                    {availableBrands.map(brand => (
                      <button
                        key={brand}
                        type="button"
                        className="managed-brand-pill"
                        aria-pressed={effectiveBrand === brand}
                        onClick={() => setSelectedBrand(brand)}
                      >
                        {brand}
                      </button>
                    ))}
                  </div>
                )}
                <div className="managed-catalog-search-group">
                  <div className="managed-catalog-search">
                    <Search size={14} aria-hidden="true" />
                    <input
                      type="search"
                      aria-label="搜索设备型号"
                      placeholder="搜索名称或型号…"
                      value={searchQuery}
                      onChange={event => setSearchQuery(event.target.value)}
                    />
                    {searchQuery && (
                      <button
                        type="button"
                        className="managed-catalog-search-clear"
                        aria-label="清空搜索"
                        onClick={() => setSearchQuery('')}
                      >
                        <X size={13} />
                      </button>
                    )}
                  </div>
                  {(native || Boolean(libraryContext?.client)) && (
                    <button
                      type="button"
                      className={`managed-icon managed-catalog-refresh${catalogLoading ? ' is-spinning' : ''}`}
                      aria-label="刷新型号列表"
                      title="刷新型号列表"
                      disabled={catalogLoading}
                      onClick={() => {
                        void (async () => {
                          await refreshCatalog().catch(() => {})
                          if (native) await controller.refresh()
                        })()
                      }}
                    >
                      <RefreshCw size={14} />
                    </button>
                  )}
                </div>
              </div>
              <div className="managed-catalog-picker">
                <div className="managed-catalog-list-pane">
                  {filteredPackages.length > 0 ? (
                    <div ref={packageGridRef} className="managed-package-grid">
                      {filteredPackages.map((pkg, index) => {
                        const selected = effectivePackage?.kind === pkg.kind
                        const subtitle = catalogCardSubtitle(pkg, modelsByCode.get(pkg.kind), platform)
                        return (
                          <button
                            type="button"
                            className="managed-package"
                            data-kind={pkg.kind}
                            data-selected={selected || undefined}
                            aria-pressed={selected}
                            key={pkg.kind}
                            onClick={() => setKind(pkg.kind)}
                            onDoubleClick={() => proceedWithPackage(pkg)}
                            onKeyDown={event => handlePackageKeyDown(event, index)}
                          >
                            <span className="managed-package-artwork">
                              <img src={pkg.artwork} alt="" />
                            </span>
                            <span className="managed-package-meta">
                              <strong>{pkg.name}</strong>
                              {subtitle && <small>{subtitle}</small>}
                            </span>
                          </button>
                        )
                      })}
                    </div>
                  ) : (
                    <p className="managed-catalog-no-match">没有匹配的设备型号</p>
                  )}
                </div>
                <aside className="managed-catalog-detail" aria-label="型号详情" aria-live="polite">
                  {effectivePackage ? (
                    <>
                      <div className="managed-catalog-detail-head">
                        <span className="managed-catalog-detail-artwork">
                          <img src={effectivePackage.artwork} alt="" />
                        </span>
                        <div className="managed-catalog-detail-title">
                          <h3>{effectivePackage.name}</h3>
                          <p>
                            {[
                              activeCatalogModel?.brand_name,
                              effectivePackage.model.split(' · ')[0],
                              usesHidVoice(effectivePackage.kind) && platform !== 'windows' && platform !== 'macos'
                                ? '仅配置'
                                : '',
                            ]
                              .filter(Boolean)
                              .join(' · ')}
                          </p>
                          {activeCatalogModel && <ModelTagPills tags={activeCatalogModel.tags} />}
                        </div>
                      </div>
                      {renderLocalCloudOverrideWarning(effectiveOverrides, native)}
                      <ModelCatalogBody model={activeCatalogModel} loading={catalogLoading} native={native} />
                    </>
                  ) : (
                    <p className="managed-model-empty">请调整品牌筛选或搜索关键词</p>
                  )}
                </aside>
              </div>
            </>
          ) : step === 'mobile-model' ? (
            <>
              <div className="managed-integration-product">
                <img src={packageFor(mobileRemoteFallbackKind).artwork} alt="" />
                <div>
                  <h3>选择遥控器型号</h3>
                  <p>移动系列遥控器</p>
                </div>
              </div>
              <div className="managed-mobile-models" role="radiogroup" aria-label="移动系列遥控器型号">
                {mobileRemoteKinds.map(modelKind => {
                  const pkg = packageFor(modelKind)
                  const subtitle = packageSubtitle(pkg)
                  return (
                    <button
                      key={modelKind}
                      type="button"
                      className="managed-package"
                      data-kind={pkg.kind}
                      data-selected={kind === modelKind || undefined}
                      role="radio"
                      aria-checked={kind === modelKind}
                      disabled={recognizing}
                      onClick={() => setKind(modelKind)}
                    >
                      <span className="managed-package-artwork">
                        <img src={pkg.artwork} alt="" />
                      </span>
                      <span className="managed-package-meta">
                        <strong>{pkg.name}</strong>
                        {subtitle && <small>{subtitle}</small>}
                      </span>
                      {kind === modelKind && <Check size={18} aria-hidden="true" />}
                    </button>
                  )
                })}
              </div>
              <div className="managed-mobile-identify">
                <button
                  type="button"
                  className="managed-primary"
                  disabled={!native || !binding || !device?.connected || recognizing}
                  onClick={() => void identifyMobileRemote()}
                >
                  {recognizing ? '正在识别…' : '一键识别'}
                </button>
              </div>
            </>
          ) : (
            <>
              <div className="managed-integration-product">
                <img src={selectedPackage!.artwork} alt="" />
                <div className="managed-integration-product-meta">
                  <h3>{needsMobileModelSelection ? '移动系列遥控器' : selectedPackage!.name}</h3>
                  {!needsMobileModelSelection && catalogCardSubtitle(selectedPackage!, selectedCatalog, platform) && (
                    <p>{catalogCardSubtitle(selectedPackage!, selectedCatalog, platform)}</p>
                  )}
                </div>
                {hasSelectedCatalogDetails && (
                  <button
                    type="button"
                    className="managed-model-info-toggle"
                    aria-expanded={detailsCatalogExpanded}
                    onClick={() => setDetailsCatalogExpanded(open => !open)}
                  >
                    <span>型号说明</span>
                    <ChevronDown size={14} aria-hidden="true" />
                  </button>
                )}
              </div>
              {hasSelectedCatalogDetails && detailsCatalogExpanded && (
                <div className="managed-details-catalog-panel">
                  <ModelTagPills tags={selectedCatalog!.tags} />
                  <ModelCatalogBody model={selectedCatalog} native={native} showEmptyNote={false} />
                </div>
              )}
              <div className="settings-form-fields">
                <label className="settings-form-row">
                  <span className="settings-form-label">设备名称</span>
                  <input
                    value={name}
                    maxLength={60}
                    onChange={e => {
                      setName(e.target.value)
                      setNameCustomized(true)
                    }}
                  />
                </label>
                <div className="settings-form-row">
                  <span className="settings-form-label" id="integration-binding-label">
                    绑定设备
                  </span>
                  <DeviceBindingPicker
                    labelledBy="integration-binding-label"
                    value={binding}
                    devices={candidates}
                    onChange={setBindingChoice}
                  />
                </div>
              </div>
              {device?.identityQuality === 'session' && (
                <p className="integration-attention">此设备重新连接后需再次绑定。</p>
              )}
              {device?.identityQuality === 'ambiguous' && (
                <p className="managed-error">设备标识冲突，请断开其余同型号设备后重试。</p>
              )}
              {native && platform === 'macos' && (!permissions.inputMonitoring || !permissions.accessibility) && (
                <div className="integration-attention">
                  <span>
                    需要
                    {[!permissions.inputMonitoring && '输入监控', !permissions.accessibility && '辅助功能']
                      .filter(Boolean)
                      .join('、')}
                    权限
                  </span>
                  <button
                    onClick={() => {
                      onClose()
                      onPermissions()
                    }}
                  >
                    去授权
                  </button>
                </div>
              )}
              {usesHidVoice(kind) && platform !== 'windows' && platform !== 'macos' && (
                <p className="integration-attention">此设备暂不支持输入监听。</p>
              )}
              {platform === 'windows' && supportsWindowsDriver(kind) && (
                <p className="integration-attention">
                  添加完成后，这台设备会单独连接 Quarbor Universal 驱动；如果未安装，进入设备工作区时会显示安装引导。
                </p>
              )}
              {!native && <p className="integration-preview">预览模式，不会连接真实设备。</p>}
              {renderLocalCloudOverrideWarning(selectedOverrides, native)}
            </>
          )}
          {localError && (
            <p className="managed-error" role="alert">
              {localError}
            </p>
          )}
        </div>
        <footer className="managed-dialog-footer">
          {step === 'kind' && onOpenCapture && (
            <button type="button" className="managed-integration-adapt-link" onClick={onOpenCapture}>
              没有找到型号？适配新设备
            </button>
          )}
          <button type="button" onClick={onClose}>
            取消
          </button>
          {step === 'details' && manualAdd && (
            <button
              type="button"
              onClick={() => {
                setError('')
                setStep('kind')
              }}
            >
              更换型号
            </button>
          )}
          {step === 'mobile-model' && (
            <button
              type="button"
              disabled={recognizing}
              onClick={() => {
                setError('')
                setStep('details')
              }}
            >
              上一步
            </button>
          )}
          {step === 'kind' ? (
            <button
              type="button"
              className="managed-primary"
              disabled={!effectivePackage}
              onClick={() => {
                if (effectivePackage) proceedWithPackage(effectivePackage)
              }}
            >
              下一步
            </button>
          ) : (
            kind && (
              <button
                type="button"
                className="managed-primary"
                disabled={
                  !name.trim() ||
                  controller.busy ||
                  recognizing ||
                  device?.identityQuality === 'ambiguous' ||
                  Boolean(binding && !device)
                }
                onClick={() => {
                  if (step === 'details' && needsMobileModelSelection) {
                    setError('')
                    setStep('mobile-model')
                  } else {
                    void integrate()
                  }
                }}
              >
                {step === 'details' && needsMobileModelSelection
                  ? '下一步'
                  : !native
                    ? '保存预览'
                    : initial.instance
                      ? '保存'
                      : binding
                        ? '集成设备'
                        : '添加设备'}
              </button>
            )
          )}
        </footer>
      </section>
    </dialog>
  )
}
