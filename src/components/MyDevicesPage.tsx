import { ChevronRight, Layers3, Plus } from 'lucide-react'
import type { DeviceId } from '../deviceModel'
import './MyDevicesPage.css'

export type DeviceOverviewItem = {
  id: DeviceId
  name: string
  model: string
  description: string
  profileName: string
  profileCount: number
  status: {
    label: string
    tone: 'ready' | 'warning' | 'neutral'
  }
  enabled: boolean
}

type MyDevicesPageProps = {
  devices: readonly DeviceOverviewItem[]
  onSelect: (deviceId: DeviceId) => void
  onIntegrate: () => void
}

function DeviceArtwork({ deviceId }: { deviceId: DeviceId }) {
  if (deviceId === 'rc003') {
    return <img src="/rc003-remote-keymap.svg" alt="" width={54} height={132} />
  }

  return <svg className="my-devices-mouse-art" viewBox="0 0 100 132" fill="none" aria-hidden="true">
    <path className="my-devices-mouse-shell" d="M50 8C28 8 14 23 14 46v39c0 24 13 39 36 39s36-15 36-39V46C86 23 72 8 50 8Z" />
    <path className="my-devices-mouse-seam" d="M50 9v45M15 54h70" />
    <rect className="my-devices-mouse-wheel" x="45" y="26" width="10" height="20" rx="5" />
    <path className="my-devices-mouse-side" d="M21 62v12m0 7v12" />
  </svg>
}

export function MyDevicesPage({ devices, onSelect, onIntegrate }: MyDevicesPageProps) {
  return <section className="my-devices-page" aria-labelledby="my-devices-title">
    <header className="my-devices-heading">
      <div>
        <h1 id="my-devices-title">我的设备 <span>{devices.length}</span></h1>
        <p>选择设备，编辑它的映射与配置文件。</p>
      </div>
      <button className="my-devices-integrate" type="button" onClick={onIntegrate}>
        <Plus size={16} aria-hidden="true" />集成设备
      </button>
    </header>

    <div className="my-devices-grid">
      {devices.map((device) => {
        const prefix = `my-device-${device.id}`

        return <button
          key={device.id}
          type="button"
          className="my-devices-card"
          aria-labelledby={`${prefix}-name ${prefix}-edit`}
          aria-describedby={`${prefix}-status ${prefix}-description ${prefix}-profile ${prefix}-mapping`}
          onClick={() => onSelect(device.id)}
        >
          <span className="my-devices-card-top">
            <span className="my-devices-category">{device.id === 'mouse' ? '系统输入' : '遥控器'}</span>
            <span id={`${prefix}-status`} className={`my-devices-status is-${device.status.tone}`}>
              <span className="my-devices-status-dot" aria-hidden="true" />{device.status.label}
            </span>
          </span>
          <span className="my-devices-card-main">
            <span className="my-devices-artwork" aria-hidden="true"><DeviceArtwork deviceId={device.id} /></span>
            <span className="my-devices-identity">
              <strong id={`${prefix}-name`}>{device.name}</strong>
              <span>{device.model}</span>
              <small id={`${prefix}-description`}>{device.description}</small>
            </span>
          </span>
          <span id={`${prefix}-profile`} className="my-devices-profile">
            <span><Layers3 size={14} aria-hidden="true" />当前配置</span>
            <strong title={device.profileName}>{device.profileName}</strong>
          </span>
          <span className="my-devices-card-footer">
            <span id={`${prefix}-mapping`}>
              {device.profileCount} 份配置文件{!device.enabled && <span className="my-devices-paused"> · 映射已暂停</span>}
            </span>
            <strong id={`${prefix}-edit`}>编辑设备<ChevronRight size={14} aria-hidden="true" /></strong>
          </span>
        </button>
      })}
    </div>
  </section>
}
