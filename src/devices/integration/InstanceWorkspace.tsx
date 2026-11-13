import { useCallback, useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { listen } from '@tauri-apps/api/event'
import { ChevronDown, Info, RefreshCw, Settings2, SlidersHorizontal } from 'lucide-react'
import { BehaviorHistoryActions } from '../../components/BehaviorHistoryActions'
import type { MacPermissions, ManagedDriverAction, MappingInput, Platform } from '../../appTypes'
import type { ButtonId, SwitchProfileBehavior, TriggerBehaviors, TriggerType } from '../../behaviorModel'
import { triggerTypes } from '../../behaviorModel'
import { triggerLabels } from '../../appConfig'
import { getStoredDeviceInput, storeDeviceInput } from '../../deviceInputSelection'
import { removedProfileSwitchTriggers } from '../../profileNavigation'
import { RemoteControl } from '../shared/RemoteControl'
import { ApplicationProfileToolbar } from '../../components/ApplicationProfileToolbar'
import { useForegroundApplications } from '../../useForegroundApplications'
import { setApplicationProfile } from './applicationProfiles'
import { ProfileSwitchConfirmDialog } from '../../components/ProfileSwitchConfirmDialog'
import { ProfileSwitchDeleteDialog } from '../../components/ProfileSwitchDeleteDialog'
import { SettingsHelp } from '../../components/SettingsHelp'
import { BatteryIndicator } from '../../components/BatteryIndicator'
import { DeviceRecordingStatus } from '../../components/DeviceRail'
import { reportTencentEvent } from '../../telemetry'
import { recordLibraryAdditions } from '../../cloud/libraryUsage'
import { defaultWorkflowSplitRatio } from '../../components/workflowSplitLayout'
import { WorkflowAxonkey } from '../../components/WorkflowAxonkey'
import { DeviceSettingsDrawer } from '../shared/DeviceSettingsDrawer'
import { DeviceWorkspaceHeader, type WorkspaceDeviceOption } from '../shared/DeviceWorkspaceHeader'
import { DeviceBindingPicker } from './IntegrationControls'
import {
  defaultRecordingMode,
  emptyTriggers,
  instanceState,
  packageFor,
  stateLabel,
  supportsWindowsDriver,
  usesHidVoice,
} from './model'
import type { DeviceInstance, DiscoveredDevice } from './model'
import type { DeviceController } from './useDeviceInstances'
import {
  addInstanceProfile,
  deleteInstanceProfile,
  applyInstanceProfileSwitch,
  createInstanceBehaviorHistory,
  instanceBehaviorHistoryReducer,
  removeInstanceProfileSwitch,
  replaceInstanceProfileBehaviors,
} from './instanceProfiles'
import type { InstanceBehaviorHistoryAction, InstanceProfileBehaviors } from './instanceProfiles'

type Props = {
  instance: DeviceInstance
  controller: DeviceController
  native: boolean
  platform: Platform
  permissions: MacPermissions
  onPermissions: () => void
  onBack: () => void
  onBind: () => void
  onUnbindDevice: (instanceId: string) => Promise<void>
  onRemoveDevice: (instanceId: string) => Promise<void>
  onOpenAudioCalibration: (instanceId: string) => void
  onOpenAudioDriver: () => void
  driverAction: ManagedDriverAction | null
  onInstallDriver: (instanceId: string) => void
  batteryLevel: number | null
  onToast?: (message: string) => void
  deviceOptions?: WorkspaceDeviceOption[]
  onSelectDevice?: (id: string) => void
}
export function InstanceWorkspace({
  instance,
  controller,
  native,
  platform,
  permissions,
  onPermissions,
  onBack,
  onBind,
  onUnbindDevice,
  onRemoveDevice,
  onOpenAudioCalibration,
  onOpenAudioDriver,
  onInstallDriver,
  driverAction,
  batteryLevel,
  onToast,
  deviceOptions,
  onSelectDevice,
}: Props) {
  const pkg = packageFor(instance.kind)
  const voice = pkg.remoteView?.voice
  const voiceModes = voice?.triggerModes ?? []
  const analogInputs = pkg.remoteView?.buttons.filter(button => button.kind === 'trigger') ?? []
  const [splitRatio, setSplitRatio] = useState(defaultWorkflowSplitRatio)
  const [selected, setSelected] = useState<string>(() =>
    getStoredDeviceInput(
      instance.id,
      pkg.inputs.map(input => input.id),
    ),
  )
  const selectInput = (inputId: string) => {
    setSelected(inputId)
    storeDeviceInput(instance.id, inputId)
  }
  const [settings, setSettings] = useState(false)
  const [editingApplicationId, setEditingApplicationId] = useState('')
  const applications = useForegroundApplications(native)
  const [recordingPending, setRecordingPending] = useState(false)
  const [driverNoticeDismissed, setDriverNoticeDismissed] = useState(false)
  const [dismissingDriverNotice, setDismissingDriverNotice] = useState(false)
  const workspaceRef = useRef<HTMLDivElement>(null)
  const driverNoticeRef = useRef<HTMLElement>(null)
  useEffect(() => {
    if (!instance.hideDriverMissingReminder) setDriverNoticeDismissed(false)
  }, [instance.hideDriverMissingReminder])
  const [settingsSection, setSettingsSection] = useState<'overview' | 'information'>('overview')
  const [confirmRemove, setConfirmRemove] = useState(false)
  const [pendingPhysicalAction, setPendingPhysicalAction] = useState<'unbind' | 'remove' | null>(null)
  const [toolboxCategory, setToolboxCategory] = useState('recommended')
  const [controllerTrigger, setControllerTrigger] = useState<TriggerType>('click')
  const [pendingSwitch, setPendingSwitch] = useState<{
    inputId: string
    trigger: TriggerType
    behavior: SwitchProfileBehavior
    additionItemId?: string
  } | null>(null)
  const [pendingDeletion, setPendingDeletion] = useState<{
    profileId: string
    inputId: string
    triggers: TriggerType[]
    sequences: TriggerBehaviors
  } | null>(null)
  const [input, setInput] = useState<{ pressed: string[]; values: Record<string, number> }>({ pressed: [], values: {} })
  const recordingRef = useRef({ instanceId: instance.id, recording: false })
  const applicationProfile = instance.applicationProfiles?.find(
    binding => binding.application.id === editingApplicationId,
  )
  const profile = instance.profiles.find(p => p.id === (applicationProfile?.profileId ?? instance.activeProfileId))!
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
  useEffect(() => {
    const recording = status?.recording === true
    const previous = recordingRef.current
    if (previous.instanceId === instance.id && recording && !previous.recording)
      reportTencentEvent('voice_recording_start')
    recordingRef.current = { instanceId: instance.id, recording }
  }, [instance.id, status?.recording])
  const availableDevices = controller.snapshot.discovered.filter(
    device =>
      device.kind === instance.kind &&
      !controller.snapshot.store.instances.some(item => item.id !== instance.id && item.binding === device.id),
  )
  const update = (change: (item: DeviceInstance) => DeviceInstance) => {
    void controller.update(instance.id, change).catch(() => {})
  }
  const toggleRecording = async () => {
    setRecordingPending(true)
    try {
      await controller.toggleRecording(instance.id)
    } catch {
      // The controller exposes HID errors through the device hub banner.
    } finally {
      setRecordingPending(false)
    }
  }
  const dismissDriverNotice = async () => {
    const notice = driverNoticeRef.current
    const settingsButton = workspaceRef.current?.querySelector<HTMLButtonElement>('.device-workspace-settings')
    if (!notice || !settingsButton || typeof notice.animate !== 'function') {
      try {
        await controller.update(instance.id, item => ({ ...item, hideDriverMissingReminder: true }))
        setDriverNoticeDismissed(true)
      } catch {
        // A failed save leaves the reminder visible; the controller displays the error.
      }
      return
    }
    setDismissingDriverNotice(true)
    const reducedMotion = typeof window !== 'undefined' && window.matchMedia('(prefers-reduced-motion: reduce)').matches
    const source = notice.getBoundingClientRect()
    const target = settingsButton.getBoundingClientRect()
    const dx = target.x + target.width / 2 - (source.x + source.width / 2)
    const dy = target.y + target.height / 2 - (source.y + source.height / 2)
    const flight = notice.animate(
      reducedMotion
        ? [{ opacity: 1 }, { opacity: 0 }]
        : [
            { transform: 'translate(0, 0) scale(1)', opacity: 1, borderRadius: '12px' },
            { transform: `translate(${dx * 0.7}px, ${dy * 0.7}px) scale(0.32)`, opacity: 0.75, offset: 0.62 },
            {
              transform: `translate(${dx}px, ${dy}px) scale(${target.width / source.width}, ${target.height / source.height})`,
              opacity: 0,
              borderRadius: '20px',
            },
          ],
      { duration: reducedMotion ? 100 : 520, easing: 'cubic-bezier(0.4, 0, 0.2, 1)', fill: 'forwards' },
    )
    let dismissed = false
    try {
      await flight.finished
      await controller.update(instance.id, item => ({ ...item, hideDriverMissingReminder: true }))
      setDriverNoticeDismissed(true)
      dismissed = true
    } catch {
      // A failed save leaves the reminder visible; the controller displays the error.
    } finally {
      if (!dismissed) flight.cancel()
      setDismissingDriverNotice(false)
    }
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
      .then(onBack)
      .catch(() => {})
      .finally(() => setPendingPhysicalAction(null))
  }
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
  }, [instance.enabled, profile.id, status?.state])
  const [history, setHistory] = useState(() => createInstanceBehaviorHistory(profile.id, profile.behaviors))
  const historyRef = useRef(history)
  historyRef.current = history
  const pendingSavesRef = useRef(0)
  const applyHistoryAction = useCallback((action: InstanceBehaviorHistoryAction) => {
    const current = historyRef.current
    const next = instanceBehaviorHistoryReducer(current, action)
    if (next === current) return null
    historyRef.current = next
    setHistory(next)
    return next
  }, [])
  useEffect(() => {
    if (profile.id !== historyRef.current.profileId) {
      applyHistoryAction({ type: 'replace', profileId: profile.id, present: profile.behaviors })
      return
    }
    if (pendingSavesRef.current === 0) {
      applyHistoryAction({ type: 'sync', profileId: profile.id, present: profile.behaviors })
    }
  }, [applyHistoryAction, profile.behaviors, profile.id])
  const saveProfileBehaviors = useCallback(
    (profileId: string, behaviors: InstanceProfileBehaviors) => {
      pendingSavesRef.current += 1
      void controller
        .update(instance.id, item => replaceInstanceProfileBehaviors(item, profileId, behaviors))
        .catch(() => {})
        .finally(() => {
          pendingSavesRef.current = Math.max(0, pendingSavesRef.current - 1)
        })
    },
    [controller, instance.id],
  )
  const activeBehaviors = history.profileId === profile.id ? history.present : profile.behaviors
  const canUndo = history.profileId === profile.id && history.past.length > 0
  const canRedo = history.profileId === profile.id && history.future.length > 0
  const undoBehaviorChange = useCallback(() => {
    if (historyRef.current.profileId !== profile.id) return
    const next = applyHistoryAction({ type: 'undo' })
    if (!next) return
    saveProfileBehaviors(profile.id, next.present)
    onToast?.('已撤销行为更改')
  }, [applyHistoryAction, onToast, profile.id, saveProfileBehaviors])
  const redoBehaviorChange = useCallback(() => {
    if (historyRef.current.profileId !== profile.id) return
    const next = applyHistoryAction({ type: 'redo' })
    if (!next) return
    saveProfileBehaviors(profile.id, next.present)
    onToast?.('已重做行为更改')
  }, [applyHistoryAction, onToast, profile.id, saveProfileBehaviors])
  const changeSequence = (id: string, sequences: TriggerBehaviors) => {
    if (historyRef.current.profileId !== profile.id) {
      const replaced = createInstanceBehaviorHistory(profile.id, profile.behaviors)
      historyRef.current = replaced
      setHistory(replaced)
    }
    const triggers = removedProfileSwitchTriggers(historyRef.current.present[id] ?? emptyTriggers(), sequences)
    if (triggers.length) {
      setPendingDeletion({ profileId: profile.id, inputId: id, triggers, sequences })
      return false
    }
    const next = applyHistoryAction({ type: 'change', inputId: id, sequences })
    if (!next) return
    saveProfileBehaviors(profile.id, next.present)
  }
  const renameProfile = (name: string) =>
    update(item => ({ ...item, profiles: item.profiles.map(p => (p.id === profile.id ? { ...p, name } : p)) }))
  const deleteProfile = () => update(item => deleteInstanceProfile(item, profile.id))
  const mapped = Object.keys(activeBehaviors).filter(id =>
    Object.values(activeBehaviors[id]).some(sequence => sequence.some(b => b.enabled)),
  )
  const supportsDriver = supportsWindowsDriver(instance.kind)
  const ready = status?.state === 'exclusive'
  const connectionState = native ? instanceState(instance, controller.snapshot) : undefined
  const connectionLabel = native ? stateLabel(connectionState) : '预览模式'
  const deviceOffline =
    native && platform === 'windows' && supportsDriver && !!instance.binding && status?.driverState === 'offline'
  const driverMissing =
    native && platform === 'windows' && supportsDriver && (!instance.binding || status?.driverState === 'missing')
  const currentDriverAction = instance.binding && driverAction?.instanceId === instance.id ? driverAction : null
  const driverRunning = currentDriverAction?.status === 'running'
  const driverRestartRequired = currentDriverAction?.status === 'restartRequired'
  const driverInstalled = status?.driverInstalled === true
  const driverCommunicationError =
    native && platform === 'windows' && supportsDriver && instance.binding && driverInstalled && !deviceOffline
      ? status?.error
      : null
  const driverBusy = driverAction?.status === 'running'
  const driverErrorDetail = !deviceOffline
    ? currentDriverAction?.status === 'error'
      ? currentDriverAction.error
      : driverCommunicationError
    : null
  const showDriverNotice =
    !instance.hideDriverMissingReminder && !driverNoticeDismissed && (driverMissing || !!driverErrorDetail)
  useEffect(() => {
    if (typeof window === 'undefined' || typeof window.addEventListener !== 'function') return
    if (settings || pendingSwitch || pendingDeletion || showDriverNotice) return
    const handleHistoryShortcut = (event: globalThis.KeyboardEvent) => {
      if (event.defaultPrevented || event.altKey || (!event.metaKey && !event.ctrlKey)) return
      const target = event.target
      if (
        target instanceof HTMLElement &&
        (target.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName))
      )
        return
      if (
        typeof document !== 'undefined' &&
        document.querySelector?.('dialog[open], [aria-modal="true"], .app-settings-panel, .record-key-button.capturing')
      )
        return
      const key = event.key.toLowerCase()
      const undo = key === 'z' && !event.shiftKey
      const redo = (key === 'z' && event.shiftKey) || (key === 'y' && event.ctrlKey && !event.metaKey)
      if (undo && canUndo) {
        event.preventDefault()
        undoBehaviorChange()
      } else if (redo && canRedo) {
        event.preventDefault()
        redoBehaviorChange()
      }
    }
    window.addEventListener('keydown', handleHistoryShortcut)
    return () => window.removeEventListener('keydown', handleHistoryShortcut)
  }, [
    canRedo,
    canUndo,
    pendingDeletion,
    pendingSwitch,
    redoBehaviorChange,
    settings,
    showDriverNotice,
    undoBehaviorChange,
  ])
  const driverNoticeMessage = driverErrorDetail
    ? '驱动错误，请重新安装。'
    : driverRestartRequired
      ? (currentDriverAction?.message ?? '需要重启 Windows 后继续安装驱动。')
      : deviceOffline
        ? '设备不在线'
        : !instance.binding
          ? '尚未绑定物理设备，请先绑定设备，再安装按键驱动。'
          : driverRunning
            ? '正在安装按键驱动，请完成 Windows 管理员授权…'
            : '按键驱动未安装，请先安装此设备的按键驱动。'
  return (
    <div
      ref={workspaceRef}
      className={`mapping-page mapping-flow-page managed-instance-workspace ${instance.kind === 'xboxBluetooth' ? 'is-controller' : ''}`}
    >
      <div className="mapping-workbench">
        <DeviceWorkspaceHeader
          deviceName={instance.name}
          activeDeviceId={instance.id}
          deviceOptions={deviceOptions}
          onSelectDevice={onSelectDevice}
          onBackToDevices={onBack}
          onOpenSettings={() => setSettings(v => !v)}
          profileControls={
            <ApplicationProfileToolbar
              instance={instance}
              applications={applications}
              native={native}
              platform={platform}
              editingApplicationId={applicationProfile?.application.id ?? ''}
              profileId={profile.id}
              onSelectApplication={setEditingApplicationId}
              onUpdate={change => controller.update(instance.id, change)}
              onSwitchProfile={profileId =>
                update(item =>
                  applicationProfile
                    ? setApplicationProfile(item, applicationProfile.application, profileId)
                    : { ...item, activeProfileId: profileId },
                )
              }
              onCreateProfile={() =>
                update(item => addInstanceProfile(item, false, applicationProfile?.application.id))
              }
              onDuplicateProfile={() =>
                update(item => addInstanceProfile(item, true, applicationProfile?.application.id))
              }
              onRenameProfile={renameProfile}
              onDeleteProfile={deleteProfile}
            />
          }
        />
        {showDriverNotice &&
          createPortal(
            <div className="managed-driver-notice-backdrop" role="presentation">
              <section
                ref={driverNoticeRef}
                className="managed-driver-notice"
                role="dialog"
                aria-modal="true"
                aria-labelledby="managed-driver-notice-title"
                aria-describedby="managed-driver-notice-description"
                data-dismissing={dismissingDriverNotice || undefined}
              >
                <h2 id="managed-driver-notice-title">{driverErrorDetail ? '驱动错误' : '设备按键驱动提示'}</h2>
                <p id="managed-driver-notice-description">{driverNoticeMessage}</p>
                {driverErrorDetail && (
                  <details className="managed-driver-notice-details">
                    <summary>查看错误详情</summary>
                    <code>{driverErrorDetail}</code>
                  </details>
                )}
                <div className="managed-driver-notice-actions">
                  {!deviceOffline && !driverRestartRequired && (
                    <button
                      type="button"
                      className="managed-driver-notice-install"
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
                  <button
                    type="button"
                    className="managed-driver-notice-close"
                    aria-label="关闭驱动提示"
                    disabled={dismissingDriverNotice}
                    onClick={() => void dismissDriverNotice()}
                  >
                    关闭
                  </button>
                </div>
              </section>
            </div>,
            document.body,
          )}
        {!showDriverNotice &&
          (deviceOffline ||
            driverRestartRequired ||
            driverCommunicationError ||
            driverMissing ||
            currentDriverAction) && (
            <div className="managed-driver-notice" role="status" aria-live="polite">
              <span>{driverNoticeMessage}</span>
              {!deviceOffline && !driverRestartRequired && (
                <button
                  type="button"
                  disabled={driverBusy}
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
            </div>
          )}
        <aside className="mapping-device-rail panel-surface">
          <section className="managed-instance-status" aria-label="设备状态">
            {instance.binding ? (
              <span
                className={`managed-instance-connection${connectionState === 'exclusive' ? ' ready' : status?.error ? ' warning' : ''}`}
                title={connectionLabel}
              >
                {connectionState === 'needsRebind' ? '需重新绑定' : connectionLabel}
              </span>
            ) : (
              <button type="button" className="managed-instance-bind" onClick={onBind}>
                绑定设备
              </button>
            )}
            {voice && (
              <span className="managed-instance-power">
                <BatteryIndicator level={batteryLevel} compact />
              </span>
            )}
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
          </section>
          <div className={`remote-stage ${instance.kind === 'xboxBluetooth' ? 'managed-controller-stage' : ''}`}>
            <div className="remote-art">
              <RemoteControl
                activeId={selected}
                pressedIds={input.pressed}
                mappedIds={mapped}
                onSelect={selectInput}
                remoteView={pkg.remoteView}
              />
            </div>
          </div>
          {voice && (
            <DeviceRecordingStatus
              recording={native && !!status?.recording}
              onToggle={voice.engine === 'cmiot-a15.g7221' ? () => void toggleRecording() : undefined}
              disabled={!native || !instance.enabled || !informationAvailable || !ready || recordingPending}
            />
          )}
          {voice &&
            (voice.transport === 'gatt' ||
              (usesHidVoice(instance.kind) && (platform === 'windows' || platform === 'macos'))) && (
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
          {analogInputs.length > 0 && (
            <div className="managed-analog">
              {analogInputs.map(button => (
                <label key={button.id}>
                  {button.short} <meter min={0} max={1} value={input.values[button.id] ?? 0} />
                </label>
              ))}
              <SettingsHelp id="managed-analog-help" label="摇杆与扳机映射">
                {analogInputs.map(button => (
                  <p key={button.id}>
                    {button.short} 超过 {Math.round(button.threshold * 100)}% 时触发，低于{' '}
                    {Math.round(button.releaseThreshold * 100)}% 时释放。
                  </p>
                ))}
              </SettingsHelp>
            </div>
          )}
        </aside>
        <section className="mapping-main" aria-label="设备映射流程图工作区">
          {status?.error && !driverCommunicationError && (
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
          <WorkflowAxonkey
            header={
              <section className="key-picker">
                <div className="key-picker-head">
                  <div className="key-picker-heading">
                    <h2>{selectedInput.label}</h2>
                    {selectedInput.icon === 'mic' && (
                      <span
                        className="key-picker-voice-guidance"
                        title="要按住说话，请将语音快捷键配在「单击」，「双击」「长按」留空。这样按下即保持、松开即释放；「长按」表示按住一段时间后触发行为。"
                      >
                        要按住说话，请将语音快捷键配在「单击」，「双击」「长按」留空
                      </span>
                    )}
                  </div>
                  <div className="key-picker-actions">
                    <BehaviorHistoryActions
                      canUndo={canUndo}
                      canRedo={canRedo}
                      onUndo={undoBehaviorChange}
                      onRedo={redoBehaviorChange}
                    />
                  </div>
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
                        <span>{activeBehaviors[selected]?.[trigger].length ?? 0}</span>
                      </button>
                    ))}
                  </div>
                )}
              </section>
            }
            splitRatio={splitRatio}
            onSplitRatioChange={setSplitRatio}
            platform={platform}
            button={selectedInput}
            sequences={activeBehaviors[selected] ?? emptyTriggers()}
            activeTrigger={instance.kind === 'xboxBluetooth' ? controllerTrigger : undefined}
            onChange={changeSequence}
            onRequestProfileSwitch={(inputId, trigger, behavior, additionItemId) =>
              setPendingSwitch({ inputId, trigger, behavior, additionItemId })
            }
            toolboxCategory={toolboxCategory}
            onToolboxCategoryChange={setToolboxCategory}
          />
        </section>
      </div>
      {settings && (
        <DeviceSettingsDrawer deviceName={instance.name} onClose={() => setSettings(false)}>
          <nav className="settings-nav device-settings-drawer-nav" aria-label={`${instance.name}设置分类`}>
            <button
              type="button"
              aria-current={settingsSection === 'overview' ? 'page' : undefined}
              onClick={() => setSettingsSection('overview')}
            >
              <Settings2 size={16} />
              <span>设备设置</span>
            </button>
            {voice && (
              <button
                type="button"
                aria-current={settingsSection === 'information' ? 'page' : undefined}
                onClick={() => setSettingsSection('information')}
              >
                <Info size={16} />
                <span>设备信息</span>
              </button>
            )}
            {settingsSection === 'information' && (
              <button
                type="button"
                className="settings-refresh"
                aria-label="刷新设备信息"
                title={informationRefreshLocked ? `${informationRefreshRemaining} 秒后可再次刷新` : '刷新设备信息'}
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
          </nav>
          <section
            className="device-settings-drawer-panel"
            aria-label={settingsSection === 'information' ? '设备信息' : '设备设置'}
          >
            {settingsSection === 'information' ? (
              <DeviceInformationPanel binding={instance.binding} device={boundDevice} native={native} />
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
                          onClick={() => onInstallDriver(instance.id)}
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
                    <span className="settings-form-label" id="instance-binding-label">
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
        </DeviceSettingsDrawer>
      )}
      {pendingSwitch &&
        createPortal(
          <ProfileSwitchConfirmDialog
            button={pkg.inputs.find(i => i.id === pendingSwitch.inputId)!}
            trigger={pendingSwitch.trigger}
            behavior={pendingSwitch.behavior}
            targets={instance.profiles.map(p => ({
              id: p.id,
              name: p.name,
              behaviors:
                (p.id === profile.id ? activeBehaviors : p.behaviors)[pendingSwitch.inputId]?.[pendingSwitch.trigger] ??
                [],
            }))}
            activeProfileId={profile.id}
            platform={platform}
            onCancel={() => setPendingSwitch(null)}
            onConfirm={behavior => {
              pendingSavesRef.current += 1
              let nextProfileBehaviors: InstanceProfileBehaviors | undefined
              void controller
                .update(instance.id, item => {
                  const updated = applyInstanceProfileSwitch(
                    item,
                    pendingSwitch.inputId,
                    pendingSwitch.trigger,
                    behavior,
                  )
                  nextProfileBehaviors = updated.profiles.find(p => p.id === profile.id)?.behaviors
                  return updated
                })
                .then(() => {
                  if (nextProfileBehaviors && historyRef.current.profileId === profile.id) {
                    applyHistoryAction({ type: 'replace', profileId: profile.id, present: nextProfileBehaviors })
                  }
                  if (pendingSwitch.additionItemId && behavior.enabled)
                    recordLibraryAdditions([pendingSwitch.additionItemId])
                  onToast?.('已应用到此设备的所有配置文件')
                })
                .catch(() => {})
                .finally(() => {
                  pendingSavesRef.current = Math.max(0, pendingSavesRef.current - 1)
                })
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
                (p.id === profile.id ? activeBehaviors : p.behaviors)[pendingDeletion.inputId]?.[trigger].some(
                  b => b.type === 'switchProfile',
                ),
              ),
            }))}
            onCancel={() => setPendingDeletion(null)}
            onConfirm={() => {
              pendingSavesRef.current += 1
              let nextProfileBehaviors: InstanceProfileBehaviors | undefined
              void controller
                .update(instance.id, item => {
                  const updated = removeInstanceProfileSwitch(
                    item,
                    pendingDeletion.profileId,
                    pendingDeletion.inputId,
                    pendingDeletion.triggers,
                    pendingDeletion.sequences,
                  )
                  nextProfileBehaviors = updated.profiles.find(p => p.id === pendingDeletion.profileId)?.behaviors
                  return updated
                })
                .then(() => {
                  if (nextProfileBehaviors && historyRef.current.profileId === pendingDeletion.profileId) {
                    applyHistoryAction({
                      type: 'replace',
                      profileId: pendingDeletion.profileId,
                      present: nextProfileBehaviors,
                    })
                  }
                  onToast?.('已同步删除切换配置文件行为')
                })
                .catch(() => {})
                .finally(() => {
                  pendingSavesRef.current = Math.max(0, pendingSavesRef.current - 1)
                })
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
