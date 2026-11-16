import { Mic, Settings } from 'lucide-react'
import type { ReactNode } from 'react'

export type DeviceStatus = {
  title: string
  rows: { label: string; value: ReactNode; tone?: 'ready' | 'warning' }[]
  action?: { label: string; title?: string; onClick: () => void }
  toggle?: { checked: boolean; onChange: () => void }
  onOpenSettings?: () => void
  recording?: boolean
}

export function DeviceRecordingStatus({
  recording,
  onToggle,
  disabled = false,
  idleLabel = '未录音',
  title,
  amplitudes,
  levelTone,
}: {
  recording: boolean
  onToggle?: () => void
  disabled?: boolean
  idleLabel?: string
  title?: string
  amplitudes?: readonly number[]
  levelTone?: 'silent' | 'low' | 'good' | 'hot' | 'clipping'
}) {
  const toneClass = recording && levelTone ? ` tone-${levelTone}` : ''
  const content = (
    <span
      className={`device-recording-status${recording ? ' is-recording' : ''}${toneClass}`}
      role="status"
      aria-live="polite"
      aria-atomic="true"
      title={!onToggle ? title : undefined}
    >
      {amplitudes ? (
        <span className="device-recording-bars" aria-hidden="true">
          {amplitudes.map((level, index) => (
            <i key={index} style={{ height: `${(3 + Math.max(0, Math.min(1, level)) * 12).toFixed(1)}px` }} />
          ))}
        </span>
      ) : (
        <Mic size={18} aria-hidden="true" />
      )}
      <span>{recording ? '正在录音' : idleLabel}</span>
    </span>
  )
  return onToggle ? (
    <button
      type="button"
      className="device-recording-control"
      aria-label={recording ? '停止录音' : '开始录音'}
      aria-pressed={recording}
      title={title ?? (recording ? '点击停止录音' : '点击开始录音')}
      disabled={disabled}
      onClick={onToggle}
    >
      {content}
    </button>
  ) : (
    content
  )
}

export function DeviceStatusCard({ status }: { status: DeviceStatus }) {
  return (
    <section className="device-status-card" aria-label={status.title}>
      <h3>{status.title}</h3>
      {status.recording !== undefined && <DeviceRecordingStatus recording={status.recording} />}
      <dl>
        {status.rows.map((row, index) => (
          <div key={row.label} className={status.toggle && index === 0 ? 'device-status-toggle-row' : undefined}>
            <dt>{row.label}</dt>
            <dd className={row.tone ?? ''}>{row.value}</dd>
            {status.toggle && index === 0 && (
              <button
                type="button"
                role="switch"
                className={`switch device-status-switch ${status.toggle.checked ? 'on' : ''}`}
                aria-checked={status.toggle.checked}
                aria-label="启用鼠标映射"
                onClick={status.toggle.onChange}
              >
                <span />
              </button>
            )}
          </div>
        ))}
      </dl>
      {status.onOpenSettings && (
        <button
          type="button"
          className="device-settings-button"
          aria-label="鼠标映射设置"
          title="鼠标映射设置"
          onClick={status.onOpenSettings}
        >
          <Settings size={16} />
        </button>
      )}
      {status.action && (
        <button type="button" title={status.action.title} onClick={status.action.onClick}>
          {status.action.label}
        </button>
      )}
    </section>
  )
}
