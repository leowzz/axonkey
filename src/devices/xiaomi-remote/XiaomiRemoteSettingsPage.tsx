import { Bluetooth, CircleHelp, Radio, Settings2 } from 'lucide-react'
import { useState } from 'react'
import { DeviceWorkspaceHeader } from '../../components/DeviceWorkspaceHeader'

type XiaomiSettingsSection = 'overview' | 'remote' | 'connection'

type XiaomiRemoteSettingsPageProps = {
  onBackToDevices: () => void
}

export function XiaomiRemoteSettingsPage({ onBackToDevices }: XiaomiRemoteSettingsPageProps) {
  const [section, setSection] = useState<XiaomiSettingsSection>('overview')
  const sections = [
    { id: 'overview' as const, label: '设备概览', icon: <Settings2 size={16} /> },
    { id: 'remote' as const, label: '遥控器按键', icon: <Radio size={16} /> },
    { id: 'connection' as const, label: '蓝牙连接', icon: <Bluetooth size={16} /> },
  ]
  const currentSection = sections.find((item) => item.id === section) ?? sections[0]

  return <div className="device-settings-page">
    <DeviceWorkspaceHeader deviceName="小米遥控器" profileControls={null} onBackToDevices={onBackToDevices} />
    <div className="device-settings-layout">
      <nav className="settings-nav device-settings-nav" aria-label="小米遥控器设置分类">
        {sections.map((item) => <button key={item.id} type="button" aria-current={section === item.id ? 'page' : undefined} onClick={() => setSection(item.id)}>{item.icon}<span>{item.label}</span></button>)}
      </nav>
      <section className="device-settings-panel" aria-labelledby="xiaomi-settings-title">
        <div className="device-settings-heading">
          <div><h2 id="xiaomi-settings-title">{currentSection.label}</h2><p>小米遥控器 · RC003</p></div>
          <CircleHelp size={18} aria-label="设置说明" />
        </div>
        <div className="device-settings-empty" role="status">
          <Settings2 size={28} aria-hidden="true" /><strong>暂未配置内容</strong><span>小米遥控器的{currentSection.label}将在这里提供。</span>
        </div>
      </section>
    </div>
  </div>
}
