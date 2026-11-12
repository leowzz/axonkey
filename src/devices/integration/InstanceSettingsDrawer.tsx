import { useEffect, useState } from 'react'
import { ChevronDown, Info, RefreshCw, Settings2 } from 'lucide-react'
import type { ManagedDriverAction, ManagedDriverInstallOutcome, Platform } from '../../appTypes'
import { BatteryIndicator } from '../../components/BatteryIndicator'
import { DeviceSettingsDrawer } from '../shared/DeviceSettingsDrawer'
import { DeviceBindingPicker } from './IntegrationControls'
import {
  defaultRecordingMode,
  isMobileRemoteDevice,
  isMobileRemoteKind,
  packageFor,
  supportsWindowsDriver,
} from './model'
import type { DeviceInstance, DiscoveredDevice } from './model'
import type { DeviceController } from './useDeviceInstances'

export type InstanceSettingsDrawerProps = {
  open: boolean
  instance: DeviceInstance
  controller: DeviceController
  native: boolean
  platform: Platform
  driverAction: ManagedDriverAction | null
  onInstallDriver: (
    instanceId: string,
  ) => Promise<ManagedDriverInstallOutcome | void> | ManagedDriverInstallOutcome | void
  onBind: () => void
  onUnbindDevice: (instanceId: string) => Promise<void>
  onRemoveDevice: (instanceId: string) => Promise<void>
  onOpenAudioDriver: () => void
  onClose: () => void
  onRemoved?: () => void
}

export function InstanceSettingsDrawer({
  open,
  instance,
  controller,
  native,
  platform,
  driverAction,
  onInstallDriver,
  onBind,
  onUnbindDevice,
  onRemoveDevice,
  onOpenAudioDriver,
  onClose,
  onRemoved,
}: InstanceSettingsDrawerProps) {
  const pkg = packageFor(instance.kind)
  const voice = pkg.remoteView?.voice
  const voiceModes = voice?.triggerModes ?? []
  const supportsDriver = supportsWindowsDriver(instance.kind)
  const [section, setSection] = useState<'overview' | 'information'>('overview')
  const [confirmRemove, setConfirmRemove] = useState(false)
  const [pendingPhysicalAction, setPendingPhysicalAction] = useState<'unbind' | 'remove' | null>(null)
  const [informationRefreshRemaining, setInformationRefreshRemaining] = useState(0)

  const status = controller.snapshot.runtime[instance.id]
  const boundDevice = instance.binding
    ? controller.snapshot.discovered.find(device => device.id === instance.binding)
    : undefined
  const informationRefreshLocked = informationRefreshRemaining > 0
  const canReadGattInformation = Boolean(voice && boundDevice?.connected && boundDevice.identityQuality !== 'ambiguous')
  const refreshInformation = controller.refreshInformation

  useEffect(() => {
    if (!open) {
      setConfirmRemove(false)
    }
  }, [open])

  useEffect(() => {
    if (open && section === 'information' && native && canReadGattInformation && instance.binding) {
      void refreshInformation(instance.binding).catch(() => {})
    }
  }, [open, section, native, canReadGattInformation, instance.binding, refreshInformation])

  useEffect(() => {
    if (!informationRefreshLocked) return
    const timer = setInterval(() => setInformationRefreshRemaining(seconds => Math.max(0, seconds - 1)), 1000)
    return () => clearInterval(timer)
  }, [informationRefreshLocked])

  if (!open) return null

  const availableDevices = controller.snapshot.discovered.filter(
    device =>
      (isMobileRemoteKind(instance.kind) ? isMobileRemoteDevice(device) : device.kind === instance.kind) &&
      !controller.snapshot.store.instances.some(item => item.id !== instance.id && item.binding === device.id),
  )

  const update = (change: (item: DeviceInstance) => DeviceInstance) => {
    void controller.update(instance.id, change).catch(() => {})
  }

  const unbindDevice = () => {
    setPendingPhysicalAction('unbind')
    void onUnbindDevice(instance.id)
      .catch(() => {})
      .finally(() => setPendingPhysicalAction(null))
  }

  const removeDevice = () => {
    setPendingPhysicalAction('remove')
    void onRemoveDevice(instance.id)
      .then(() => {
        onRemoved?.()
      })
      .catch(() => {})
      .finally(() => setPendingPhysicalAction(null))
  }

  const deviceOffline =
    native && platform === 'windows' && supportsDriver && !!instance.binding && status?.driverState === 'offline'
  const currentDriverAction = instance.binding && driverAction?.instanceId === instance.id ? driverAction : null
  const driverRunning = currentDriverAction?.status === 'running'
  const driverRestartRequired = currentDriverAction?.status === 'restartRequired'
  const driverInstalled = status?.driverInstalled === true
  const driverBusy = driverAction?.status === 'running'

  return (
    <DeviceSettingsDrawer deviceName={instance.name} onClose={onClose}>
      <nav className="settings-nav device-settings-drawer-nav" aria-label={`${instance.name}设置分类`}>
        <button
          type="button"
          aria-current={section === 'overview' ? 'page' : undefined}
          onClick={() => setSection('overview')}
        >
          <Settings2 size={15} />
          <span>设备设置</span>
        </button>
        <button
          type="button"
          aria-current={section === 'information' ? 'page' : undefined}
          onClick={() => setSection('information')}
        >
          <Info size={15} />
          <span>设备信息</span>
        </button>
        {section === 'information' && voice && (
          <button
            type="button"
            className="settings-refresh"
            aria-label="刷新设备信息"
            title={informationRefreshLocked ? `${informationRefreshRemaining} 秒后可再次刷新` : '刷新设备信息'}
            disabled={!native || !canReadGattInformation || !instance.binding || informationRefreshLocked}
            onClick={() => {
              if (!instance.binding || informationRefreshLocked) return
              setInformationRefreshRemaining(10)
              void refreshInformation(instance.binding).catch(() => {})
            }}
          >
            {informationRefreshLocked ? (
              <span className="device-information-countdown" aria-hidden="true">
                {informationRefreshRemaining}s
              </span>
            ) : (
              <RefreshCw size={14} aria-hidden="true" />
            )}
          </button>
        )}
      </nav>
      <section
        className="device-settings-drawer-panel"
        aria-label={section === 'information' ? '设备信息' : '设备设置'}
      >
        {section === 'information' ? (
          <DeviceInformationPanel
            binding={instance.binding}
            device={boundDevice}
            native={native}
            supportsGattInfo={Boolean(voice)}
          />
        ) : (
          <>
            {supportsDriver && platform === 'windows' && (
              <div className="settings-form-row managed-driver-status-row">
                <span className="settings-form-label">按键驱动：</span>
                <div className="settings-form-control managed-driver-status-control">
                  <strong>
                    {!native
                      ? '预览模式'
                      : driverRestartRequired
                        ? '需重启后安装'
                        : deviceOffline
                          ? '设备不在线'
                          : status?.driverState === 'installed'
                            ? '已安装'
                            : status?.driverState === 'connected'
                              ? '已连接'
                              : status?.driverState === 'connecting'
                                ? '连接中'
                                : status?.driverState === 'missing'
                                  ? '未安装'
                                  : status?.driverState === 'disconnected'
                                    ? '等待设备'
                                    : '检测中'}
                  </strong>
                  {native && !deviceOffline && !driverRestartRequired && (
                    <button
                      type="button"
                      disabled={driverBusy || !instance.binding}
                      onClick={() => void onInstallDriver(instance.id)}
                    >
                      {driverRunning ? '正在安装…' : driverInstalled ? '重新安装驱动' : '安装驱动'}
                    </button>
                  )}
                </div>
              </div>
            )}
            <div className="settings-form-fields">
              {voice && (platform === 'windows' || platform === 'macos') && (
                <div className="settings-form-row">
                  <span className="settings-form-label">虚拟麦克风：</span>
                  <div className="settings-form-control">
                    <button type="button" className="dialog-secondary" onClick={onOpenAudioDriver}>
                      管理驱动
                    </button>
                  </div>
                </div>
              )}
              {voiceModes.includes('hold') &&
                voiceModes.includes('click') &&
                (platform === 'windows' || platform === 'macos') && (
                  <label className="settings-form-row">
                    <span className="settings-form-label">语音录制：</span>
                    <span className="settings-form-control">
                      <span className="manual-key-select cmiot-recording-select">
                        <select
                          value={instance.cmiotA15RecordingMode ?? defaultRecordingMode(instance.kind)}
                          onChange={event => {
                            const cmiotA15RecordingMode = event.target.value === 'click' ? 'click' : 'hold'
                            update(item => ({ ...item, cmiotA15RecordingMode }))
                          }}
                        >
                          <option value="hold">按住录音，松开停止</option>
                          <option value="click">点击开始，再次点击停止</option>
                        </select>
                        <span className="manual-key-select-icon" aria-hidden="true">
                          <ChevronDown size={14} />
                        </span>
                      </span>
                    </span>
                  </label>
                )}
              <label className="settings-form-row">
                <span className="settings-form-label">设备名称：</span>
                <input
                  key={instance.name}
                  defaultValue={instance.name}
                  maxLength={60}
                  onKeyDown={event => {
                    if (event.key === 'Enter') event.currentTarget.blur()
                  }}
                  onBlur={e => {
                    const name = e.target.value.trim()
                    if (name && name !== instance.name) update(item => ({ ...item, name }))
                  }}
                />
              </label>
              <div className="settings-form-row">
                <span className="settings-form-label">设备型号：</span>
                <span className="settings-form-control">{pkg.model}</span>
              </div>
              <div className="settings-form-row">
                <span className="settings-form-label" id={`instance-binding-label-${instance.id}`}>
                  物理设备：
                </span>
                <div className="settings-form-control managed-instance-binding-control">
                  {instance.binding ? (
                    <BoundDeviceInfo
                      binding={instance.binding}
                      device={boundDevice}
                      onRebind={onBind}
                      onUnbind={unbindDevice}
                      disabled={pendingPhysicalAction !== null}
                    />
                  ) : (
                    <DeviceBindingPicker
                      labelledBy={`instance-binding-label-${instance.id}`}
                      value=""
                      devices={availableDevices}
                      onChange={binding => {
                        if (binding) update(item => ({ ...item, binding }))
                      }}
                    />
                  )}
                </div>
              </div>
            </div>
            <div className="managed-remove">
              {confirmRemove ? (
                <>
                  <span>移除此设备及其全部配置？</span>
                  <button
                    type="button"
                    className="danger"
                    disabled={pendingPhysicalAction !== null}
                    onClick={removeDevice}
                  >
                    {pendingPhysicalAction === 'remove' ? '正在解除绑定…' : '确认移除'}
                  </button>
                  <button type="button" onClick={() => setConfirmRemove(false)}>
                    取消
                  </button>
                </>
              ) : (
                <button type="button" onClick={() => setConfirmRemove(true)}>
                  移除设备
                </button>
              )}
            </div>
          </>
        )}
      </section>
    </DeviceSettingsDrawer>
  )
}

function BoundDeviceInfo({
  binding,
  device,
  onRebind,
  onUnbind,
  disabled,
}: {
  binding: string
  device?: DiscoveredDevice
  onRebind: () => void
  onUnbind: () => void
  disabled: boolean
}) {
  const transport = device?.transport === 'Bluetooth' ? '蓝牙' : device?.transport
  const status = device?.identityQuality === 'ambiguous' ? '标识冲突' : device?.connected ? '已连接' : '未连接'
  return (
    <div className="managed-bound-device">
      <div className="device-binding-copy">
        <strong>{device?.name ?? '原绑定设备'}</strong>
        <small>{device ? `${transport} · ${device.id.slice(-6)}` : binding}</small>
        <span
          className={`device-binding-status${device?.identityQuality === 'ambiguous' ? ' is-unavailable' : !device?.connected ? ' is-offline' : ''}`}
        >
          <i />
          {status}
        </span>
      </div>
      <div className="managed-bound-device-actions">
        <button type="button" className="dialog-secondary" onClick={onRebind} disabled={disabled}>
          重新绑定
        </button>
        <button type="button" className="dialog-secondary" onClick={onUnbind} disabled={disabled}>
          {disabled ? '正在解除绑定…' : '解除绑定，保留配置'}
        </button>
      </div>
    </div>
  )
}

function DeviceInformationPanel({
  binding,
  device,
  native,
  supportsGattInfo,
}: {
  binding: string | null
  device?: DiscoveredDevice
  native: boolean
  supportsGattInfo: boolean
}) {
  const info = device?.deviceInfo
  const unavailable = !binding
    ? '未绑定设备'
    : !native
      ? '预览模式'
      : !device?.connected
        ? '设备未连接'
        : device.identityQuality === 'ambiguous'
          ? '设备身份冲突'
          : !supportsGattInfo || info?.status === 'ready'
            ? '设备未提供'
            : info?.status === 'error'
              ? '读取失败'
              : info?.status === 'retrying'
                ? '正在重试…'
                : '读取中…'
  const value = (text?: string | number | null) => (!binding ? '未绑定设备' : (text ?? unavailable))
  const fields = [
    ['设备蓝牙名称', value(info?.bluetoothName ?? (!supportsGattInfo ? device?.name : undefined))],
    ['设备蓝牙地址', value(device?.bluetoothAddress)],
    [
      '电量',
      !binding ? (
        '未绑定设备'
      ) : device?.connected && info?.batteryLevel != null ? (
        <BatteryIndicator level={info.batteryLevel} />
      ) : (
        unavailable
      ),
    ],
    ['制造商', value(info?.manufacturer)],
    ['序列号', value(info?.serialNumber)],
    ['硬件版本', value(info?.hardwareRevision)],
    ['固件版本', value(info?.firmwareRevision)],
    ['软件版本', value(info?.softwareRevision)],
  ] as const
  return (
    <div className="settings-form-fields managed-device-information">
      {fields.map(([label, fieldValue]) => (
        <div className="settings-form-row" key={label}>
          <span className="settings-form-label">{label}：</span>
          <span className="settings-form-control">{fieldValue}</span>
        </div>
      ))}
      {binding && info?.error && (
        <p role="status" className="managed-error">
          {info.status === 'retrying' ? '读取失败，正在重试。' : '读取失败，稍后自动刷新。'}
          {info.error}
        </p>
      )}
    </div>
  )
}
