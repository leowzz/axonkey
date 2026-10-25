import { CircleHelp, Settings2, Speaker } from 'lucide-react'
import { useEffect, useState } from 'react'
import { invoke, isTauri } from '@tauri-apps/api/core'
import { DeviceWorkspaceHeader } from '../../components/DeviceWorkspaceHeader'

type XiaomiRemoteSettingsPageProps = {
  onBackToDevices: () => void
}

export function XiaomiRemoteSettingsPage({ onBackToDevices }: XiaomiRemoteSettingsPageProps) {
  const [section, setSection] = useState<'overview' | 'output'>('overview')
  const [outputs, setOutputs] = useState<string[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')

  useEffect(() => {
    if (section !== 'output') return
    let active = true
    setOutputs([])
    setError('')
    if (!isTauri()) {
      setError('请在桌面应用中查看语音输出设备。')
      return
    }
    setLoading(true)
    void invoke<string[]>('list_voice_output_devices').then((devices) => {
      if (active) setOutputs(devices)
    }).catch((cause) => {
      if (active) setError(String(cause))
    }).finally(() => {
      if (active) setLoading(false)
    })
    return () => { active = false }
  }, [section])

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
        {section === 'output' ? <div className="xiaomi-output-fields settings-form-fields">
          <div className="settings-form-row">
            <label className="settings-form-label" htmlFor="xiaomi-voice-output">选择语音输出设备：</label>
            <div className="settings-form-control">
              <select id="xiaomi-voice-output" className="xiaomi-output-select" defaultValue="" disabled={loading || !!error || outputs.length === 0} aria-busy={loading}>
                <option value="" disabled>{loading ? '正在获取设备…' : error ? '无法获取设备' : outputs.length === 0 ? '未发现音频输出设备' : '请选择设备'}</option>
                {outputs.map((name, index) => <option key={index} value={String(index)}>{name}</option>)}
              </select>
              {error && <span className="settings-form-error" role="alert">{error}</span>}
            </div>
          </div>
        </div> : <div className="device-settings-empty" role="status">
          <Settings2 size={28} aria-hidden="true" /><strong>暂未配置内容</strong><span>小米遥控器的设备概览将在这里提供。</span>
        </div>}
      </section>
    </div>
  </div>
}
