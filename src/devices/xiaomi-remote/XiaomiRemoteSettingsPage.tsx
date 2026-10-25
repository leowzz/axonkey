import { CircleHelp, Settings2, Speaker } from 'lucide-react'
import { useState } from 'react'
import { VoiceOutput } from './settings/VoiceOutput'
import { DeviceWorkspaceHeader } from '../shared/DeviceWorkspaceHeader'

type XiaomiRemoteSettingsPageProps = {
  onBackToDevices: () => void
}

export function XiaomiRemoteSettingsPage({ onBackToDevices }: XiaomiRemoteSettingsPageProps) {
  const [section, setSection] = useState<'overview' | 'output'>('overview')

  return <div className="device-settings-page">
    <DeviceWorkspaceHeader deviceName="小米遥控器" profileControls={null} onBackToDevices={onBackToDevices} />
    <div className="device-settings-layout">
      <nav className="settings-nav device-settings-nav" aria-label="小米遥控器设置分类">
        <button type="button" aria-current={section === 'overview' ? 'page' : undefined} onClick={() => setSection('overview')}><Settings2 size={16} /><span>设备概览</span></button>
        <button type="button" aria-current={section === 'output' ? 'page' : undefined} onClick={() => setSection('output')}><Speaker size={16} /><span>输出选择</span></button>
      </nav>
      <section className="device-settings-panel" aria-labelledby="xiaomi-settings-title">
        <div className="device-settings-heading">
          <div><h2 id="xiaomi-settings-title">{section === 'overview' ? '设备概览' : '输出选择'}</h2><p>小米遥控器 · RC003</p></div>
          <CircleHelp size={18} aria-label="设置说明" />
        </div>
        {section === 'output' ? <VoiceOutput /> : <div className="device-settings-empty" role="status">
          <Settings2 size={28} aria-hidden="true" /><strong>暂未配置内容</strong><span>小米遥控器的设备概览将在这里提供。</span>
        </div>}
      </section>
    </div>
  </div>
}
