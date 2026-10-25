import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { listen } from '@tauri-apps/api/event'
import { SlidersHorizontal } from 'lucide-react'
import type { MacPermissions, MappingInput, Platform } from '../../appTypes'
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
import { WorkflowAxonkey } from '../../components/WorkflowAxonkey'
import { DeviceWorkspaceHeader } from '../shared/DeviceWorkspaceHeader'
import { DeviceBindingPicker } from './IntegrationControls'
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
  onOpenAudioCalibration: () => void
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
  onOpenAudioCalibration,
  batteryLevel,
}: Props) {
  const pkg = packageFor(instance.kind)
  const [selected, setSelected] = useState(pkg.inputs[0].id as string)
  const [settings, setSettings] = useState(false)
  const [confirmRemove, setConfirmRemove] = useState(false)
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
  const availableDevices = controller.snapshot.discovered.filter(
    device =>
      device.kind === instance.kind &&
      !controller.snapshot.store.instances.some(item => item.id !== instance.id && item.binding === device.id),
  )
  const update = (change: (item: DeviceInstance) => DeviceInstance) => {
    void controller.update(instance.id, change).catch(() => {})
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
  return (
    <div
      className={`mapping-page mapping-flow-page managed-instance-workspace ${instance.kind === 'xboxBluetooth' ? 'is-controller' : ''}`}
    >
      <div className="mapping-workbench">
        <DeviceWorkspaceHeader
          deviceName={instance.name}
          onBackToDevices={onBack}
          onOpenSettings={() => setSettings(v => !v)}
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
        <aside className="mapping-device-rail panel-surface">
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
            {instance.kind === 'rc003' && (
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
          {instance.kind === 'rc003' && (
            <button
              type="button"
              className="managed-audio-calibration"
              disabled={!native}
              title={!native ? '请在桌面应用中校准音量' : undefined}
              onClick={native ? onOpenAudioCalibration : undefined}
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
              <div className="settings-form-fields">
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
                              ? { ...item, profiles: [...item.profiles, ...copied], activeProfileId: copied[0].id }
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
                        onUnbind={() => update(item => ({ ...item, binding: null }))}
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
                    <button
                      onClick={() =>
                        void controller
                          .remove(instance.id)
                          .then(onBack)
                          .catch(() => {})
                      }
                    >
                      确认移除
                    </button>
                    <button onClick={() => setConfirmRemove(false)}>取消</button>
                  </>
                ) : (
                  <button onClick={() => setConfirmRemove(true)}>移除设备</button>
                )}
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
}: {
  binding: string
  device?: DiscoveredDevice
  onUnbind: () => void
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
      <button type="button" onClick={onUnbind}>
        解除绑定，保留配置
      </button>
    </div>
  )
}
