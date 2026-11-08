import type { ForegroundApplications } from '../applications'
import type { MappingProfile } from '../appTypes'
import { ProfileManager } from './ProfileManager'
import { SelectControl } from './SelectControl'
import { SettingsHelp } from './SettingsHelp'
import './ApplicationProfileToolbar.css'

export function MouseApplicationProfileToolbar({
  profiles,
  activeProfileId,
  applications,
  editingApplicationId,
  autoSwitching,
  onSelectApplication,
  onSwitchProfile,
  onToggle,
  onCreate,
  onDuplicate,
  onRename,
  onDelete,
}: {
  profiles: MappingProfile[]
  activeProfileId: string
  applications: ForegroundApplications
  editingApplicationId: string
  autoSwitching: boolean
  onSelectApplication: (id: string) => void
  onSwitchProfile: (id: string) => void
  onToggle: () => void
  onCreate: () => void
  onDuplicate: () => void
  onRename: (name: string) => void
  onDelete: () => void
}) {
  const bindings = profiles.flatMap(profile =>
    (profile.applicationIds ?? []).map(applicationId => ({ profile, applicationId })),
  )
  const recent = applications.recent.filter(
    entry => !bindings.some(binding => binding.applicationId === entry.application.id),
  )
  return (
    <div className="application-profile-toolbar mouse-application-profile-toolbar">
      <label className="application-edit-target">
        编辑应用
        <SelectControl
          aria-label="编辑应用"
          value={editingApplicationId}
          onChange={event => onSelectApplication(event.target.value)}
        >
          <option value="">全局</option>
          {bindings.length > 0 && (
            <optgroup label="已添加">
              {bindings.map(({ applicationId, profile }) => (
                <option key={applicationId} value={applicationId}>
                  {applications.recent.find(entry => entry.application.id === applicationId)?.application.name ??
                    applicationId}
                  {' · '}
                  {profile.name}
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
        </SelectControl>
      </label>
      <div className="application-edit-profile">
        <span>配置</span>
        <ProfileManager
          compact
          profiles={profiles}
          activeProfileId={activeProfileId}
          onSwitch={onSwitchProfile}
          onCreate={onCreate}
          onDuplicate={onDuplicate}
          onRename={onRename}
          onDelete={onDelete}
        />
      </div>
      <div className="application-auto-switch">
        <span>自动切换</span>
        <button
          type="button"
          role="switch"
          className={`switch ${autoSwitching ? 'on' : ''}`}
          aria-label="按前台应用自动切换配置"
          aria-checked={autoSwitching}
          onClick={onToggle}
        >
          <span />
        </button>
        <SettingsHelp id="mouse-application-profile-help" label="自动切换">
          未关联的应用使用设备全局配置。已关联的应用中，按键切换会使用对应配置；关闭自动切换后不会删除应用关联。
        </SettingsHelp>
      </div>
    </div>
  )
}
