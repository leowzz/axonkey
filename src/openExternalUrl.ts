import { invoke } from '@tauri-apps/api/core'
import { logError } from './runtimeLogging.ts'

const maxExternalUrlLength = 2048

export function normalizeExternalHttpUrl(rawUrl: unknown): string | null {
  if (typeof rawUrl !== 'string') return null
  const trimmed = rawUrl.trim()
  if (!trimmed || trimmed.length > maxExternalUrlLength || /[\s\u0000-\u001f\u007f]/.test(trimmed)) return null
  let parsed: URL
  try {
    parsed = new URL(trimmed)
  } catch {
    return null
  }
  if ((parsed.protocol !== 'http:' && parsed.protocol !== 'https:') || !parsed.hostname) return null
  if (parsed.username || parsed.password) return null
  return parsed.toString()
}

export function externalUrlHostname(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./i, '')
  } catch {
    return ''
  }
}

export async function openExternalUrl(
  rawUrl: string,
  options?: {
    native?: boolean
    event?: { preventDefault?: () => void; stopPropagation?: () => void }
    invokeCommand?: typeof invoke
    openWindow?: (url: string, target: string, features: string) => unknown
  },
): Promise<boolean> {
  options?.event?.preventDefault?.()
  options?.event?.stopPropagation?.()
  const url = normalizeExternalHttpUrl(rawUrl)
  if (!url) return false
  const useNative = options?.native ?? (typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window)
  if (useNative) {
    try {
      await (options?.invokeCommand ?? invoke)('open_external_url', { url })
      return true
    } catch (error) {
      logError('Failed to open external URL in the default browser', error)
      return false
    }
  }
  const opener = options?.openWindow ?? (typeof window !== 'undefined' ? window.open?.bind(window) : undefined)
  if (!opener) return false
  opener(url, '_blank', 'noopener,noreferrer')
  return true
}
