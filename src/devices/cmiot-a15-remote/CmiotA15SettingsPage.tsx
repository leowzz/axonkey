import { Bluetooth, CircleHelp, Keyboard, Settings2 } from 'lucide-react'
import { useState } from 'react'
import { DeviceWorkspaceHeader } from '../shared/DeviceWorkspaceHeader'

type CmiotA15SettingsSection = 'overview' | 'keys' | 'connection'

type CmiotA15SettingsPageProps = {
  onBackToDevices: () => void
}

export function CmiotA15SettingsPage({ onBackToDevices }: CmiotA15SettingsPageProps) {
  const [section, setSection] = useState<CmiotA15SettingsSection>('overview')
  const sections = [
    { id: 'overview' as const, label: '设备概览', icon: <Settings2 size={16} /> },
    { id: 'keys' as const, label: '按键输入', icon: <Keyboard size={16} /> },
    { id: 'connection' as const, label: '蓝牙连接', icon: <Bluetooth size={16} /> },
  ]
  const currentSection = sections.find((item) => item.id === section) ?? sections[0]

  return <div className="device-settings-page">
    <DeviceWorkspaceHeader deviceName="移动遥控器 CMIOT-A15" profileControls={null} onBackToDevices={onBackToDevices} />
    <div className="device-settings-layout">
      <nav className="settings-nav device-settings-nav" aria-label="CMIOT-A15 设置分类">
        {sections.map((item) => <button key={item.id} type="button" aria-current={section === item.id ? 'page' : undefined} onClick={() => setSection(item.id)}>{item.icon}<span>{item.label}</span></button>)}
      </nav>
      <section className="device-settings-panel" aria-labelledby="cmiot-a15-settings-title">
        <div className="device-settings-heading">
          <div><h2 id="cmiot-a15-settings-title">{currentSection.label}</h2><p>移动遥控器 · CMIOT-A15</p></div>
          <CircleHelp size={18} aria-label="设置说明" />
        </div>
        <div className="device-settings-empty" role="status">
          <Settings2 size={28} aria-hidden="true" /><strong>暂未配置内容</strong><span>CMIOT-A15 的{currentSection.label}将在这里提供。</span>
        </div>
      </section>
    </div>
  </div>
}
