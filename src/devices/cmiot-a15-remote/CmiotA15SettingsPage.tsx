import { ChevronDown } from 'lucide-react'
import type { DeviceSettingsPageProps } from '../types'

export function CmiotA15SettingsPage({
  cmiotA15RecordingMode,
  onCmiotA15RecordingModeChange,
  onOpenAudioDriver,
}: DeviceSettingsPageProps) {
  return (
    <section className="device-settings-drawer-panel" aria-label="设备概览">
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
  )
}
