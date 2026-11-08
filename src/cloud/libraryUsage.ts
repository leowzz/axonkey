import { useEffect } from 'react'
import { invoke } from '@tauri-apps/api/core'
import type { Platform } from '../appTypes.ts'
import { logCloud } from './cloudLogging.ts'
import type { RelayClient } from './relayClient.ts'

export type LibraryUsageBatch = {
  device_id: string
  batch_id: string
  items: { item_id: string; addition_count: number; execution_count: number }[]
}
export type LibraryUsagePort = {
  take: () => Promise<LibraryUsageBatch | null>
  ack: (batchId: string) => Promise<void>
}

export function recordLibraryAdditions(items: string[]): void {
  if (typeof window === 'undefined' || !('__TAURI_INTERNALS__' in window)) return
  if (!items.length) return
  for (let offset = 0; offset < items.length; offset += 100)
    void invoke('axonkey_record_library_additions', { itemIds: items.slice(offset, offset + 100) }).catch(() => {
      logCloud('usage.additions.failed', {}, 'error')
    })
}

export function createLibraryUsageReporter(
  client: RelayClient,
  platform: Platform,
  port: LibraryUsagePort,
  timeoutMs = 3000,
) {
  let busy = false
  let lastWarning = 0
  return {
    async flush() {
      if (busy || (platform !== 'windows' && platform !== 'macos')) return
      busy = true
      let timer: ReturnType<typeof setTimeout> | undefined
      try {
        const batch = await port.take()
        if (!batch) return
        // The native queue keeps this exact batch until acknowledgement.
        await Promise.race([
          client.request(
            'POST',
            '/v2/behavior-library/usage',
            { app_id: 'axonkey', platform, device_id: batch.device_id, batch_id: batch.batch_id, items: batch.items },
            false,
          ),
          new Promise<never>((_, reject) => {
            timer = setTimeout(() => reject(new Error('usage timeout')), timeoutMs)
          }),
        ])
        await port.ack(batch.batch_id)
      } catch {
        if (Date.now() - lastWarning >= 300_000) {
          lastWarning = Date.now()
          logCloud('usage.flush.deferred')
        }
      } finally {
        if (timer !== undefined) clearTimeout(timer)
        busy = false
      }
    },
  }
}

export function useLibraryUsage(client: RelayClient, platform: Platform, native: boolean) {
  useEffect(() => {
    if (!native) return
    const reporter = createLibraryUsageReporter(client, platform, {
      take: () => invoke<LibraryUsageBatch | null>('axonkey_take_library_usage'),
      ack: batchId => invoke<void>('axonkey_ack_library_usage', { batchId }),
    })
    void reporter.flush()
    const timer = window.setInterval(() => void reporter.flush(), 15_000)
    return () => window.clearInterval(timer)
  }, [client, platform, native])
}
