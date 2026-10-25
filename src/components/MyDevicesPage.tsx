import { Battery, Check, Plus } from 'lucide-react'
import type { DeviceId } from '../deviceModel'
import { devices } from '../deviceModel'
import { BatteryIndicator } from './BatteryIndicator'
import './MyDevicesPage.css'

export type DeviceOverviewItem = {
  id: DeviceId
  name: string
  profileName: string
  profileCount: number
  status: {
    label: string
    tone: 'ready' | 'warning' | 'neutral'
  }
  power: { kind: 'battery'; level: number | null } | { kind: 'unavailable' }
  enabled: boolean
}

type MyDevicesPageProps = {
  devices: readonly DeviceOverviewItem[]
  onSelect: (deviceId: DeviceId) => void
  onIntegrate: () => void
}

function DeviceArtwork({ deviceId }: { deviceId: DeviceId }) {
  const device = devices.find((item) => item.id === deviceId)
  if (device?.remoteView) return <img src={device.remoteView.artworkUrl} alt="" width={54} height={132} />

  return <img src="/mouse-device.svg" alt="" width={160} height={200} />
}

export function MyDevicesPage({ devices, onSelect, onIntegrate }: MyDevicesPageProps) {
  return <section className="my-devices-page" aria-labelledby="my-devices-title">
    <header className="my-devices-heading">
      <h1 id="my-devices-title">设备</h1>
      <button className="my-devices-integrate" type="button" onClick={onIntegrate}>
        <Plus size={16} aria-hidden="true" />集成设备
      </button>
    </header>

    <h2 className="my-devices-section-title">我的设备 <span>{devices.length}</span></h2>
    <div className="my-devices-grid">
      {devices.map((device) => {
        const prefix = `my-device-${device.id}`

        return <button
          key={device.id}
          type="button"
          className="my-devices-card"
          aria-labelledby={`${prefix}-name`}
          aria-describedby={`${prefix}-status ${prefix}-power ${prefix}-profile ${prefix}-mapping`}
          onClick={() => onSelect(device.id)}
        >
          <span className="my-devices-card-main">
            <span className="my-devices-artwork" aria-hidden="true"><DeviceArtwork deviceId={device.id} /></span>
            <span className="my-devices-identity">
              <strong id={`${prefix}-name`}>{device.name}</strong>
              <span id={`${prefix}-mapping`} className="my-devices-count">
                {device.profileCount} 份配置文件{!device.enabled && <span className="my-devices-paused"> · 映射已暂停</span>}
              </span>
            </span>
          </span>
          <span className="my-devices-summary">
            <span className="my-devices-telemetry">
              <span id={`${prefix}-status`} className={`my-devices-status is-${device.status.tone}`}>
                <span className="my-devices-status-dot" aria-hidden="true" />{device.status.label}
              </span>
              <span id={`${prefix}-power`} className="my-devices-power">
                {device.power.kind === 'battery' ? <BatteryIndicator level={device.power.level} /> : <>
                  <Battery size={14} aria-hidden="true" /><span>未提供电量</span>
                </>}
              </span>
            </span>
            <span id={`${prefix}-profile`} className={`my-devices-profile${device.profileName ? '' : ' is-empty'}`}>
              <span>当前配置</span>
              <strong>{device.profileName || '尚未配置'}</strong>
            </span>
          </span>
        </button>
      })}
    </div>
    <footer className="my-devices-footer"><Check size={13} aria-hidden="true" />配置保存在本机</footer>
  </section>
}
