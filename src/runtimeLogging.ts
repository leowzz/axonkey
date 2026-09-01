import { error as writeError, info as writeInfo, warn as writeWarn } from '@tauri-apps/plugin-log'

type LogWriter = (message: string) => Promise<void>

function isNativeRuntime() {
  return typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window
}

function stringifyError(value: unknown) {
  if (value instanceof Error) {
    return `${value.name}: ${value.message}${value.stack ? `\n${value.stack}` : ''}`
  }
  if (typeof value === 'string') return value
  try {
    return JSON.stringify(value)
  } catch {
    return String(value)
  }
}

function write(writer: LogWriter, message: string) {
  if (!isNativeRuntime()) return
  void writer(message).catch(() => undefined)
}

export function logInfo(message: string) {
  write(writeInfo, message)
}

export function logWarn(message: string) {
  write(writeWarn, message)
}

export function logError(message: string, details?: unknown) {
  const suffix = details === undefined ? '' : `: ${stringifyError(details)}`
  write(writeError, `${message}${suffix}`)
}

/** Captures errors that otherwise bypass the React/Tauri command error paths. */
export function installRuntimeLogging() {
  if (typeof window === 'undefined') return () => undefined

  const handleError = (event: ErrorEvent) => {
    const source = event.filename ? ` (${event.filename}:${event.lineno}:${event.colno})` : ''
    logError(`Unhandled frontend error${source}`, event.error ?? event.message)
  }
  const handleRejection = (event: PromiseRejectionEvent) => {
    logError('Unhandled frontend promise rejection', event.reason)
  }

  window.addEventListener('error', handleError)
  window.addEventListener('unhandledrejection', handleRejection)
  return () => {
    window.removeEventListener('error', handleError)
    window.removeEventListener('unhandledrejection', handleRejection)
  }
}
