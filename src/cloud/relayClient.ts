export type RelaySession = {
  access_token: string
  refresh_token: string
  expires_at: number
  user: { id: string; email: string | null; phone: string | null }
  requestId?: string
}
export type RelayResponse = { status: number; body: unknown }
export type RelayTransport = (method: string, path: string, body?: unknown, token?: string) => Promise<RelayResponse>
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

  async sendCode(channel: 'email' | 'sms', target: string) {
    return this.request<{ retry_after: number }>('POST', '/auth/code', loginInput(channel, target), false)
  }

  async login(channel: 'email' | 'sms', target: string, code: string) {
    const session = await this.request<unknown>(
      'POST',
      '/auth/verify',
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

  async request<T>(method: string, path: string, body?: unknown, authenticated = true): Promise<T> {
    if (authenticated) {
      if (!this.session) throw new RelayError(401, 'login_required', '请先登录')
      if (this.session.requestId || this.session.expires_at <= Date.now() / 1000 + 30) await this.refresh()
    }
    let response = await this.transport(method, path, body, authenticated ? this.session!.access_token : undefined)
    if (authenticated && response.status === 401 && errorBody(response.body).code === 'access_token_expired') {
      await this.refresh()
      response = await this.transport(method, path, body, this.session!.access_token)
    }
    if (authenticated && response.status === 401) await this.setSession(null)
    return unwrap<T>(response)
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
    // Relay rotates refresh tokens. Persist the retry ID before sending, including across restarts.
    await this.setSession(pending)
    const response = await this.transport('POST', '/auth/refresh', {
      refresh_token: pending.refresh_token,
      request_id: pending.requestId,
    })
    if (response.status === 401) await this.setSession(null)
    await this.setSession(parseSession(unwrap<unknown>(response)))
  }

  private async setSession(session: RelaySession | null) {
    await this.save(session)
    this.session = session
  }
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
