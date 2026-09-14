import { Check, ChevronRight, Mouse, Radio } from 'lucide-react'
import type { ReactNode } from 'react'
import { devices } from '../deviceModel'
import type { DeviceId } from '../deviceModel'

export type DeviceStatus = {
  title: string
  rows: { label: string; value: ReactNode; tone?: 'ready' | 'warning' }[]
  action?: { label: string; onClick: () => void }
}

export function DeviceSelector({ selectedId, onSelect }: { selectedId: DeviceId; onSelect: (id: DeviceId) => void }) {
  return <section className="device-selector-panel" aria-label="映射设备">
    <span className="device-rail-label">映射设备</span>
    <div role="group" aria-label="选择设备" className="device-options">
      {devices.map((device) => {
        const Icon = device.id === 'mouse' ? Mouse : Radio
        return <button type="button" key={device.id} aria-pressed={device.id === selectedId} onClick={() => onSelect(device.id)}><Icon size={17} /><strong>{device.name}</strong>{device.id === selectedId && <Check size={15} />}</button>
      })}
    </div>
  </section>
}

export function DeviceStatusCard({ status }: { status: DeviceStatus }) {
  return <section className="device-status-card" aria-label={status.title}>
    <h3>{status.title}</h3>
    <dl>{status.rows.map((row) => <div key={row.label}><dt>{row.label}</dt><dd className={row.tone ?? ''}>{row.value}</dd></div>)}</dl>
    {status.action && <button type="button" onClick={status.action.onClick}>{status.action.label}<ChevronRight size={13} /></button>}
  </section>
}
