import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import App from './App'
import './styles.css'
import { installRuntimeLogging, logInfo } from './runtimeLogging'

installRuntimeLogging()
logInfo('Frontend runtime initialized')

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
