import { lazy, StrictMode, Suspense } from 'react'
import { createRoot } from 'react-dom/client'
import App from './App'
import { AppErrorBoundary } from './components/AppErrorBoundary'
import { ProfileSwitchOverlay } from './components/ProfileSwitchOverlay'
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

const root = createRoot(document.getElementById('root')!)
const BottomBarPrototype = import.meta.env.DEV ? lazy(() => import('./components/prototypes/BottomBarPrototype')) : null
const isBottomBarPrototype =
  import.meta.env.DEV && new URLSearchParams(window.location.search).get('view') === 'bottom-bar-prototype'
const isProfileSwitchOverlay = new URLSearchParams(window.location.search).get('view') === 'profile-switch-overlay'
if (isProfileSwitchOverlay) document.documentElement.classList.add('profile-switch-overlay-window')
root.render(
  <StrictMode>
    <AppErrorBoundary>
      {isBottomBarPrototype && BottomBarPrototype ? (
        <Suspense fallback={null}>
          <BottomBarPrototype />
        </Suspense>
      ) : isProfileSwitchOverlay ? (
        <ProfileSwitchOverlay />
      ) : (
        <App />
      )}
    </AppErrorBoundary>
  </StrictMode>,
)
