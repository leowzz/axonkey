import { useEffect, useState } from 'react'
import { invoke, isTauri } from '@tauri-apps/api/core'

export function VoiceOutput({
  idPrefix = 'xiaomi',
  value,
  onChange,
  onOpenAudioDriver,
}: {
  idPrefix?: string
  value?: string
  onChange?: (value: string) => void
  onOpenAudioDriver: () => void
}) {
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
    void invoke<string[]>('list_voice_output_devices')
      .then(devices => {
        if (active) setOutputs(devices)
      })
      .catch(cause => {
        if (active) setError(String(cause))
      })
      .finally(() => {
        if (active) setLoading(false)
      })
    return () => {
      active = false
    }
  }, [])

  const options = value && !outputs.includes(value) ? [value, ...outputs] : outputs
  const selectProps = value === undefined ? { defaultValue: '' } : { value: value ?? '' }
  return (
    <div className="xiaomi-output-fields settings-form-fields">
      <div className="settings-form-row">
        <label className="settings-form-label" htmlFor={`${idPrefix}-voice-output`}>
          选择语音输出设备：
        </label>
        <div className="settings-form-control">
          <select
            {...selectProps}
            id={`${idPrefix}-voice-output`}
            className="xiaomi-output-select"
            onChange={event => onChange?.(event.target.value)}
            disabled={loading || !!error || outputs.length === 0}
            aria-busy={loading}
          >
            <option value="" disabled>
              {loading
                ? '正在获取设备…'
                : error
                  ? '无法获取设备'
                  : outputs.length === 0
                    ? '未发现音频输出设备'
                    : '请选择设备'}
            </option>
            {options.map(name => (
              <option key={name} value={name}>
                {name}
              </option>
            ))}
          </select>
          {error && (
            <span className="settings-form-error" role="alert">
              {error}
            </span>
          )}
        </div>
      </div>
      <div className="settings-form-row">
        <span className="settings-form-label">虚拟麦克风：</span>
        <div className="settings-form-control">
          <button type="button" className="dialog-secondary" onClick={onOpenAudioDriver}>
            管理驱动
          </button>
        </div>
      </div>
    </div>
  )
}
