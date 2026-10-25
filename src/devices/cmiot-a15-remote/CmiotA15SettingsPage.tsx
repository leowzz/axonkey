import { CircleHelp, Settings2, Speaker } from 'lucide-react'
import { useState } from 'react'
import { VoiceOutput } from '../xiaomi-remote/settings/VoiceOutput'
import type { DeviceSettingsPageProps } from '../types'
import { DeviceWorkspaceHeader } from '../shared/DeviceWorkspaceHeader'

export function CmiotA15SettingsPage({ onBackToDevices, cmiotA15RecordingMode, onCmiotA15RecordingModeChange }: DeviceSettingsPageProps) {
  const [section, setSection] = useState<'overview' | 'output'>('overview')

  return <div className="device-settings-page">
    <DeviceWorkspaceHeader deviceName="移动遥控器 CMIOT-A15" profileControls={null} onBackToDevices={onBackToDevices} />
    <div className="device-settings-layout">
      <nav className="settings-nav device-settings-nav" aria-label="移动遥控器 CMIOT-A15设置分类">
        <button type="button" aria-current={section === 'overview' ? 'page' : undefined} onClick={() => setSection('overview')}><Settings2 size={16} /><span>设备概览</span></button>
        <button type="button" aria-current={section === 'output' ? 'page' : undefined} onClick={() => setSection('output')}><Speaker size={16} /><span>输出选择</span></button>
      </nav>
      <section className="device-settings-panel" aria-labelledby="cmiot-a15-settings-title">
        <div className="device-settings-heading">
          <div><h2 id="cmiot-a15-settings-title">{section === 'overview' ? '设备概览' : '输出选择'}</h2><p>移动遥控器 · CMIOT-A15</p></div>
          <CircleHelp size={18} aria-label="设置说明" />
        </div>
        {section === 'output' ? <VoiceOutput idPrefix="cmiot-a15" /> : <div className="settings-form-fields">
          <div className="settings-form-row">
            <label className="settings-form-label" htmlFor="cmiot-a15-recording-mode">录音模式：</label>
            <div className="settings-form-control">
              <select id="cmiot-a15-recording-mode" value={cmiotA15RecordingMode} onChange={(event) => onCmiotA15RecordingModeChange(event.target.value === 'click' ? 'click' : 'hold')}>
                <option value="hold">长按录音</option>
                <option value="click">点击录音</option>
              </select>
            </div>
          </div>
        </div>}
      </section>
    </div>
  </div>
}
