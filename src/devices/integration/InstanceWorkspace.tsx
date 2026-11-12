import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { listen } from '@tauri-apps/api/event'
import { SlidersHorizontal } from 'lucide-react'
import type {
  MacPermissions,
  ManagedDriverAction,
  ManagedDriverInstallOutcome,
  MappingInput,
  Platform,
} from '../../appTypes'
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
import { DeviceWorkspaceHeader } from '../shared/DeviceWorkspaceHeader'
import { InstanceSettingsDrawer } from './InstanceSettingsDrawer'
import { emptyTriggers, instanceState, packageFor, stateLabel, supportsWindowsDriver, usesHidVoice } from './model'
import type { DeviceInstance } from './model'
import type { DeviceController } from './useDeviceInstances'
import {
  addInstanceProfile,
  deleteInstanceProfile,
  applyInstanceProfileSwitch,
  removeInstanceProfileSwitch,
  updateInstanceSequence,
} from './instanceProfiles'

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
  onInstallDriver: (
    instanceId: string,
  ) => Promise<ManagedDriverInstallOutcome | void> | ManagedDriverInstallOutcome | void
  batteryLevel: number | null
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
}: Props) {
  const pkg = packageFor(instance.kind)
  const voice = pkg.remoteView?.voice
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
  const workspaceRef = useRef<HTMLDivElement>(null)
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
  const informationAvailable = !!boundDevice?.connected && boundDevice.identityQuality !== 'ambiguous'
  useEffect(() => {
    const recording = status?.recording === true
    const previous = recordingRef.current
    if (previous.instanceId === instance.id && recording && !previous.recording)
      reportTencentEvent('voice_recording_start')
    recordingRef.current = { instanceId: instance.id, recording }
  }, [instance.id, status?.recording])
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
  const deleteProfile = () => update(item => deleteInstanceProfile(item, profile.id))
  const mapped = Object.keys(profile.behaviors).filter(id =>
    Object.values(profile.behaviors[id]).some(sequence => sequence.some(b => b.enabled)),
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
  const showDriverBanner =
    deviceOffline || driverRestartRequired || !!driverErrorDetail || driverMissing || !!currentDriverAction
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
        {showDriverBanner && (
          <div className="managed-driver-notice" role="status" aria-live="polite">
            <div className="managed-driver-notice-copy">
              <span>{driverNoticeMessage}</span>
              {driverErrorDetail && (
                <details className="managed-driver-notice-details">
                  <summary>查看错误详情</summary>
                  <code>{driverErrorDetail}</code>
                </details>
              )}
            </div>
            {!deviceOffline && !driverRestartRequired && (
              <button
                type="button"
                className="managed-driver-notice-install"
                disabled={driverBusy}
                onClick={instance.binding ? () => void onInstallDriver(instance.id) : onBind}
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
                {connectionState === 'exclusive'
                  ? '拦截中'
                  : connectionState === 'needsRebind'
                    ? '需重新绑定'
                    : connectionLabel}
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
            }
            splitRatio={splitRatio}
            onSplitRatioChange={setSplitRatio}
            platform={platform}
            button={selectedInput}
            sequences={profile.behaviors[selected] ?? emptyTriggers()}
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
      <InstanceSettingsDrawer
        open={settings}
        instance={instance}
        controller={controller}
        native={native}
        platform={platform}
        driverAction={driverAction}
        onInstallDriver={onInstallDriver}
        onBind={onBind}
        onUnbindDevice={onUnbindDevice}
        onRemoveDevice={onRemoveDevice}
        onOpenAudioDriver={onOpenAudioDriver}
        onClose={() => setSettings(false)}
        onRemoved={onBack}
      />
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
              void controller
                .update(instance.id, item =>
                  applyInstanceProfileSwitch(item, pendingSwitch.inputId, pendingSwitch.trigger, behavior),
                )
                .then(() => {
                  if (pendingSwitch.additionItemId && behavior.enabled)
                    recordLibraryAdditions([pendingSwitch.additionItemId])
                })
                .catch(() => {})
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
