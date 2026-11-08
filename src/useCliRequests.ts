import { useEffect, useRef } from 'react'
import { invoke } from '@tauri-apps/api/core'
import type { CliRequest } from './cliContract'
import { logError } from './runtimeLogging'

export function useCliRequests(enabled: boolean, processRequest: (request: CliRequest) => Promise<void>) {
  const handler = useRef(processRequest)
  handler.current = processRequest
  useEffect(() => {
    if (!enabled) return
    let active = true
    let timer: ReturnType<typeof setTimeout>
    const poll = async () => {
      try {
        const requests = await invoke<CliRequest[]>('cli_poll_requests')
        // Polling claims the entire batch; finish it even when the callback changes.
        for (const request of requests) await handler.current(request)
      } catch (error) {
        logError('Failed to poll CLI requests', error)
      }
      if (active) timer = setTimeout(() => void poll(), 120)
    }
    void poll()
    return () => {
      active = false
      clearTimeout(timer)
    }
  }, [enabled])
}
