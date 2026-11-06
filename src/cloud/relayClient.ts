import { logCloud } from './cloudLogging.ts'
import type { CaptchaConfig } from './captcha.ts'

export type RelaySession = {
  access_token: string
  refresh_token: string
  expires_at: number
  user: { id: string; email: string | null; phone: string | null }
  requestId?: string
}
export type RelayResponse = { status: number; body: unknown; requestId?: string; etag?: string }
export type RelayTransport = (
  method: string,
  path: string,
  body?: unknown,
  token?: string,
  conditions?: RelayConditions,
) => Promise<RelayResponse>
export type RelayConditions = { ifMatch?: string; ifNoneMatch?: '*' }
export class RelayError extends Error {
  status: number
  code: string
  constructor(status: number, code: string, message: string) {
    super(message)
    this.status = status
    this.code = code
  }
}

export class RelayClient {
  private refreshing: Promise<void> | null = null
  private transport: RelayTransport
  session: RelaySession | null
  private save: (session: RelaySession | null) => void | Promise<void>
  constructor(
    transport: RelayTransport,
    session: RelaySession | null,
    save: (session: RelaySession | null) => void | Promise<void>,
  ) {
    this.transport = transport
    this.session = session
    this.save = save
  }

  async captcha() {
    return this.request<CaptchaConfig>('GET', '/auth/captcha', undefined, false)
  }

  async sendCode(channel: 'email' | 'sms', target: string, captchaToken: string) {
    return this.request<{ retry_after: number }>(
      'POST',
      '/auth/v2/code',
      { ...loginInput(channel, target), captcha_token: captchaToken },
      false,
    )
  }

  async login(channel: 'email' | 'sms', target: string, code: string) {
    const session = await this.request<unknown>(
      'POST',
      '/auth/v2/verify',
      {
        ...loginInput(channel, target),
        code,
      },
      false,
    )
    await this.setSession(parseSession(session))
  }

  async logout() {
    try {
      await this.request('POST', '/auth/logout')
    } finally {
      await this.setSession(null)
    }
  }

  async request<T>(
    method: string,
    path: string,
    body?: unknown,
    authenticated = true,
    conditions?: RelayConditions,
  ): Promise<T> {
    return (await this.resource<T>(method, path, body, authenticated, conditions)).body
  }

  async resource<T>(
    method: string,
    path: string,
    body?: unknown,
    authenticated = true,
    conditions?: RelayConditions,
  ): Promise<{ body: T; etag?: string }> {
    if (authenticated) {
      if (!this.session) throw new RelayError(401, 'login_required', '请先登录')
      if (this.session.requestId || this.session.expires_at <= Date.now() / 1000 + 30) await this.refresh()
    }
    let response = await this.send(
      method,
      path,
      body,
      authenticated ? this.session!.access_token : undefined,
      conditions,
    )
    if (authenticated && response.status === 401 && errorBody(response.body).code === 'access_token_expired') {
      await this.refresh()
      response = await this.send(method, path, body, this.session!.access_token, conditions)
    }
    if (authenticated && response.status === 401) {
      logCloud('session.invalidated', { method, path, status: response.status })
      await this.setSession(null)
    }
    return { body: unwrap<T>(response), etag: response.etag }
  }

  private refresh() {
    if (!this.refreshing) {
      this.refreshing = this.refreshSession().finally(() => {
        this.refreshing = null
      })
    }
    return this.refreshing
  }

  private async refreshSession() {
    const previous = this.session!
    const pending = { ...previous, requestId: previous.requestId ?? crypto.randomUUID() }
    const started = Date.now()
    logCloud('session.refresh.start', { retry: !!previous.requestId, refresh_request_id: pending.requestId })
    try {
      // Relay rotates refresh tokens. Persist the retry ID before sending, including across restarts.
      await this.setSession(pending)
      const response = await this.send('POST', '/auth/refresh', {
        refresh_token: pending.refresh_token,
        request_id: pending.requestId,
      })
      if (response.status === 401) {
        logCloud('session.invalidated', { path: '/auth/refresh', status: response.status })
        await this.setSession(null)
      }
      await this.setSession(parseSession(unwrap<unknown>(response)))
      logCloud('session.refresh.success', { duration_ms: Date.now() - started })
    } catch (error) {
      logCloud('session.refresh.failed', { ...relayFailureDetails(error), duration_ms: Date.now() - started }, 'error')
      throw error
    }
  }

  private async setSession(session: RelaySession | null) {
    try {
      await this.save(session)
    } catch (error) {
      logCloud('session.save.failed', { signed_in: !!session, ...relayFailureDetails(error) }, 'error')
      throw error
    }
    this.session = session
    logCloud('session.saved', { signed_in: !!session, refresh_pending: !!session?.requestId })
  }

  private async send(method: string, path: string, body?: unknown, token?: string, conditions?: RelayConditions) {
    const started = Date.now()
    logCloud('request.start', { method, path })
    try {
      const response = await this.transport(method, path, body, token, conditions)
      logCloud('request.complete', {
        method,
        path,
        status: response.status,
        server_request_id: response.requestId,
        duration_ms: Date.now() - started,
      })
      return response
    } catch (error) {
      logCloud(
        'request.failed',
        { method, path, duration_ms: Date.now() - started, ...relayFailureDetails(error) },
        'error',
      )
      throw error
    }
  }
}

// Remote detail strings and arbitrary exception messages can contain account or configuration data.
export function relayFailureDetails(error: unknown) {
  if (error instanceof RelayError) return { status: error.status, code: error.code }
  if (error instanceof Error) return { error_type: error.name }
  const reasons: Record<string, string> = {
    '无法连接云端，请检查网络后重试；本地功能不受影响': 'network_unavailable',
    '云端响应无法读取，请稍后重试': 'invalid_response',
    无法初始化云端连接: 'http_client_initialization',
    '无法读取登录凭据文件；本地功能不受影响': 'session_read',
    '登录凭据无法读取，请重新登录': 'session_decode',
    无法保存登录凭据文件: 'session_write',
    无法更新登录凭据文件: 'session_replace',
    '无法清除登录凭据文件，请重试退出登录': 'session_delete',
  }
  return { error_type: typeof error === 'string' ? (reasons[error] ?? 'native_error') : 'unknown_error' }
}

function loginInput(channel: 'email' | 'sms', target: string) {
  return {
    channel,
    [channel === 'email' ? 'email' : 'phone']: target.trim(),
    app_id: 'axonkey',
    client_name: 'Axonkey Desktop',
  }
}
function errorBody(body: unknown) {
  return (body && typeof body === 'object' ? body : {}) as { code?: string; detail?: string }
}
function parseSession(value: unknown): RelaySession {
  const session = value as Partial<RelaySession> | null
  if (
    !session ||
    typeof session.access_token !== 'string' ||
    !session.access_token ||
    typeof session.refresh_token !== 'string' ||
    !session.refresh_token ||
    typeof session.expires_at !== 'number' ||
    !Number.isFinite(session.expires_at) ||
    typeof session.user?.id !== 'string' ||
    !session.user.id ||
    (session.user.email !== null && typeof session.user.email !== 'string') ||
    (session.user.phone !== null && typeof session.user.phone !== 'string')
  )
    throw new Error('云端登录响应无效，请稍后重试；本地功能不受影响')
  return {
    access_token: session.access_token,
    refresh_token: session.refresh_token,
    expires_at: session.expires_at,
    user: session.user,
  }
}
function unwrap<T>(response: RelayResponse): T {
  if (response.status >= 200 && response.status < 300) return response.body as T
  const error = errorBody(response.body)
  throw new RelayError(
    response.status,
    error.code ?? 'request_failed',
    error.detail ?? `云端请求失败（${response.status}）`,
  )
}
