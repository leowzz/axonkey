import { useEffect, useRef, useState } from 'react'
import { invoke } from '@tauri-apps/api/core'
import { RelayClient, RelayError } from './relayClient'
import type { RelayResponse, RelaySession, RelayTransport } from './relayClient'
import { fingerprint, readCloud, SyncConflict, uploadCloud } from './cloudSync'
import type { CloudSnapshot, CloudState, SyncMemory } from './cloudSync'
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
      return { status: response.status, body: response.status === 204 ? null : await response.json() }
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
      })
      .catch(error => {
        if (active) setError(String(error))
      })
      .finally(() => {
        if (active) setAccountLoaded(true)
      })
    return () => {
      active = false
    }
  }, [client, options.native])

  async function run(action: () => Promise<void>, syncing = false) {
    if (working.current) return
    working.current = true
    setBusy(true)
    setError('')
    setMessage('')
    try {
      await action()
    } catch (error) {
      if (
        syncing &&
        (error instanceof SyncConflict ||
          (error instanceof RelayError &&
            error.status === 409 &&
            ['revision_conflict', 'already_exists'].includes(error.code)))
      ) {
        setConflict(error instanceof SyncConflict && error.initial ? 'initial' : 'changed')
        update({ ...current.current, autoSync: false })
      } else if (syncing && isTemporarySyncFailure(error)) {
        setMessage(
          current.current.autoSync
            ? '暂时无法同步，将稍后自动重试。本地配置已保留。'
            : '暂时无法同步，可稍后重试。本地配置已保留。',
        )
      } else {
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
  const sync = (overwrite = false) =>
    run(async () => {
      if (!latest.current.ready) {
        setMessage('正在保存本地配置，请稍后同步')
        return
      }
      const snapshot = latest.current.snapshot()
      await uploadCloud(client, snapshot, account().memory, memory => saveAccount({ ...account(), memory }), overwrite)
      saveAccount({ ...account(), lastSync: new Date().toISOString(), fingerprint: fingerprint(snapshot) })
      setConflict(null)
      setMessage('配置已同步到云端')
    }, true)
  const syncRef = useRef(sync)
  syncRef.current = sync

  useEffect(() => {
    if (!preferences.session || !preferences.autoSync) return
    const tick = () => {
      if (!latest.current.ready || working.current || Date.now() < retryAt.current) return
      try {
        const snapshot = latest.current.snapshot()
        const saved = current.current.accounts[current.current.session!.user.id]
        if (fingerprint(snapshot) !== saved?.fingerprint) void syncRef.current()
      } catch (error) {
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
      update({ ...current.current, autoSync: value })
      retryAt.current = 0
    },
    sendCode: (channel: 'email' | 'sms', target: string, sent: (seconds: number) => void) =>
      run(async () => {
        const result = await client.sendCode(channel, target)
        sent(result.retry_after)
      }),
    login: (channel: 'email' | 'sms', target: string, code: string) =>
      run(async () => {
        await client.login(channel, target, code)
        update({ ...current.current, autoSync: false })
        setConflict(null)
      }),
    logout: () =>
      run(async () => {
        setConflict(null)
        setPendingRestore(null)
        try {
          await client.logout()
        } catch (error) {
          if (client.session) throw error
          setMessage('已退出本机账号，云端会话未能撤销，可在 Relay 控制台管理会话')
        }
      }),
    sync,
    fetchRestore: () =>
      run(async () => {
        update({ ...current.current, autoSync: false })
        const cloud = await readCloud(client)
        if (!cloud.documents.length && !cloud.settings) {
          setMessage('云端还没有配置，可先点击“同步一次”保存本机配置')
          return
        }
        setPendingRestore(cloud)
      }),
    cancelRestore: () => setPendingRestore(null),
    confirmRestore: () =>
      run(async () => {
        if (!pendingRestore) return
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
