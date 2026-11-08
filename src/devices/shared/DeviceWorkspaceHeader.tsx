import { ArrowLeft, Settings } from 'lucide-react'
import type { ReactNode } from 'react'

type DeviceWorkspaceHeaderProps = {
  deviceName: string
  profileControls: ReactNode
  onBackToDevices: () => void
  onOpenSettings?: () => void
}

export function DeviceWorkspaceHeader({
  deviceName,
  profileControls,
  onBackToDevices,
  onOpenSettings,
}: DeviceWorkspaceHeaderProps) {
  return (
    <header className="device-workspace-header">
      <div className="device-workspace-title">
        <button type="button" className="device-workspace-back" aria-label="返回我的设备" onClick={onBackToDevices}>
          <ArrowLeft size={15} />
          我的设备
        </button>
        <h1>{deviceName}</h1>
      </div>
      <div className="device-workspace-controls">{profileControls}</div>
      {onOpenSettings ? (
        <button
          type="button"
          className="device-workspace-settings"
          aria-label={`${deviceName}设置`}
          title="设备设置"
          onClick={onOpenSettings}
        >
          <Settings size={16} />
        </button>
      ) : (
        <span aria-hidden="true" />
      )}
    </header>
  )
}
