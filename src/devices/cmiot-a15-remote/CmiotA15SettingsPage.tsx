import { ChevronDown, CircleHelp, Settings2 } from 'lucide-react'
import type { DeviceSettingsPageProps } from '../types'
import { DeviceWorkspaceHeader } from '../shared/DeviceWorkspaceHeader'

export function CmiotA15SettingsPage({
  onBackToDevices,
  cmiotA15RecordingMode,
  onCmiotA15RecordingModeChange,
  onOpenAudioDriver,
}: DeviceSettingsPageProps) {
  return (
    <div className="device-settings-page">
      <DeviceWorkspaceHeader
        deviceName="移动遥控器 CMIOT-A15"
        profileControls={null}
        onBackToDevices={onBackToDevices}
      />
      <div className="device-settings-layout">
        <nav className="settings-nav device-settings-nav" aria-label="移动遥控器 CMIOT-A15设置分类">
          <button type="button" aria-current="page">
            <Settings2 size={16} />
            <span>设备概览</span>
          </button>
        </nav>
        <section className="device-settings-panel" aria-labelledby="cmiot-a15-settings-title">
          <div className="device-settings-heading">
            <div>
              <h2 id="cmiot-a15-settings-title">设备概览</h2>
              <p>移动遥控器 · CMIOT-A15</p>
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
            <div className="settings-form-row">
              <label className="settings-form-label" htmlFor="cmiot-a15-recording-mode">
                语音录制：
              </label>
              <div className="settings-form-control">
                <div className="manual-key-select cmiot-recording-select">
                  <select
                    id="cmiot-a15-recording-mode"
                    value={cmiotA15RecordingMode}
                    onChange={event => onCmiotA15RecordingModeChange(event.target.value === 'click' ? 'click' : 'hold')}
                  >
                    <option value="hold">按住录音，松开停止</option>
                    <option value="click">点击开始，再次点击停止</option>
                  </select>
                  <span className="manual-key-select-icon" aria-hidden="true">
                    <ChevronDown size={14} />
                  </span>
                </div>
              </div>
            </div>
          </div>
        </section>
      </div>
    </div>
  )
}
