import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { listen } from '@tauri-apps/api/event'
import { ChevronDown, Info, RefreshCw, Settings2, SlidersHorizontal, Speaker, X } from 'lucide-react'
import type { MacPermissions, ManagedDriverAction, MappingInput, Platform } from '../../appTypes'
import type { ButtonId, SwitchProfileBehavior, TriggerBehaviors, TriggerType } from '../../behaviorModel'
import { triggerTypes } from '../../behaviorModel'
import { triggerLabels } from '../../appConfig'
import { removedProfileSwitchTriggers } from '../../profileNavigation'
import { RemoteControl } from '../../components/RemoteControl'
import { ProfileManager } from '../../components/ProfileManager'
import { ProfileSwitchConfirmDialog } from '../../components/ProfileSwitchConfirmDialog'
import { ProfileSwitchDeleteDialog } from '../../components/ProfileSwitchDeleteDialog'
import { SettingsHelp } from '../../components/SettingsHelp'
import { BatteryIndicator } from '../../components/BatteryIndicator'
import { DeviceRecordingStatus } from '../../components/DeviceRail'
import { WorkflowAxonkey } from '../../components/WorkflowAxonkey'
import { DeviceWorkspaceHeader } from '../shared/DeviceWorkspaceHeader'
import { DeviceBindingPicker } from './IntegrationControls'
import { VoiceOutput } from '../xiaomi-remote/settings/VoiceOutput'
import { ControllerDiagram } from '../xbox-controller/ControllerDiagram'
import { xiaomiRemoteView } from '../xiaomi-remote/view'
import { cmiotA15RemoteDevice } from '../cmiot-a15-remote/definition'
import { emptyTriggers, instanceStatusLabel, packageFor } from './model'
import type { DeviceInstance, DeviceKind, DiscoveredDevice, InstanceProfile } from './model'
import type { DeviceController } from './useDeviceInstances'
import {
  addInstanceProfile,
  applyInstanceProfileSwitch,
  migrateLegacyProfiles,
  removeInstanceProfileSwitch,
  updateInstanceSequence,
} from './instanceProfiles'

type Props = {
  instance: DeviceInstance
  controller: DeviceController
  native: boolean
  platform: Platform
  permissions: MacPermissions
  legacyActiveProfileId?: (kind: DeviceKind) => string | undefined
  onPermissions: () => void
  legacyProfiles: (kind: DeviceKind) => InstanceProfile[]
  onBack: () => void
  onBind: () => void
  onUnbindDevice: (instanceId: string) => Promise<void>
  onRemoveDevice: (instanceId: string) => Promise<void>
  onOpenAudioCalibration: (instanceId: string) => void
  onOpenAudioDriver: () => void
  driverAction: ManagedDriverAction | null
  onInstallDriver: (instanceId: string) => void
  batteryLevel: number | null
}
export function InstanceWorkspace({
  instance,
  controller,
  native,
  platform,
  permissions,
  onPermissions,
  legacyProfiles,
  legacyActiveProfileId,
  onBack,
  onBind,
  onUnbindDevice,
  onRemoveDevice,
  onOpenAudioCalibration,
  onOpenAudioDriver,
  onInstallDriver,
  driverAction,
  batteryLevel,
}: Props) {
  const pkg = packageFor(instance.kind)
  const [selected, setSelected] = useState(pkg.inputs[0].id as string)
  const [settings, setSettings] = useState(false)
  const [dismissingDriverNotice, setDismissingDriverNotice] = useState(false)
  const [driverSettingsHint, setDriverSettingsHint] = useState(false)
  const workspaceRef = useRef<HTMLDivElement>(null)
  const driverNoticeRef = useRef<HTMLDivElement>(null)
  const [settingsSection, setSettingsSection] = useState<'overview' | 'output' | 'information'>('overview')
  const [confirmRemove, setConfirmRemove] = useState(false)
  const [pendingPhysicalAction, setPendingPhysicalAction] = useState<'unbind' | 'remove' | null>(null)
  const [toolboxCategory, setToolboxCategory] = useState('常用行为/常用行为')
  const [controllerTrigger, setControllerTrigger] = useState<TriggerType>('click')
  const [pendingSwitch, setPendingSwitch] = useState<{
    inputId: string
    trigger: TriggerType
    behavior: SwitchProfileBehavior
  } | null>(null)
  const [pendingDeletion, setPendingDeletion] = useState<{
    profileId: string
    inputId: string
    triggers: TriggerType[]
    sequences: TriggerBehaviors
  } | null>(null)
  const [input, setInput] = useState<{ pressed: string[]; values: Record<string, number> }>({ pressed: [], values: {} })
  const migrationStarted = useRef(false)
  const profile = instance.profiles.find(p => p.id === instance.activeProfileId)!
  const selectedInput: MappingInput<string> = pkg.inputs.find(i => i.id === selected) ?? pkg.inputs[0]
  const status = controller.snapshot.runtime[instance.id]
  const boundDevice = instance.binding
    ? controller.snapshot.discovered.find(device => device.id === instance.binding)
    : undefined
  const [informationRefreshRemaining, setInformationRefreshRemaining] = useState(0)
  const informationRefreshLocked = informationRefreshRemaining > 0
  const informationAvailable = !!boundDevice?.connected && boundDevice.identityQuality !== 'ambiguous'
  const refreshInformation = controller.refreshInformation
  useEffect(() => {
    if (settings && settingsSection === 'information' && native && informationAvailable && instance.binding) {
      void refreshInformation(instance.binding).catch(() => {})
    }
  }, [settings, settingsSection, native, informationAvailable, instance.binding, refreshInformation])
  useEffect(() => {
    if (!informationRefreshLocked) return
    const timer = setInterval(() => setInformationRefreshRemaining(seconds => Math.max(0, seconds - 1)), 1000)
    return () => clearInterval(timer)
  }, [informationRefreshLocked])
  const availableDevices = controller.snapshot.discovered.filter(
    device =>
      device.kind === instance.kind &&
      !controller.snapshot.store.instances.some(item => item.id !== instance.id && item.binding === device.id),
  )
  const update = (change: (item: DeviceInstance) => DeviceInstance) => {
    void controller.update(instance.id, change).catch(() => {})
  }
  const dismissDriverNotice = async () => {
    const notice = driverNoticeRef.current
    const settingsButton = workspaceRef.current?.querySelector<HTMLButtonElement>('.device-workspace-settings')
    if (!notice || !settingsButton) return
    setDismissingDriverNotice(true)
    const moveFocus = notice.contains(document.activeElement)
    const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches
    const source = notice.getBoundingClientRect()
    const target = settingsButton.getBoundingClientRect()
    const dx = target.x + target.width / 2 - (source.x + source.width / 2)
    const dy = target.y + target.height / 2 - (source.y + source.height / 2)
    const flight = notice.animate(
      reducedMotion
        ? [{ opacity: 1 }, { opacity: 0 }]
        : [
            { transform: 'translate(0, 0) scale(1)', opacity: 1, borderRadius: '6px' },
            { transform: `translate(${dx * 0.65}px, ${dy * 0.65}px) scale(0.26, 0.7)`, opacity: 0.8, offset: 0.6 },
            {
              transform: `translate(${dx}px, ${dy}px) scale(${target.width / source.width}, ${target.height / source.height})`,
              opacity: 0,
              borderRadius: '20px',
            },
          ],
      { duration: reducedMotion ? 100 : 520, easing: 'cubic-bezier(0.4, 0, 0.2, 1)', fill: 'forwards' },
    )
    try {
      await flight.finished
      await controller.update(instance.id, item => ({ ...item, hideDriverMissingReminder: true }))
      setDriverSettingsHint(true)
      if (moveFocus && settingsButton.isConnected) settingsButton.focus({ preventScroll: true })
    } catch {
      // A failed save leaves the reminder visible; the controller displays the error.
    } finally {
      flight.cancel()
      setDismissingDriverNotice(false)
    }
  }
  useEffect(() => {
    if (!driverSettingsHint) return
    const timer = window.setTimeout(() => setDriverSettingsHint(false), 2800)
    return () => window.clearTimeout(timer)
  }, [driverSettingsHint])
  const unbindDevice = () => {
    setPendingPhysicalAction('unbind')
    void onUnbindDevice(instance.id)
      .catch(() => {})
      .finally(() => setPendingPhysicalAction(null))
  }
  const removeDevice = () => {
    setPendingPhysicalAction('remove')
    void onRemoveDevice(instance.id)
      .then(onBack)
      .catch(() => {})
      .finally(() => setPendingPhysicalAction(null))
  }
  useEffect(() => {
    if (instance.legacyProfilesMigrated || migrationStarted.current) return
    migrationStarted.current = true
    const first = controller.snapshot.store.instances.find(i => i.kind === instance.kind)?.id === instance.id
    void controller
      .update(instance.id, item =>
        migrateLegacyProfiles(item, first ? legacyProfiles(item.kind) : [], legacyActiveProfileId?.(item.kind)),
      )
      .catch(() => {
        migrationStarted.current = false
      })
  }, [instance.id, instance.kind, instance.legacyProfilesMigrated, controller, legacyProfiles, legacyActiveProfileId])
  useEffect(() => {
    if (!native) return
    let alive = true
    const listener = listen<{ instanceId: string; pressed: string[]; values: Record<string, number> }>(
      'axonkey-device-input',
      event => {
        if (alive && event.payload.instanceId === instance.id) setInput(event.payload)
      },
    )
    return () => {
      alive = false
      void listener.then(unlisten => unlisten())
    }
  }, [native, instance.id])
  useEffect(() => {
    setInput({ pressed: [], values: {} })
  }, [instance.enabled, instance.activeProfileId, status?.state])
  const changeSequence = (id: string, sequences: TriggerBehaviors) => {
    const triggers = removedProfileSwitchTriggers(profile.behaviors[id] ?? emptyTriggers(), sequences)
    if (triggers.length) {
      setPendingDeletion({ profileId: profile.id, inputId: id, triggers, sequences })
      return false
    }
    update(item => updateInstanceSequence(item, profile.id, id, sequences))
  }
  const renameProfile = (name: string) =>
    update(item => ({ ...item, profiles: item.profiles.map(p => (p.id === profile.id ? { ...p, name } : p)) }))
  const deleteProfile = () =>
    update(item => {
      if (item.profiles.length <= 1) return item
      const profiles = item.profiles.filter(p => p.id !== profile.id)
      return { ...item, profiles, activeProfileId: profiles[0].id }
    })
  const mapped = Object.keys(profile.behaviors).filter(id =>
    Object.values(profile.behaviors[id]).some(sequence => sequence.some(b => b.enabled)),
  )
  const ready = status?.state === 'exclusive'
  const deviceOffline =
    native &&
    platform === 'windows' &&
    (instance.kind === 'rc003' || instance.kind === 'cmiotA15') &&
    !!instance.binding &&
    status?.driverState === 'offline'
  const driverMissing =
    native &&
    platform === 'windows' &&
    (instance.kind === 'rc003' || instance.kind === 'cmiotA15') &&
    (!instance.binding || status?.driverState === 'missing')
  const currentDriverAction = instance.binding && driverAction?.instanceId === instance.id ? driverAction : null
  const driverRunning = currentDriverAction?.status === 'running'
  const driverRestartRequired = currentDriverAction?.status === 'restartRequired'
  const driverInstalled = status?.driverInstalled === true
  const driverBusy = driverAction?.status === 'running'
  return (
    <div
      ref={workspaceRef}
      data-driver-settings-hint={driverSettingsHint || undefined}
      className={`mapping-page mapping-flow-page managed-instance-workspace ${instance.kind === 'xboxBluetooth' ? 'is-controller' : ''}`}
    >
      <div className="mapping-workbench">
        <DeviceWorkspaceHeader
          deviceName={instance.name}
          settingsHint={driverSettingsHint ? '按键驱动可在这里管理' : undefined}
          onBackToDevices={onBack}
          onOpenSettings={() => {
            if (driverSettingsHint) {
              setSettingsSection('overview')
              setSettings(true)
              setDriverSettingsHint(false)
            } else {
              setSettings(v => !v)
            }
          }}
          profileControls={
            <ProfileManager
              profiles={instance.profiles}
              activeProfileId={instance.activeProfileId}
              onSwitch={activeProfileId => update(item => ({ ...item, activeProfileId }))}
              onCreate={() => update(item => addInstanceProfile(item, false))}
              onDuplicate={() => update(item => addInstanceProfile(item, true))}
              onRename={renameProfile}
              onDelete={deleteProfile}
            />
          }
        />
        {(deviceOffline ||
          driverRestartRequired ||
          (!instance.hideDriverMissingReminder && (driverMissing || currentDriverAction))) && (
          <div
            ref={driverNoticeRef}
            className="managed-driver-notice"
            role="status"
            aria-live="polite"
            data-dismissing={dismissingDriverNotice || undefined}
          >
            <span>
              {driverRestartRequired
                ? currentDriverAction.message
                : deviceOffline
                  ? '设备不在线'
                  : !instance.binding
                    ? '尚未绑定物理设备，请先绑定设备，再安装按键驱动。'
                    : driverRunning
                      ? '正在安装按键驱动，请完成 Windows 管理员授权…'
                      : (currentDriverAction?.error ?? '按键驱动未安装，安装后即可使用此设备的按键映射。')}
            </span>
            {!deviceOffline && !driverRestartRequired && (
              <button
                type="button"
                disabled={driverBusy || dismissingDriverNotice}
                onClick={instance.binding ? () => onInstallDriver(instance.id) : onBind}
              >
                {!instance.binding
                  ? '绑定设备'
                  : driverRunning
                    ? '正在安装…'
                    : driverInstalled
                      ? '重新安装驱动'
                      : currentDriverAction?.error
                        ? '重试安装'
                        : '安装驱动'}
              </button>
            )}
            {!deviceOffline && !driverRestartRequired && (
              <button
                type="button"
                className="managed-driver-notice-close"
                aria-label="隐藏驱动未安装提醒"
                title="隐藏驱动未安装提醒"
                disabled={dismissingDriverNotice}
                onClick={() => void dismissDriverNotice()}
              >
                <X size={16} aria-hidden="true" />
              </button>
            )}
          </div>
        )}
        <aside className="mapping-device-rail panel-surface">
          {(instance.kind === 'rc003' || instance.kind === 'cmiotA15') && (
            <DeviceRecordingStatus recording={native && !!status?.recording} />
          )}
          <section className="managed-instance-status" aria-label="设备状态">
            <div>
              <span className={ready ? 'ready' : status?.error ? 'warning' : ''}>
                {native ? instanceStatusLabel(instance, controller.snapshot) : '预览模式'}
              </span>
              <button
                type="button"
                role="switch"
                className={`switch ${instance.enabled ? 'on' : ''}`}
                aria-label="启用此设备"
                aria-checked={instance.enabled}
                onClick={() => update(item => ({ ...item, enabled: !item.enabled }))}
              >
                <span />
              </button>
            </div>
            {(instance.kind === 'rc003' || instance.kind === 'cmiotA15') && (
              <span className="managed-instance-power">
                <BatteryIndicator level={batteryLevel} />
              </span>
            )}
            <button className="managed-instance-bind" onClick={onBind}>
              {instance.binding ? '重新绑定' : '绑定设备'}
            </button>
          </section>
          <div className={`remote-stage ${instance.kind === 'xboxBluetooth' ? 'managed-controller-stage' : ''}`}>
            <div className="remote-art">
              {instance.kind === 'xboxBluetooth' ? (
                <ControllerDiagram selected={selected} pressed={input.pressed} mapped={mapped} onSelect={setSelected} />
              ) : (
                <RemoteControl
                  buttons={[...pkg.inputs] as { id: ButtonId; label: string }[]}
                  activeId={selected as ButtonId}
                  pressedId={(input.pressed[0] ?? null) as ButtonId | null}
                  mappedIds={mapped as ButtonId[]}
                  onSelect={setSelected}
                  remoteView={instance.kind === 'rc003' ? xiaomiRemoteView : cmiotA15RemoteDevice.remoteView}
                />
              )}
            </div>
          </div>
          {(instance.kind === 'rc003' ||
            (instance.kind === 'cmiotA15' && (platform === 'windows' || platform === 'macos'))) && (
            <button
              type="button"
              className="managed-audio-calibration"
              disabled={!native}
              title={!native ? '请在桌面应用中校准音量' : undefined}
              onClick={native ? () => onOpenAudioCalibration(instance.id) : undefined}
            >
              <SlidersHorizontal size={16} aria-hidden="true" />
              校准音量
            </button>
          )}
          {instance.kind === 'xboxBluetooth' && (
            <div className="managed-analog">
              <label>
                LT <meter min={0} max={1} value={input.values['xbox.lt'] ?? 0} />
              </label>
              <label>
                RT <meter min={0} max={1} value={input.values['xbox.rt'] ?? 0} />
              </label>
              <SettingsHelp id="managed-analog-help" label="摇杆与扳机映射">
                摇杆方向与扳机超过 55% 时触发，低于 35% 时释放。
              </SettingsHelp>
            </div>
          )}
        </aside>
        <section className="mapping-main" aria-label="设备映射流程图工作区">
          {status?.error && (
            <p role="alert" className="managed-error">
              {status.error}
            </p>
          )}
          {native && platform === 'macos' && (!permissions.accessibility || !permissions.inputMonitoring) && (
            <p className="managed-notice">
              需要
              {[!permissions.inputMonitoring && '输入监控', !permissions.accessibility && '辅助功能']
                .filter(Boolean)
                .join('、')}
              权限。<button onClick={onPermissions}>前往授权</button>
            </p>
          )}
          {settings ? (
            <div className="managed-instance-settings">
              <div className="managed-instance-settings-layout">
                <nav className="settings-nav managed-instance-settings-nav" aria-label={`${instance.name}设置分类`}>
                  <button
                    type="button"
                    aria-current={settingsSection === 'overview' ? 'page' : undefined}
                    onClick={() => setSettingsSection('overview')}
                  >
                    <Settings2 size={16} />
                    <span>设备设置</span>
                  </button>
                  <button
                    type="button"
                    aria-current={settingsSection === 'output' ? 'page' : undefined}
                    onClick={() => setSettingsSection('output')}
                  >
                    <Speaker size={16} />
                    <span>输出选择</span>
                  </button>
                  {instance.kind !== 'xboxBluetooth' && (
                    <button
                      type="button"
                      aria-current={settingsSection === 'information' ? 'page' : undefined}
                      onClick={() => setSettingsSection('information')}
                    >
                      <Info size={16} />
                      <span>设备信息</span>
                    </button>
                  )}
                </nav>
                <section className="managed-instance-settings-panel" aria-labelledby="managed-instance-settings-title">
                  <div className="managed-instance-settings-heading">
                    <div>
                      <h2 id="managed-instance-settings-title">
                        {settingsSection === 'information'
                          ? '设备信息'
                          : settingsSection === 'overview'
                            ? '设备设置'
                            : '输出选择'}
                      </h2>
                      {settingsSection !== 'information' && (
                        <p>
                          {settingsSection === 'output'
                            ? '选择语音输出设备，当前仅展示可用设备。'
                            : '管理设备名称、物理绑定和已有配置。'}
                        </p>
                      )}
                    </div>
                    {settingsSection === 'information' && (
                      <button
                        type="button"
                        className="settings-refresh"
                        aria-label="刷新设备信息"
                        title={
                          informationRefreshLocked ? `${informationRefreshRemaining} 秒后可再次刷新` : '刷新设备信息'
                        }
                        disabled={!native || !informationAvailable || !instance.binding || informationRefreshLocked}
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
                  </div>
                  {settingsSection === 'information' ? (
                    <DeviceInformationPanel binding={instance.binding} device={boundDevice} native={native} />
                  ) : settingsSection === 'output' ? (
                    <div className="managed-instance-output-panel">
                      <VoiceOutput
                        onOpenAudioDriver={onOpenAudioDriver}
                        idPrefix={`instance-${instance.id}`}
                        value={instance.voiceOutputDevice ?? ''}
                        onChange={voiceOutputDevice => update(item => ({ ...item, voiceOutputDevice }))}
                      />
                    </div>
                  ) : (
                    <>
                      {(instance.kind === 'rc003' || instance.kind === 'cmiotA15') && platform === 'windows' && (
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
                                onClick={() => onInstallDriver(instance.id)}
                              >
                                {driverRunning ? '正在安装…' : driverInstalled ? '重新安装驱动' : '安装驱动'}
                              </button>
                            )}
                          </div>
                        </div>
                      )}
                      <div className="settings-form-fields">
                        {instance.kind === 'cmiotA15' && (platform === 'windows' || platform === 'macos') && (
                          <label className="settings-form-row">
                            <span className="settings-form-label">语音录制：</span>
                            <span className="settings-form-control">
                              <span className="manual-key-select cmiot-recording-select">
                                <select
                                  value={instance.cmiotA15RecordingMode ?? 'hold'}
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
                            onBlur={e => {
                              const name = e.target.value.trim()
                              if (name && name !== instance.name) update(item => ({ ...item, name }))
                            }}
                          />
                        </label>
                        {instance.kind !== 'xboxBluetooth' && (
                          <div className="settings-form-row">
                            <span className="settings-form-label">原有配置：</span>
                            <div className="settings-form-control">
                              <button
                                onClick={() =>
                                  update(item => {
                                    const copied = structuredClone(legacyProfiles(item.kind)).map(p => ({
                                      ...p,
                                      id: crypto.randomUUID(),
                                      name: `${p.name}（副本）`,
                                    }))
                                    return copied.length
                                      ? {
                                          ...item,
                                          profiles: [...item.profiles, ...copied],
                                          activeProfileId: copied[0].id,
                                        }
                                      : item
                                  })
                                }
                              >
                                复制原配置
                              </button>
                            </div>
                          </div>
                        )}
                        <div className="settings-form-row">
                          <span className="settings-form-label" id="instance-binding-label">
                            物理设备：
                          </span>
                          <div className="settings-form-control managed-instance-binding-control">
                            {instance.binding ? (
                              <BoundDeviceInfo
                                binding={instance.binding}
                                device={boundDevice}
                                onUnbind={unbindDevice}
                                disabled={pendingPhysicalAction !== null}
                              />
                            ) : (
                              <DeviceBindingPicker
                                labelledBy="instance-binding-label"
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
                            <button disabled={pendingPhysicalAction !== null} onClick={removeDevice}>
                              {pendingPhysicalAction === 'remove' ? '正在解除绑定…' : '确认移除'}
                            </button>
                            <button onClick={() => setConfirmRemove(false)}>取消</button>
                          </>
                        ) : (
                          <button onClick={() => setConfirmRemove(true)}>移除设备</button>
                        )}
                      </div>
                    </>
                  )}
                </section>
              </div>
            </div>
          ) : (
            <>
              <section className="key-picker">
                <div className="key-picker-head">
                  <h2>{selectedInput.label}</h2>
                </div>
                {instance.kind === 'xboxBluetooth' && (
                  <div className="managed-workflow-triggers" role="group" aria-label="触发方式">
                    {triggerTypes.map(trigger => (
                      <button
                        type="button"
                        key={trigger}
                        className={`workflow-trigger-${trigger}`}
                        aria-pressed={controllerTrigger === trigger}
                        onClick={() => setControllerTrigger(trigger)}
                      >
                        {triggerLabels[trigger]}
                        <span>{profile.behaviors[selected]?.[trigger].length ?? 0}</span>
                      </button>
                    ))}
                  </div>
                )}
              </section>
              <WorkflowAxonkey
                key={profile.id + selected}
                platform={platform}
                button={selectedInput}
                sequences={profile.behaviors[selected] ?? emptyTriggers()}
                activeTrigger={instance.kind === 'xboxBluetooth' ? controllerTrigger : undefined}
                onChange={changeSequence}
                onRequestProfileSwitch={(inputId, trigger, behavior) =>
                  setPendingSwitch({ inputId, trigger, behavior })
                }
                toolboxCategory={toolboxCategory}
                onToolboxCategoryChange={setToolboxCategory}
              />
            </>
          )}
        </section>
      </div>
      {pendingSwitch &&
        createPortal(
          <ProfileSwitchConfirmDialog
            button={pkg.inputs.find(i => i.id === pendingSwitch.inputId)!}
            trigger={pendingSwitch.trigger}
            behavior={pendingSwitch.behavior}
            targets={instance.profiles.map(p => ({
              id: p.id,
              name: p.name,
              behaviors: p.behaviors[pendingSwitch.inputId]?.[pendingSwitch.trigger] ?? [],
            }))}
            activeProfileId={profile.id}
            platform={platform}
            onCancel={() => setPendingSwitch(null)}
            onConfirm={behavior => {
              update(item => applyInstanceProfileSwitch(item, pendingSwitch.inputId, pendingSwitch.trigger, behavior))
              setPendingSwitch(null)
            }}
          />,
          document.body,
        )}
      {pendingDeletion &&
        createPortal(
          <ProfileSwitchDeleteDialog
            button={pkg.inputs.find(i => i.id === pendingDeletion.inputId)!}
            targets={pendingDeletion.triggers.map(trigger => ({
              trigger,
              profiles: instance.profiles.filter(p =>
                p.behaviors[pendingDeletion.inputId]?.[trigger].some(b => b.type === 'switchProfile'),
              ),
            }))}
            onCancel={() => setPendingDeletion(null)}
            onConfirm={() => {
              update(item =>
                removeInstanceProfileSwitch(
                  item,
                  pendingDeletion.profileId,
                  pendingDeletion.inputId,
                  pendingDeletion.triggers,
                  pendingDeletion.sequences,
                ),
              )
              setPendingDeletion(null)
            }}
          />,
          document.body,
        )}
    </div>
  )
}

function BoundDeviceInfo({
  binding,
  device,
  onUnbind,
  disabled,
}: {
  binding: string
  device?: DiscoveredDevice
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
      <button type="button" onClick={onUnbind} disabled={disabled}>
        {disabled ? '正在解除绑定…' : '解除绑定，保留配置'}
      </button>
    </div>
  )
}

function DeviceInformationPanel({
  binding,
  device,
  native,
}: {
  binding: string | null
  device?: DiscoveredDevice
  native: boolean
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
          : info?.status === 'ready'
            ? '设备未提供'
            : info?.status === 'error'
              ? '读取失败'
              : info?.status === 'retrying'
                ? '正在重试…'
                : '读取中…'
  const value = (text?: string | number | null) => (!binding ? '未绑定设备' : (text ?? unavailable))
  const fields = [
    ['设备蓝牙名称', value(info?.bluetoothName)],
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
      {fields.map(([label, value]) => (
        <div className="settings-form-row" key={label}>
          <span className="settings-form-label">{label}：</span>
          <span className="settings-form-control">{value}</span>
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
