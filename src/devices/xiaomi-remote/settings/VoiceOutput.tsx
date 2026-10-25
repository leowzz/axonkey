import { useEffect, useState } from 'react'
import { invoke, isTauri } from '@tauri-apps/api/core'

export function VoiceOutput() {
  const [outputs, setOutputs] = useState<string[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')

  useEffect(() => {
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
  }, [])

  return <div className="xiaomi-output-fields settings-form-fields">
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
  </div>
}
