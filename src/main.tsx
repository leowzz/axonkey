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

installRuntimeLogging()
logInfo('Frontend runtime initialized')

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <AppErrorBoundary><App /></AppErrorBoundary>
  </StrictMode>,
)
