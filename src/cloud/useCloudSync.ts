import { useEffect, useRef, useState } from 'react'
import { invoke } from '@tauri-apps/api/core'
import { RelayClient, RelayError, relayFailureDetails } from './relayClient'
import type { RelayResponse, RelaySession, RelayTransport } from './relayClient'
import { fingerprint, readCloud, SyncConflict, uploadCloud } from './cloudSync'
import type { CloudSnapshot, CloudState, SyncMemory } from './cloudSync'
import { logCloud } from './cloudLogging'
import appPackage from '../../package.json'

const storageKey = 'axonkey.relay.v1'
type CloudPreferences = {
  session: RelaySession | null
  autoSync: boolean
  accounts: Record<string, { memory: SyncMemory; lastSync: string | null; fingerprint: string | null }>
}
const defaults = (): CloudPreferences => ({ session: null, autoSync: false, accounts: {} })

export function useCloudSync(options: {
  native: boolean
  ready: boolean
  snapshot: () => CloudSnapshot
  restore: (cloud: CloudState) => Promise<void>
}) {
  const latest = useRef(options)
  latest.current = options
  const [preferences, setPreferences] = useState(readPreferences)
  const current = useRef(preferences)
  const [busy, setBusy] = useState(false)
  const [accountLoaded, setAccountLoaded] = useState(!options.native)
  const working = useRef(false)
  const [error, setError] = useState('')
  const [message, setMessage] = useState('')
  const [conflict, setConflict] = useState<'initial' | 'changed' | null>(null)
  const [pendingRestore, setPendingRestore] = useState<CloudState | null>(null)
  const retryAt = useRef(0)
  const update = (value: CloudPreferences) => {
    const { session: _session, ...stored } = value
    localStorage.setItem(storageKey, JSON.stringify(stored))
    current.current = value
    setPreferences(value)
  }
  const [client] = useState(() => {
    const transport: RelayTransport = async (method, path, body, token) => {
      if (options.native)
        return invoke<RelayResponse>('relay_request', {
          method,
          path,
          body: body ?? null,
          token: token ?? null,
          userAgent: navigator.userAgent,
        })
      const response = await fetch(`/api${path}`, {
        method,
        headers: {
          'Content-Type': 'application/json',
          'X-App-Id': 'axonkey',
          'X-App-Version': appPackage.version,
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(20000),
      })
      return {
        status: response.status,
        body: response.status === 204 ? null : await response.json(),
        requestId: response.headers.get('X-Request-ID') ?? undefined,
      }
    }
    return new RelayClient(transport, null, async session => {
      if (options.native) {
        const stored = session
          ? { refresh_token: session.refresh_token, user: session.user, requestId: session.requestId }
          : null
        await invoke('save_relay_session', { session: stored })
      }
      update({ ...current.current, session, autoSync: session ? current.current.autoSync : false })
    })
  })

  useEffect(() => {
    if (!options.native) return
    let active = true
    logCloud('session.load.start')
    void invoke<Omit<RelaySession, 'access_token' | 'expires_at'> | null>('load_relay_session')
      .then(stored => {
        if (!active) return
        if (
          stored &&
          (typeof stored.refresh_token !== 'string' ||
            !stored.refresh_token ||
            typeof stored.user?.id !== 'string' ||
            (stored.requestId !== undefined && typeof stored.requestId !== 'string'))
        )
          throw new Error('登录凭据文件格式无效，请重新登录；本地功能不受影响')
        const session = stored ? { ...stored, access_token: '', expires_at: 0 } : null
        client.session = session
        current.current = { ...current.current, session, autoSync: !!session && current.current.autoSync }
        setPreferences(current.current)
        logCloud('session.load.complete', {
          signed_in: !!session,
          auto_sync: current.current.autoSync,
          refresh_pending: !!session?.requestId,
        })
      })
      .catch(error => {
        if (active) {
          logCloud('session.load.failed', relayFailureDetails(error), 'error')
          setError(String(error))
        }
      })
      .finally(() => {
        if (active) setAccountLoaded(true)
      })
    return () => {
      active = false
    }
  }, [client, options.native])

  async function run(operation: string, action: () => Promise<void | string>, syncing = false) {
    if (working.current) {
      logCloud('operation.skipped', { operation, reason: 'busy' })
      return
    }
    const started = Date.now()
    logCloud('operation.start', { operation, signed_in: !!client.session })
    working.current = true
    setBusy(true)
    setError('')
    setMessage('')
    try {
      const outcome = await action()
      logCloud('operation.complete', { operation, outcome: outcome ?? 'success', duration_ms: Date.now() - started })
    } catch (error) {
      if (
        syncing &&
        (error instanceof SyncConflict ||
          (error instanceof RelayError &&
            error.status === 409 &&
            ['revision_conflict', 'already_exists'].includes(error.code)))
      ) {
        logCloud('sync.conflict', {
          operation,
          initial: error instanceof SyncConflict && error.initial,
          auto_sync_paused: current.current.autoSync,
          duration_ms: Date.now() - started,
        })
        setConflict(error instanceof SyncConflict && error.initial ? 'initial' : 'changed')
        update({ ...current.current, autoSync: false })
      } else if (syncing && isTemporarySyncFailure(error)) {
        logCloud('sync.deferred', {
          operation,
          auto_retry: current.current.autoSync,
          retry_after_ms: 60000,
          ...relayFailureDetails(error),
          duration_ms: Date.now() - started,
        })
        setMessage(
          current.current.autoSync
            ? '暂时无法同步，将稍后自动重试。本地配置已保留。'
            : '暂时无法同步，可稍后重试。本地配置已保留。',
        )
      } else {
        logCloud(
          'operation.failed',
          { operation, ...relayFailureDetails(error), duration_ms: Date.now() - started },
          'error',
        )
        setError(error instanceof Error ? error.message : String(error))
      }
      retryAt.current = Date.now() + 60000
    } finally {
      working.current = false
      setBusy(false)
    }
  }

  function account() {
    const id = client.session!.user.id
    return current.current.accounts[id] ?? { memory: {}, lastSync: null, fingerprint: null }
  }
  function saveAccount(value: ReturnType<typeof account>) {
    const id = client.session!.user.id
    update({ ...current.current, accounts: { ...current.current.accounts, [id]: value } })
  }
  const sync = (overwrite = false, source: 'manual' | 'automatic' = 'manual') =>
    run(
      `sync.${source}`,
      async () => {
        if (!latest.current.ready) {
          setMessage('正在保存本地配置，请稍后同步')
          return 'local_not_ready'
        }
        const snapshot = latest.current.snapshot()
        logCloud('sync.snapshot', {
          source,
          overwrite,
          documents: snapshot.documents.length,
          settings: Object.keys(snapshot.settings).length,
        })
        await uploadCloud(
          client,
          snapshot,
          account().memory,
          memory => saveAccount({ ...account(), memory }),
          overwrite,
        )
        saveAccount({ ...account(), lastSync: new Date().toISOString(), fingerprint: fingerprint(snapshot) })
        setConflict(null)
        setMessage('配置已同步到云端')
      },
      true,
    )
  const syncRef = useRef(sync)
  syncRef.current = sync

  useEffect(() => {
    if (!preferences.session || !preferences.autoSync) return
    const tick = () => {
      if (!latest.current.ready || working.current || Date.now() < retryAt.current) return
      try {
        const snapshot = latest.current.snapshot()
        const saved = current.current.accounts[current.current.session!.user.id]
        if (fingerprint(snapshot) !== saved?.fingerprint) void syncRef.current(false, 'automatic')
      } catch (error) {
        logCloud('sync.snapshot.failed', { ...relayFailureDetails(error), retry_after_ms: 60000 }, 'error')
        setError(error instanceof Error ? error.message : String(error))
        retryAt.current = Date.now() + 60000
      }
    }
    const start = window.setTimeout(tick, 1500)
    const timer = window.setInterval(tick, 5000)
    window.addEventListener('online', tick)
    return () => {
      window.clearTimeout(start)
      window.clearInterval(timer)
      window.removeEventListener('online', tick)
    }
  }, [preferences.session?.user.id, preferences.autoSync])

  return {
    user: preferences.session?.user ?? null,
    autoSync: preferences.autoSync,
    lastSync: preferences.session ? preferences.accounts[preferences.session.user.id]?.lastSync : null,
    busy: busy || !accountLoaded,
    error,
    message,
    conflict,
    pendingRestore,
    ready: options.ready,
    clearFeedback() {
      setError('')
      setMessage('')
    },
    setAutoSync(value: boolean) {
      if (!client.session || working.current) return
      logCloud('sync.auto.changed', { enabled: value })
      update({ ...current.current, autoSync: value })
      retryAt.current = 0
    },
    sendCode: (channel: 'email' | 'sms', target: string, sent: (seconds: number) => void) =>
      run(`auth.send_code.${channel}`, async () => {
        const result = await client.sendCode(channel, target)
        sent(result.retry_after)
      }),
    login: (channel: 'email' | 'sms', target: string, code: string) =>
      run(`auth.login.${channel}`, async () => {
        await client.login(channel, target, code)
        update({ ...current.current, autoSync: false })
        setConflict(null)
      }),
    logout: () =>
      run(`auth.logout`, async () => {
        setConflict(null)
        setPendingRestore(null)
        try {
          await client.logout()
        } catch (error) {
          if (client.session) throw error
          logCloud('auth.logout.local_only', relayFailureDetails(error))
          setMessage('已退出本机账号，云端会话未能撤销，可在 Relay 控制台管理会话')
          return 'local_only'
        }
      }),
    openConsole: () =>
      run(`console.open`, async () => {
        const { ticket } = await client.request<{ ticket: string }>('POST', '/auth/console-ticket', {})
        if (latest.current.native) {
          await invoke('open_external_page', { page: 'console', ticket })
        } else {
          window.location.assign(`https://relay.wleo.cn/#console-ticket=${encodeURIComponent(ticket)}`)
        }
      }),
    sync,
    fetchRestore: () =>
      run(`restore.fetch`, async () => {
        logCloud('sync.auto.paused', { reason: 'restore', was_enabled: current.current.autoSync })
        update({ ...current.current, autoSync: false })
        const cloud = await readCloud(client)
        if (!cloud.documents.length && !cloud.settings) {
          setMessage('云端还没有配置，可先点击“同步一次”保存本机配置')
          return 'cloud_empty'
        }
        logCloud('restore.preview', { documents: cloud.documents.length, has_settings: !!cloud.settings })
        setPendingRestore(cloud)
      }),
    cancelRestore: () => {
      logCloud('restore.cancelled')
      setPendingRestore(null)
    },
    confirmRestore: () =>
      run(`restore.apply`, async () => {
        if (!pendingRestore) return 'no_pending_restore'
        logCloud('restore.confirmed', {
          documents: pendingRestore.documents.length,
          has_settings: !!pendingRestore.settings,
        })
        await latest.current.restore(pendingRestore)
        setPendingRestore(null)
        setConflict(null)
        setMessage('已从云端恢复，自动同步已关闭')
      }),
  }
}
export type CloudSyncController = ReturnType<typeof useCloudSync>

function isTemporarySyncFailure(error: unknown) {
  if (error instanceof RelayError) return error.status >= 500 || error.status === 429
  if (error instanceof Error) return ['TypeError', 'AbortError', 'TimeoutError'].includes(error.name)
  return typeof error === 'string' && error.startsWith('无法连接云端')
}

function readPreferences(): CloudPreferences {
  try {
    const value = JSON.parse(localStorage.getItem(storageKey) ?? 'null')
    if (!value || typeof value !== 'object') return defaults()
    return {
      session: null,
      autoSync: value.autoSync === true,
      accounts: value.accounts && typeof value.accounts === 'object' ? value.accounts : {},
    }
  } catch {
    return defaults()
  }
}
