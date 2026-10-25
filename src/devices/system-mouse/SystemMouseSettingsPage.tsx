import { CircleHelp, Mouse, ScrollText, Settings2 } from 'lucide-react'
import { useState } from 'react'
import { DeviceWorkspaceHeader } from '../../components/DeviceWorkspaceHeader'

type SystemMouseSettingsSection = 'overview' | 'mouse' | 'scroll'

type SystemMouseSettingsPageProps = {
  onBackToDevices: () => void
}

export function SystemMouseSettingsPage({ onBackToDevices }: SystemMouseSettingsPageProps) {
  const [section, setSection] = useState<SystemMouseSettingsSection>('overview')
  const sections = [
    { id: 'overview' as const, label: '设备概览', icon: <Settings2 size={16} /> },
    { id: 'mouse' as const, label: '鼠标输入', icon: <Mouse size={16} /> },
    { id: 'scroll' as const, label: '滚轮行为', icon: <ScrollText size={16} /> },
  ]
  const currentSection = sections.find((item) => item.id === section) ?? sections[0]

  return <div className="device-settings-page">
    <DeviceWorkspaceHeader deviceName="系统鼠标" profileControls={null} onBackToDevices={onBackToDevices} />
    <div className="device-settings-layout">
      <nav className="settings-nav device-settings-nav" aria-label="系统鼠标设置分类">
        {sections.map((item) => <button key={item.id} type="button" aria-current={section === item.id ? 'page' : undefined} onClick={() => setSection(item.id)}>{item.icon}<span>{item.label}</span></button>)}
      </nav>
      <section className="device-settings-panel" aria-labelledby="system-mouse-settings-title">
        <div className="device-settings-heading">
          <div><h2 id="system-mouse-settings-title">{currentSection.label}</h2><p>系统鼠标 · SYSTEM-MOUSE</p></div>
          <CircleHelp size={18} aria-label="设置说明" />
        </div>
        <div className="device-settings-empty" role="status">
          <Settings2 size={28} aria-hidden="true" /><strong>暂未配置内容</strong><span>系统鼠标的{currentSection.label}将在这里提供。</span>
        </div>
      </section>
    </div>
  </div>
}
