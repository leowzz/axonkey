import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import App from './App'
import { bootstrapAppStorage } from './appStorage'
import { AppErrorBoundary } from './components/AppErrorBoundary'
import { ProfileSwitchOverlay } from './components/ProfileSwitchOverlay'
import { QuickOverlay } from './components/QuickOverlay'
import './designSystem.css'
import './styles.css'
import { installRuntimeLogging, logInfo } from './runtimeLogging'
import { initializeTencentRum } from './telemetry'

initializeTencentRum(import.meta.env.TENCENT_RUM_ID)

// The remote voice button sends F5; cancel refresh without blocking key handlers.
const preventF5Refresh = (event: KeyboardEvent) => {
  if (event.key === 'F5' || event.code === 'F5') event.preventDefault()
}
window.addEventListener('keydown', preventF5Refresh, true)

window.addEventListener('contextmenu', event => {
  const target = event.target
  if (!(target instanceof Element)) return
  const field = target.closest('input, textarea, [contenteditable], a[href]')
  if (
    field instanceof HTMLTextAreaElement ||
    (field instanceof HTMLInputElement &&
      ['text', 'search', 'url', 'tel', 'email', 'password', 'number'].includes(field.type)) ||
    (field instanceof HTMLElement && field.isContentEditable) ||
    field instanceof HTMLAnchorElement
  )
    return
  event.preventDefault()
})

installRuntimeLogging()
logInfo('Frontend runtime initialized')

const overlayView = new URLSearchParams(window.location.search).get('view')
const isProfileSwitchOverlay = overlayView === 'profile-switch-overlay'
const isQuickOverlay = overlayView === 'quick-overlay'
if (isProfileSwitchOverlay) document.documentElement.classList.add('profile-switch-overlay-window')
if (isQuickOverlay) document.documentElement.classList.add('quick-overlay-window')

async function mount() {
  if (!isProfileSwitchOverlay && !isQuickOverlay) {
    await bootstrapAppStorage()
  }
  const root = createRoot(document.getElementById('root')!)
  root.render(
    <StrictMode>
      <AppErrorBoundary>
        {isProfileSwitchOverlay ? <ProfileSwitchOverlay /> : isQuickOverlay ? <QuickOverlay /> : <App />}
      </AppErrorBoundary>
    </StrictMode>,
  )
}

void mount()
