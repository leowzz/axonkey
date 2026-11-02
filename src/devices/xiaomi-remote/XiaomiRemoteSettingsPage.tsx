import { CircleHelp, Settings2 } from 'lucide-react'
import { DeviceWorkspaceHeader } from '../shared/DeviceWorkspaceHeader'

type XiaomiRemoteSettingsPageProps = {
  onBackToDevices: () => void
  onOpenAudioDriver: () => void
}

export function XiaomiRemoteSettingsPage({ onBackToDevices, onOpenAudioDriver }: XiaomiRemoteSettingsPageProps) {
  return (
    <div className="device-settings-page">
      <DeviceWorkspaceHeader deviceName="小米遥控器" profileControls={null} onBackToDevices={onBackToDevices} />
      <div className="device-settings-layout">
        <nav className="settings-nav device-settings-nav" aria-label="小米遥控器设置分类">
          <button type="button" aria-current="page">
            <Settings2 size={16} />
            <span>设备概览</span>
          </button>
        </nav>
        <section className="device-settings-panel" aria-labelledby="xiaomi-settings-title">
          <div className="device-settings-heading">
            <div>
              <h2 id="xiaomi-settings-title">设备概览</h2>
              <p>小米遥控器 · RC003</p>
            </div>
            <CircleHelp size={18} aria-label="设置说明" />
          </div>
          <div className="settings-form-fields">
            <div className="settings-form-row">
              <span className="settings-form-label">虚拟麦克风：</span>
              <div className="settings-form-control">
                <button type="button" className="dialog-secondary" onClick={onOpenAudioDriver}>
                  管理驱动
                </button>
              </div>
            </div>
          </div>
        </section>
      </div>
    </div>
  )
}
