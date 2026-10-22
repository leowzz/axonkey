import { useEffect, useState } from 'react'
import { invoke } from '@tauri-apps/api/core'
import { listen } from '@tauri-apps/api/event'
import { Layers3 } from 'lucide-react'
import { logError } from '../runtimeLogging'
import './ProfileSwitchOverlay.css'

type Notification = { revision: number; from: string; to: string }

export function ProfileSwitchOverlay() {
  const [notification, setNotification] = useState<Notification | null>(null)

  useEffect(() => {
    let active = true
    let unlisten: (() => void) | undefined
    const receive = (next: Notification | null) => {
      if (active && next) setNotification(current => !current || next.revision > current.revision ? next : current)
    }
    void listen<Notification>('axonkey-profile-switch-overlay', event => receive(event.payload))
      .then(async cleanup => {
        if (!active) { cleanup(); return }
        unlisten = cleanup
        receive(await invoke<Notification | null>('get_profile_switch_overlay'))
      })
      .catch(error => logError('Failed to receive profile switch overlay', error))
    return () => { active = false; unlisten?.() }
  }, [])

  useEffect(() => {
    if (!notification) return
    let active = true
    let timer: ReturnType<typeof setTimeout> | undefined
    const revision = notification.revision
    // Show only after React has committed the text, including on the first load.
    void invoke('reveal_profile_switch_overlay', { revision }).then(() => {
      if (active) timer = setTimeout(() => {
        void invoke('hide_profile_switch_overlay', { revision })
          .catch(error => logError('Failed to hide profile switch overlay', error))
      }, 2000)
    }).catch(error => logError('Failed to show profile switch overlay', error))
    return () => { active = false; clearTimeout(timer) }
  }, [notification])

  if (!notification) return null
  return <aside className="profile-switch-overlay" role="status" aria-live="polite">
    <Layers3 className="profile-switch-overlay-icon" size={24} aria-hidden="true" />
    <div className="profile-switch-overlay-content">
      <p>配置已切换</p>
      <div className="profile-switch-overlay-names">
        <span className="profile-switch-overlay-from">{notification.from}</span>
        <span aria-label="切换到">→</span>
        <strong>{notification.to}</strong>
      </div>
    </div>
  </aside>
}
