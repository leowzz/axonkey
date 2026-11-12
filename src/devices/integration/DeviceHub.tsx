import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react'
import { createPortal } from 'react-dom'
import { ChevronRight, Check, Clock3, Ellipsis, Link2Off, Pause, Plus, RefreshCw, TriangleAlert, X } from 'lucide-react'
import type { LucideIcon } from 'lucide-react'
import type { MacPermissions, ManagedDriverAction, ManagedDriverInstallOutcome, Platform } from '../../appTypes'
import type { DeviceId } from '../types.ts'
import { InstanceSettingsDrawer } from './InstanceSettingsDrawer'
import { InstanceWorkspace } from './InstanceWorkspace'
import { DeviceBindingPicker } from './IntegrationControls'
import { BatteryIndicator } from '../../components/BatteryIndicator'
import {
  instanceStatusLabel,
  instanceState,
  isMobileRemoteDevice,
  isMobileRemoteKind,
  mobileRemoteKindForSoftware,
  mobileRemoteKinds,
  mobileRemoteFallbackKind,
  newInstance,
  packageFor,
  batteryForDevice,
  supportPackages,
  supportsWindowsDriver,
  usesHidVoice,
} from './model'
import type { DeviceInstance, DeviceKind, DiscoveredDevice } from './model'
import type { DeviceController } from './useDeviceInstances'
import './DeviceHub.css'
import './DeviceCards.css'

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
  driverAction: ManagedDriverAction | null
  onInstallDriver: (
    instanceId: string,
  ) => Promise<ManagedDriverInstallOutcome | void> | ManagedDriverInstallOutcome | void
  onUnbindDevice: (instanceId: string) => Promise<void>
  onRemoveDevice: (instanceId: string) => Promise<void>
  mouseProfileName: string
}
type Integration = { kind?: DeviceKind; device?: DiscoveredDevice; instance?: DeviceInstance }
const discoveredDevicesExpandedKey = 'axonkey.device-hub-discovered-expanded.v1'
const deviceCardOrderKey = 'axonkey.device-hub-card-order.v1'
const systemMouseCardId = 'system-mouse'

function getStoredDeviceCardOrder() {
  if (typeof window === 'undefined') return []
  try {
    const value = JSON.parse(window.localStorage.getItem(deviceCardOrderKey) ?? '[]')
    return Array.isArray(value) ? value.filter((id): id is string => typeof id === 'string') : []
  } catch {
    return []
  }
}

function saveDeviceCardOrder(order: string[]) {
  try {
    window.localStorage.setItem(deviceCardOrderKey, JSON.stringify(order))
  } catch {
    // UI preference is best-effort.
  }
}

function getDiscoveredDevicesExpanded() {
  if (typeof window === 'undefined') return true
  try {
    return window.localStorage.getItem(discoveredDevicesExpandedKey) !== '0'
  } catch {
    return true
  }
}
export function DeviceHub(props: Props) {
  const { controller, native } = props
  const { snapshot, error, busy } = controller
  const { selectedInstanceId: selected, onSelectInstance: setSelected } = props
  const [integration, setIntegration] = useState<Integration | null>(null)
  const [inspectorInstanceId, setInspectorInstanceId] = useState<string | null>(null)
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
  const inspectorInstance = inspectorInstanceId ? (instanceById.get(inspectorInstanceId) ?? null) : null
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
  const banner = (
    <>
      {!native && <p className="managed-notice">浏览器预览 · 设备连接需使用桌面应用</p>}
      {(error || snapshot.error || snapshot.scanError) && (
        <p className="managed-error" role="alert">
          {error || snapshot.error || snapshot.scanError}
        </p>
      )}
    </>
  )
  return (
    <section className={`managed-hub ${instance ? 'has-workspace mapping-active' : ''}`}>
      {banner}
      {instance ? (
        <InstanceWorkspace
          key={instance.id}
          {...props}
          instance={instance}
          batteryLevel={batteryForDevice(instance.binding, snapshot.discovered)}
          onBack={() => setSelected(null)}
          onBind={() => setIntegration({ kind: instance.kind, instance })}
        />
      ) : (
        <>
          <header className="my-devices-heading">
            <div className="my-devices-heading-main">
              <button className="my-devices-brand" aria-label="Axonkey" title="Axonkey" onClick={props.onBrandClick}>
                <img src={new URL('../../../src-tauri/icons/128x128@2x.png', import.meta.url).href} alt="" />
                Axonkey
              </button>
              <h1>我的设备</h1>
            </div>
            <button className="my-devices-integrate" onClick={() => setIntegration({})}>
              <Plus size={16} />
              手动添加设备
            </button>
          </header>
          <div className="managed-device-sections">
            <section className="managed-device-section" aria-labelledby="my-devices-title">
              <h2 id="my-devices-title" className="my-devices-section-title">
                我的设备
              </h2>
              <div className="managed-device-grid">
                {orderedCardIds.map(cardId => {
                  const item = instanceById.get(cardId)
                  if (item) {
                    const missingWindowsDriver =
                      native &&
                      props.platform === 'windows' &&
                      supportsWindowsDriver(item.kind) &&
                      !!item.binding &&
                      snapshot.runtime[item.id]?.driverState === 'missing'
                    const missingMacPermissions =
                      native &&
                      props.platform === 'macos' &&
                      (!props.permissions.inputMonitoring || !props.permissions.accessibility)
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
                        onOpenSettings={() => setInspectorInstanceId(item.id)}
                        quickAction={
                          missingWindowsDriver
                            ? {
                                label:
                                  props.driverAction?.instanceId === item.id && props.driverAction.status === 'running'
                                    ? '安装中…'
                                    : '安装驱动',
                                disabled: props.driverAction?.status === 'running',
                                onClick: () => void props.onInstallDriver(item.id),
                              }
                            : missingMacPermissions
                              ? { label: '前往授权', onClick: props.onPermissions }
                              : undefined
                        }
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
            <DeviceDiscoverySection {...props} onIntegrated={setSelected} />
          </div>
        </>
      )}
      {inspectorInstance && !instance && (
        <InstanceSettingsDrawer
          open
          instance={inspectorInstance}
          controller={controller}
          native={native}
          platform={props.platform}
          driverAction={props.driverAction}
          onInstallDriver={props.onInstallDriver}
          onBind={() => {
            setInspectorInstanceId(null)
            setIntegration({ kind: inspectorInstance.kind, instance: inspectorInstance })
          }}
          onUnbindDevice={props.onUnbindDevice}
          onRemoveDevice={props.onRemoveDevice}
          onOpenAudioDriver={props.onOpenAudioDriver}
          onClose={() => setInspectorInstanceId(null)}
          onRemoved={() => setInspectorInstanceId(null)}
        />
      )}
      {integration &&
        createPortal(
          <IntegrationDialog
            {...props}
            initial={integration}
            onClose={() => setIntegration(null)}
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
type IntegrationProps = Pick<Props, 'controller' | 'native' | 'platform' | 'permissions' | 'onPermissions'> & {
  onInstallDriver?: Props['onInstallDriver']
}
export type DeviceDiscoveryProps = IntegrationProps &
  Pick<Props, 'onOpenBluetoothSettings' | 'onOpenDeviceManager'> & {
    guide?: boolean
    onIntegrated: (id: string) => void
  }

export function DeviceDiscoverySection(props: DeviceDiscoveryProps) {
  const { controller, native, guide = false } = props
  const { snapshot, error, busy } = controller
  const [integration, setIntegration] = useState<Integration | null>(null)
  const [discoveryHelpOpen, setDiscoveryHelpOpen] = useState(false)
  const [discoveredExpanded, setDiscoveredExpanded] = useState(() => guide || getDiscoveredDevicesExpanded())
  const unboundDevices = snapshot.discovered.filter(d => !snapshot.store.instances.some(i => i.binding === d.id))
  useEffect(() => {
    if (guide || typeof window === 'undefined') return
    try {
      window.localStorage.setItem(discoveredDevicesExpandedKey, discoveredExpanded ? '1' : '0')
    } catch {
      /* UI preference is best-effort. */
    }
  }, [discoveredExpanded, guide])

  return (
    <>
      {guide && (
        <section className="user-guide-supported" aria-labelledby="user-guide-supported-title">
          <h3 id="user-guide-supported-title">支持的设备</h3>
          <ul>
            {supportPackages.map(pkg => (
              <li key={pkg.kind} className="managed-package">
                <img src={pkg.artwork} alt="" />
                <span>
                  <strong>{pkg.name}</strong>
                  <small>{pkg.model.split(' · ')[0]}</small>
                </span>
              </li>
            ))}
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
            className="managed-icon managed-discovery-refresh"
            aria-label="刷新设备"
            title="刷新设备"
            onClick={event => {
              event.preventDefault()
              event.stopPropagation()
              void controller.refresh()
            }}
            disabled={!native}
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
            onClose={() => setDiscoveryHelpOpen(false)}
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
  onClose,
}: Pick<Props, 'native' | 'platform' | 'onOpenBluetoothSettings' | 'onOpenDeviceManager'> & {
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
  onOpenSettings,
  quickAction,
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
  onOpenSettings?: () => void
  quickAction?: { label: string; disabled?: boolean; onClick: () => void }
  onClick: () => void
  dragging?: boolean
  dragOver?: boolean
  onPointerDown?: (event: ReactPointerEvent<HTMLButtonElement>) => void
}) {
  const appearance = state ? deviceStatusAppearance[state] : undefined
  const StatusIcon = appearance?.icon
  return (
    <div className="my-devices-card-shell" data-dragging={dragging || undefined} data-drag-over={dragOver || undefined}>
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
                {status}
              </span>
            )}
            {!unbound && kind !== 'mouse' && packageFor(kind).remoteView?.voice && (
              <span className="my-devices-power">
                <BatteryIndicator level={batteryLevel} />
              </span>
            )}
          </span>
          <span className="my-devices-profile">
            {profile ? (
              <span className="my-devices-profile-current">
                <span>当前配置</span>
                <strong>{profile}</strong>
              </span>
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
      {onOpenSettings && (
        <button
          type="button"
          className="my-devices-card-more"
          aria-label={`${title}设备设置`}
          title="设备设置与硬件信息"
          onClick={onOpenSettings}
        >
          <Ellipsis size={16} aria-hidden="true" />
        </button>
      )}
      {quickAction && (
        <button
          type="button"
          className="my-devices-card-action"
          disabled={quickAction.disabled}
          onClick={quickAction.onClick}
        >
          {quickAction.label}
        </button>
      )}
    </div>
  )
}
type IntegrationStep = 'kind' | 'mobile-model' | 'details'

function IntegrationDialog({
  initial,
  controller,
  native,
  platform,
  permissions,
  onPermissions,
  onInstallDriver,
  onClose,
  onComplete,
}: IntegrationProps & { initial: Integration; onClose: () => void; onComplete: (id: string) => void }) {
  const mobileModelSelection = Boolean(initial.device && isMobileRemoteDevice(initial.device) && !initial.instance)
  const [kind, setKind] = useState<DeviceKind | undefined>(() =>
    mobileModelSelection ? mobileRemoteFallbackKind : initial.kind,
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
  // null follows discovery defaults; an empty string is the user's explicit “bind later” choice.
  const [bindingChoice, setBindingChoice] = useState<string | null>(
    initial.device?.id ?? initial.instance?.binding ?? null,
  )
  const [localError, setError] = useState('')
  const [recognizing, setRecognizing] = useState(false)
  const [pendingInstance, setPendingInstance] = useState<DeviceInstance | null>(null)
  const [installingDriver, setInstallingDriver] = useState(false)
  const [driverInstallNotice, setDriverInstallNotice] = useState<{
    status: 'error' | 'restartRequired'
    text: string
  } | null>(null)
  const dialog = useRef<HTMLDialogElement>(null)
  useEffect(() => {
    const modal = dialog.current
    const focus = document.activeElement
    modal?.showModal()
    return () => {
      modal?.close()
      if (focus instanceof HTMLElement && focus.isConnected) focus.focus()
    }
  }, [])
  const currentInstanceId = pendingInstance?.id ?? initial.instance?.id
  const candidates = controller.snapshot.discovered.filter(
    d =>
      (isMobileRemoteKind(kind) ? isMobileRemoteDevice(d) : d.kind === kind) &&
      !controller.snapshot.store.instances.some(i => i.id !== currentInstanceId && i.binding === d.id),
  )
  const binding = bindingChoice ?? candidates.find(d => d.identityQuality !== 'ambiguous')?.id ?? ''
  const device = candidates.find(d => d.id === binding)
  const needsMobileModelSelection = !initial.instance && Boolean(device && isMobileRemoteDevice(device))
  const selectedPackage = kind ? packageFor(kind) : null
  const needsWindowsDriverInstall = Boolean(
    native &&
    platform === 'windows' &&
    kind &&
    supportsWindowsDriver(kind) &&
    binding &&
    onInstallDriver &&
    controller.snapshot.runtime[currentInstanceId ?? '']?.driverInstalled !== true,
  )
  const recognitionError =
    '识别失败，请按下遥控器任意按钮，然后再次尝试 一键识别。如果依然识别失败，请看遥控器背面或者说明书确认型号，并手动选择。'
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
  async function runWindowsDriverInstall(instanceId: string) {
    if (!onInstallDriver) {
      onComplete(instanceId)
      return
    }
    setInstallingDriver(true)
    setDriverInstallNotice(null)
    setError('')
    try {
      const outcome = await onInstallDriver(instanceId)
      if (!outcome || outcome.ok) {
        onComplete(instanceId)
        return
      }
      setDriverInstallNotice({
        status: outcome.status === 'restartRequired' ? 'restartRequired' : 'error',
        text: outcome.message || outcome.error || '未完成管理员授权或驱动安装失败。',
      })
    } catch (e) {
      setDriverInstallNotice({
        status: 'error',
        text: String(e),
      })
    } finally {
      setInstallingDriver(false)
    }
  }
  async function integrate() {
    if (!kind) return
    if (
      pendingInstance &&
      pendingInstance.kind === kind &&
      pendingInstance.name === name.trim() &&
      pendingInstance.binding === (binding || null)
    ) {
      if (pendingInstance.binding && needsWindowsDriverInstall) {
        await runWindowsDriverInstall(pendingInstance.id)
      } else {
        onComplete(pendingInstance.id)
      }
      return
    }
    try {
      setError('')
      setDriverInstallNotice(null)
      const base = pendingInstance ?? initial.instance ?? newInstance(kind, null)
      const instance = { ...base, kind, name: name.trim(), binding: binding || null }
      const result = await controller.put(instance)
      const saved = instance.id
        ? result.store.instances.find(i => i.id === instance.id)
        : result.store.instances[result.store.instances.length - 1]
      if (!saved) return
      setPendingInstance(saved)
      const driverAlreadyInstalled = result.runtime[saved.id]?.driverInstalled === true
      if (
        native &&
        platform === 'windows' &&
        supportsWindowsDriver(kind) &&
        saved.binding &&
        onInstallDriver &&
        !driverAlreadyInstalled
      ) {
        await runWindowsDriverInstall(saved.id)
        return
      }
      onComplete(saved.id)
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
      onCancel={event => {
        if (installingDriver) {
          event.preventDefault()
          return
        }
        onClose()
      }}
    >
      <section className="behavior-dialog managed-integration-dialog">
        <header className="behavior-dialog-head">
          <h2 id="managed-integration-title">{initial.instance ? '绑定物理设备' : '集成设备'}</h2>
          <button aria-label="关闭集成" className="dialog-close" disabled={installingDriver} onClick={onClose}>
            <X size={17} />
          </button>
        </header>
        <div className="behavior-dialog-body managed-integration-body">
          {step === 'kind' ? (
            <>
              {supportPackages.map(pkg => (
                <button
                  className="managed-package"
                  key={pkg.kind}
                  onClick={() => {
                    setKind(pkg.kind)
                    setName(pkg.name)
                    setStep('details')
                  }}
                >
                  <img src={pkg.artwork} alt="" />
                  <span>
                    <strong>{pkg.name}</strong>
                    <small>
                      {pkg.model.split(' · ')[0]}
                      {usesHidVoice(pkg.kind) && platform !== 'windows' && platform !== 'macos' ? ' · 仅配置' : ''}
                    </small>
                  </span>
                </button>
              ))}
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
                  return (
                    <button
                      key={modelKind}
                      type="button"
                      className="managed-package"
                      data-selected={kind === modelKind || undefined}
                      role="radio"
                      aria-checked={kind === modelKind}
                      disabled={recognizing || installingDriver}
                      onClick={() => setKind(modelKind)}
                    >
                      <img src={pkg.artwork} alt="" />
                      <span>
                        <strong>{pkg.name}</strong>
                        <small>{pkg.model}</small>
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
                  disabled={!native || !binding || !device?.connected || recognizing || installingDriver}
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
                <div>
                  <h3>{needsMobileModelSelection ? '移动系列遥控器' : selectedPackage!.name}</h3>
                  {!needsMobileModelSelection && <p>{selectedPackage!.model.split(' · ')[0]}</p>}
                </div>
              </div>
              <div className="settings-form-fields">
                <label className="settings-form-row">
                  <span className="settings-form-label">设备名称</span>
                  <input
                    value={name}
                    maxLength={60}
                    disabled={installingDriver}
                    onChange={e => {
                      setName(e.target.value)
                      setDriverInstallNotice(null)
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
                    onChange={next => {
                      setBindingChoice(next)
                      setDriverInstallNotice(null)
                    }}
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
              {platform === 'windows' && supportsWindowsDriver(kind) && !driverInstallNotice && !installingDriver && (
                <p className="integration-attention">
                  {binding
                    ? '点击集成后将直接请求管理员权限安装 Quarbor Universal 按键驱动，完成后进入工作区即可使用。'
                    : '暂不绑定硬件时可先配置键位，绑定物理设备后再安装 Quarbor Universal 按键驱动。'}
                </p>
              )}
              {!native && <p className="integration-preview">预览模式，不会连接真实设备。</p>}
            </>
          )}
          {installingDriver && (
            <div className="integration-uac-status" role="status" aria-live="polite">
              正在请求管理员权限安装 Quarbor Universal 按键驱动，请在 Windows UAC 窗口中点击「是」…
            </div>
          )}
          {driverInstallNotice && (
            <div className="managed-error integration-uac-error" role="alert">
              <strong>
                {driverInstallNotice.status === 'restartRequired' ? '需要先重启 Windows' : '按键驱动尚未完成安装'}
              </strong>
              <span>{driverInstallNotice.text}</span>
            </div>
          )}
          {localError && (
            <p className="managed-error" role="alert">
              {localError}
            </p>
          )}
        </div>
        <footer className="managed-dialog-footer">
          {pendingInstance && driverInstallNotice ? (
            <>
              <button type="button" disabled={installingDriver} onClick={() => onComplete(pendingInstance.id)}>
                先进入配键位（稍后安装）
              </button>
              {driverInstallNotice.status !== 'restartRequired' && (
                <button
                  type="button"
                  className="managed-primary"
                  disabled={installingDriver || Boolean(binding && !device) || device?.identityQuality === 'ambiguous'}
                  onClick={() => void integrate()}
                >
                  重新授权安装
                </button>
              )}
            </>
          ) : (
            <>
              <button disabled={installingDriver} onClick={onClose}>
                取消
              </button>
              {step === 'mobile-model' && (
                <button
                  disabled={recognizing || installingDriver}
                  onClick={() => {
                    setError('')
                    setDriverInstallNotice(null)
                    setStep('details')
                  }}
                >
                  上一步
                </button>
              )}
              {step !== 'kind' && kind && (
                <button
                  className="managed-primary"
                  disabled={
                    !name.trim() ||
                    controller.busy ||
                    recognizing ||
                    installingDriver ||
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
                      : installingDriver
                        ? '正在安装驱动…'
                        : needsWindowsDriverInstall
                          ? initial.instance
                            ? '保存并配置驱动'
                            : '集成并配置驱动'
                          : initial.instance
                            ? '保存'
                            : binding
                              ? '集成设备'
                              : '添加设备'}
                </button>
              )}
            </>
          )}
        </footer>
      </section>
    </dialog>
  )
}
