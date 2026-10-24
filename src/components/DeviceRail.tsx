import { Settings } from 'lucide-react'
import type { ReactNode } from 'react'

export type DeviceStatus = {
  title: string
  rows: { label: string; value: ReactNode; tone?: 'ready' | 'warning' }[]
  action?: { label: string; title?: string; onClick: () => void }
  toggle?: { checked: boolean; onChange: () => void }
  onOpenSettings?: () => void
}

export function DeviceStatusCard({ status }: { status: DeviceStatus }) {
  return <section className="device-status-card" aria-label={status.title}>
    <h3>{status.title}</h3>
    <dl>{status.rows.map((row, index) => <div key={row.label} className={status.toggle && index === 0 ? 'device-status-toggle-row' : undefined}><dt>{row.label}</dt><dd className={row.tone ?? ''}>{row.value}</dd>{status.toggle && index === 0 && <button type="button" role="switch" className={`switch device-status-switch ${status.toggle.checked ? 'on' : ''}`} aria-checked={status.toggle.checked} aria-label="启用鼠标映射" onClick={status.toggle.onChange}><span /></button>}</div>)}</dl>
    {status.onOpenSettings && <button type="button" className="device-settings-button" aria-label="鼠标映射设置" title="鼠标映射设置" onClick={status.onOpenSettings}><Settings size={16} /></button>}
    {status.action && <button type="button" title={status.action.title} onClick={status.action.onClick}>{status.action.label}</button>}
  </section>
}
