import { useState } from 'react'
import type { Application, ForegroundApplications } from '../applications'
import type { MappingProfile } from '../appTypes'
import { AddApplicationDialog, ApplicationSelect } from './ApplicationProfileToolbar'
import { ProfileManager } from './ProfileManager'
import { SettingsHelp } from './SettingsHelp'
import './ApplicationProfileToolbar.css'

export function MouseApplicationProfileToolbar({
  profiles,
  activeProfileId,
  applications,
  editingApplicationId,
  autoSwitching,
  native,
  platform,
  onSelectApplication,
  onAddApplication,
  onSwitchProfile,
  onToggle,
  onCreate,
  onDuplicate,
  onRename,
  onDelete,
  onRemoveApplication,
}: {
  profiles: MappingProfile[]
  activeProfileId: string
  applications: ForegroundApplications
  editingApplicationId: string
  autoSwitching: boolean
  native: boolean
  platform: 'windows' | 'macos' | 'unsupported'
  onSelectApplication: (id: string) => void
  onAddApplication: (application: Application) => void
  onSwitchProfile: (id: string) => void
  onToggle: () => void
  onCreate: () => void
  onDuplicate: () => void
  onRename: (name: string) => void
  onDelete: () => void
  onRemoveApplication?: () => void
}) {
  const [adding, setAdding] = useState(false)
  const bindings = profiles.flatMap(profile =>
    (profile.applicationIds ?? []).map(applicationId => {
      const known =
        applications.current?.id === applicationId
          ? applications.current
          : applications.recent.find(entry => entry.application.id === applicationId)?.application
      return {
        id: applicationId,
        name: known?.name ?? applicationId,
        path: known?.path ?? '',
        detail: profile.name,
      }
    }),
  )
  const recent = applications.recent
    .filter(entry => !bindings.some(binding => binding.id === entry.application.id))
    .map(entry => entry.application)
  return (
    <div className="application-profile-toolbar mouse-application-profile-toolbar">
      <div className="application-edit-target">
        <span>编辑应用</span>
        <ApplicationSelect
          value={editingApplicationId}
          added={bindings}
          recent={recent}
          native={native}
          onSelect={onSelectApplication}
          onAddApplication={() => setAdding(true)}
        />
      </div>
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
          onRemoveApplication={onRemoveApplication}
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
          disabled={!applications.supported}
          onClick={onToggle}
        >
          <span />
        </button>
        <SettingsHelp id="mouse-application-profile-help" label="自动切换">
          未关联的应用使用设备全局配置。已关联的应用中，按键切换会使用对应配置；关闭自动切换后不会删除应用关联。
        </SettingsHelp>
      </div>
      {applications.error && (
        <p className="application-profile-error" role="alert">
          {applications.error}
        </p>
      )}
      {adding && (
        <AddApplicationDialog
          native={native}
          platform={platform}
          onAdd={async application => {
            onAddApplication(application)
            setAdding(false)
          }}
          onClose={() => setAdding(false)}
        />
      )}
    </div>
  )
}
