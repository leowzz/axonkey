import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import App from './App'
import { AppErrorBoundary } from './components/AppErrorBoundary'
import './styles.css'
import { installRuntimeLogging, logInfo } from './runtimeLogging'

// The remote voice button sends F5; cancel refresh without blocking key handlers.
const preventF5Refresh = (event: KeyboardEvent) => {
  if (event.key === 'F5' || event.code === 'F5') event.preventDefault()
}
window.addEventListener('keydown', preventF5Refresh, true)

window.addEventListener('contextmenu', (event) => {
  const target = event.target
  if (!(target instanceof Element)) return
  const field = target.closest('input, textarea, [contenteditable], a[href]')
  if (field instanceof HTMLTextAreaElement
    || (field instanceof HTMLInputElement && ['text', 'search', 'url', 'tel', 'email', 'password', 'number'].includes(field.type))
    || (field instanceof HTMLElement && field.isContentEditable)
    || field instanceof HTMLAnchorElement) return
  event.preventDefault()
})

installRuntimeLogging()
logInfo('Frontend runtime initialized')

const root = createRoot(document.getElementById('root')!)
root.render(
  <StrictMode>
    <AppErrorBoundary><App /></AppErrorBoundary>
  </StrictMode>,
)
