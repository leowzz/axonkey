import assert from 'node:assert/strict'
import test from 'node:test'
import { RelayClient } from '../src/cloud/relayClient.ts'
import {
  clearDeviceModelCatalogCache,
  deviceModelCatalogCacheTtlMs,
  fetchDeviceModelCatalog,
  loadDeviceModelCatalog,
  parseDeviceModelCatalog,
  readCachedDeviceModelCatalog,
  writeCachedDeviceModelCatalog,
} from '../src/cloud/deviceModelCatalog.ts'
import { readCloud } from '../src/cloud/cloudSync.ts'
import { externalUrlHostname, normalizeExternalHttpUrl, openExternalUrl } from '../src/openExternalUrl.ts'

function createStorage() {
  const map = new Map()
  return {
    map,
    getItem(key) {
      return map.get(key) ?? null
    },
    setItem(key, value) {
      map.set(key, String(value))
    },
    removeItem(key) {
      map.delete(key)
    },
  }
}

const activeSession = () => ({
  access_token: 'access-token-1',
  refresh_token: 'refresh-token-1',
  expires_at: Math.floor(Date.now() / 1000) + 3600,
  user: { id: 'user-1', email: 'user@example.invalid', phone: null },
})

test('parseDeviceModelCatalog normalizes legacy responses, deduplicates tags, and filters unsafe links at boundary', () => {
  const items = parseDeviceModelCatalog({
    items: [
      {
        id: 'model-rc003',
        code: 'rc003',
        name: ' 小米蓝牙遥控器 2 Pro ',
        model: ' RC003 ',
        brand_id: 'brand-xiaomi',
        brand_name: ' 小米 ',
        description: '  # 蓝牙遥控器\r\n支持低功耗蓝牙  ',
        tags: [' 蓝牙 ', '红外', '蓝牙', '', '   ', 42, 'x'.repeat(65)],
        links: [
          { label: ' 京东自营 ', url: ' https://item.jd.com/10001.html?from=axonkey&sku=2 ' },
          { label: '天猫旗舰店', url: 'http://detail.tmall.com/item.htm?id=99' },
          { label: 'XSS 1', url: 'javascript:alert(1)' },
          { label: 'XSS 2', url: 'JavaScript:confirm(document.cookie)' },
          { label: 'Data URL', url: 'data:text/html,<script>alert(1)</script>' },
          { label: 'Local file', url: 'file:///Applications/Calculator.app' },
          { label: 'Relative', url: '/shop/rc003' },
          { label: 'Credentials', url: 'https://user:secret@example.com/buy' },
          { label: '   ', url: 'https://example.com/valid' },
        ],
      },
      {
        id: 'model-legacy',
        code: 'cmiotA15',
        name: 'CMIOT-A15',
        model: 'CMIOT-A15',
      },
      { id: '', code: 'invalid' },
      null,
    ],
  })

  assert.equal(items.length, 2)
  assert.deepEqual(items[0], {
    id: 'model-rc003',
    code: 'rc003',
    name: '小米蓝牙遥控器 2 Pro',
    model: 'RC003',
    brand_id: 'brand-xiaomi',
    brand_name: '小米',
    description: '# 蓝牙遥控器\n支持低功耗蓝牙',
    tags: ['蓝牙', '红外'],
    links: [
      { label: '京东自营', url: 'https://item.jd.com/10001.html?from=axonkey&sku=2' },
      { label: '天猫旗舰店', url: 'http://detail.tmall.com/item.htm?id=99' },
    ],
  })
  assert.deepEqual(items[1], {
    id: 'model-legacy',
    code: 'cmiotA15',
    name: 'CMIOT-A15',
    model: 'CMIOT-A15',
    brand_id: null,
    brand_name: null,
    description: '',
    tags: [],
    links: [],
  })
  assert.throws(() => parseDeviceModelCatalog({ items: null }), /目录响应/)
})

test('fetchDeviceModelCatalog sends auth when signed in, omits auth when signed out, and falls back when session expires', async () => {
  // 1. Signed-in user sends bearer token (including automatic refresh when expired)
  const signedInCalls = []
  const expiredSession = { ...activeSession(), expires_at: 0 }
  const signedInClient = new RelayClient(
    async (method, path, body, token) => {
      signedInCalls.push({ method, path, body, token })
      if (path === '/auth/refresh') {
        return {
          status: 200,
          body: { ...activeSession(), access_token: 'refreshed-access', refresh_token: 'rotated-refresh' },
        }
      }
      return {
        status: 200,
        body: { items: [{ id: 'm1', code: 'rc003', name: '小米蓝牙遥控器2Pro', model: 'RC003', tags: ['语音'] }] },
      }
    },
    expiredSession,
    () => {},
  )
  const authedItems = await fetchDeviceModelCatalog(signedInClient)
  assert.equal(authedItems.length, 1)
  assert.deepEqual(authedItems[0].tags, ['语音'])
  assert.deepEqual(
    signedInCalls.map(c => [c.path, c.token]),
    [
      ['/auth/refresh', undefined],
      ['/v2/device-models?app_id=axonkey', 'refreshed-access'],
    ],
  )

  // 2. Signed-out user omits bearer token completely
  const anonymousCalls = []
  const anonymousClient = new RelayClient(
    async (method, path, _body, token) => {
      anonymousCalls.push({ method, path, token })
      return { status: 200, body: { items: [{ id: 'm1', code: 'rc003', name: '小米蓝牙遥控器2Pro', model: 'RC003' }] } }
    },
    null,
    () => {},
  )
  const anonItems = await fetchDeviceModelCatalog(anonymousClient)
  assert.equal(anonItems.length, 1)
  assert.deepEqual(anonymousCalls, [{ method: 'GET', path: '/v2/device-models?app_id=axonkey', token: undefined }])

  // 3. Invalidated session (401) clears session and falls back to unauthenticated catalog request
  const fallbackCalls = []
  let savedSession = activeSession()
  const invalidatedClient = new RelayClient(
    async (method, path, _body, token) => {
      fallbackCalls.push({ method, path, token })
      if (token) {
        return { status: 401, body: { code: 'invalid_token', detail: '会话已失效' } }
      }
      return {
        status: 200,
        body: { items: [{ id: 'm2', code: 'tclRc802a', name: 'TCL RC802A', model: 'RC802A', brand_name: 'TCL' }] },
      }
    },
    savedSession,
    next => {
      savedSession = next
    },
  )
  const fallbackItems = await fetchDeviceModelCatalog(invalidatedClient)
  assert.equal(savedSession, null)
  assert.equal(fallbackItems[0].brand_name, 'TCL')
  assert.deepEqual(fallbackCalls, [
    { method: 'GET', path: '/v2/device-models?app_id=axonkey', token: 'access-token-1' },
    { method: 'GET', path: '/v2/device-models?app_id=axonkey', token: undefined },
  ])
})

test('loadDeviceModelCatalog serves fresh cache without network and falls back to stale cache while offline', async () => {
  const storage = createStorage()
  let networkCalls = 0
  let offline = false
  let serverBrand = '小米'
  const client = new RelayClient(
    async () => {
      networkCalls++
      if (offline) throw new Error('无法连接云端，请检查网络后重试；本地功能不受影响')
      return {
        status: 200,
        body: {
          items: [{ id: 'm1', code: 'rc003', name: '小米蓝牙遥控器2Pro', model: 'RC003', brand_name: serverBrand }],
        },
      }
    },
    null,
    () => {},
  )

  const t0 = 1_700_000_000_000
  writeCachedDeviceModelCatalog(
    [
      {
        id: 'm1',
        code: 'rc003',
        name: '小米蓝牙遥控器2Pro',
        model: 'RC003',
        brand_id: null,
        brand_name: '缓存品牌',
        description: '离线说明',
        tags: ['离线标签'],
        links: [],
      },
    ],
    storage,
    t0,
  )

  // Fresh cache skips network
  const fresh = await loadDeviceModelCatalog(client, storage, t0 + 60_000)
  assert.equal(networkCalls, 0)
  assert.equal(fresh[0].brand_name, '缓存品牌')

  // Stale cache + offline preserves stale cached catalog without throwing
  offline = true
  const staleOffline = await loadDeviceModelCatalog(client, storage, t0 + deviceModelCatalogCacheTtlMs + 1)
  assert.equal(networkCalls, 1)
  assert.equal(staleOffline[0].brand_name, '缓存品牌')
  assert.equal(staleOffline[0].description, '离线说明')

  // Stale cache + back online refreshes and updates persisted cache
  offline = false
  serverBrand = '最新小米'
  const refreshed = await loadDeviceModelCatalog(client, storage, t0 + deviceModelCatalogCacheTtlMs + 2)
  assert.equal(networkCalls, 2)
  assert.equal(refreshed[0].brand_name, '最新小米')

  // Reading from a fresh storage clone confirms localStorage persistence
  const reloadedStorage = createStorage()
  for (const [k, v] of storage.map) reloadedStorage.setItem(k, v)
  const persisted = readCachedDeviceModelCatalog(reloadedStorage, Date.now())
  assert.equal(persisted?.fresh, true)
  assert.equal(persisted?.items[0].brand_name, '最新小米')

  clearDeviceModelCatalogCache(storage)
  assert.equal(readCachedDeviceModelCatalog(storage, Date.now()), null)
})

test('readCloud remains compatible with enriched /v2/device-models fields', async () => {
  const client = new RelayClient(
    async (_method, path) => {
      if (path === '/v2/device-models?app_id=axonkey') {
        return {
          status: 200,
          body: {
            items: [
              {
                id: 'm1',
                code: 'rc003',
                name: '小米蓝牙遥控器2Pro',
                model: 'RC003',
                description: '**语音遥控**',
                tags: ['蓝牙'],
                links: [{ label: '官网', url: 'https://www.mi.com/shop' }],
              },
            ],
          },
        }
      }
      if (path.startsWith('/v2/device-configs?')) {
        return { status: 200, body: { items: [], total: 0 } }
      }
      return { status: 404, body: { code: 'not_found' } }
    },
    activeSession(),
    () => {},
  )
  const state = await readCloud(client)
  assert.equal(state.models[0].id, 'm1')
  assert.equal(state.models[0].code, 'rc003')
  assert.equal(state.models[0].description, '**语音遥控**')
})

test('openExternalUrl strictly validates HTTP(S) URLs and routes to Tauri command or browser window.open', async () => {
  assert.equal(normalizeExternalHttpUrl('https://www.jd.com/item/123?a=1&b=2'), 'https://www.jd.com/item/123?a=1&b=2')
  assert.equal(externalUrlHostname('https://www.jd.com/item/123'), 'jd.com')
  for (const unsafe of [
    '',
    'javascript:alert(1)',
    'data:text/html,hi',
    'vbscript:msgbox(1)',
    'ftp://files.example.com/a',
    'https://user:pass@example.com/',
    'https://example.com/has space',
    'https://example.com/\nnewline',
    '//example.com/protocol-relative',
  ]) {
    assert.equal(normalizeExternalHttpUrl(unsafe), null, `should reject ${unsafe}`)
  }

  const nativeInvocations = []
  const browserOpens = []
  let prevented = 0
  let stopped = 0
  const event = {
    preventDefault() {
      prevented++
    },
    stopPropagation() {
      stopped++
    },
  }

  // Unsafe URL still prevents default/propagation and invokes nothing
  const blocked = await openExternalUrl('javascript:alert(1)', {
    native: true,
    event,
    invokeCommand: async (...args) => nativeInvocations.push(args),
    openWindow: (...args) => browserOpens.push(args),
  })
  assert.equal(blocked, false)
  assert.equal(prevented, 1)
  assert.equal(stopped, 1)
  assert.equal(nativeInvocations.length, 0)
  assert.equal(browserOpens.length, 0)

  // Native mode invokes open_external_url
  const okNative = await openExternalUrl('https://item.jd.com/10001.html?a=1&b=2', {
    native: true,
    event,
    invokeCommand: async (cmd, payload) => {
      nativeInvocations.push([cmd, payload])
    },
  })
  assert.equal(okNative, true)
  assert.equal(prevented, 2)
  assert.equal(stopped, 2)
  assert.deepEqual(nativeInvocations, [['open_external_url', { url: 'https://item.jd.com/10001.html?a=1&b=2' }]])

  // Browser preview mode uses window.open with noopener,noreferrer
  const okPreview = await openExternalUrl('https://detail.tmall.com/item.htm?id=88', {
    native: false,
    event,
    openWindow: (url, target, features) => {
      browserOpens.push([url, target, features])
      return {}
    },
  })
  assert.equal(okPreview, true)
  assert.deepEqual(browserOpens, [['https://detail.tmall.com/item.htm?id=88', '_blank', 'noopener,noreferrer']])
})
