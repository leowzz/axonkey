import assert from 'node:assert/strict'
import { readdirSync, readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import test from 'node:test'
import vm from 'node:vm'
import React from 'react'
import Renderer, { act } from 'react-test-renderer'
import * as reiconReact from 'reicon-react'
import ts from 'typescript'
import { RelayClient } from '../src/cloud/relayClient.ts'
import {
  activateCatalogDeviceDescriptors,
  clearDeviceModelCatalogCache,
  deviceModelCatalogCacheTtlMs,
  deviceModelCatalogEndpoint,
  fetchDeviceModelCatalog,
  getBundledDeviceModelCatalog,
  loadDeviceModelCatalog,
  maxDeviceModelCatalogCacheTtlSeconds,
  minDeviceModelCatalogCacheTtlSeconds,
  parseDeviceModelCatalog,
  parseDeviceModelCatalogEnvelope,
  readCachedDeviceModelCatalog,
  writeCachedDeviceModelCatalog,
} from '../src/cloud/deviceModelCatalog.ts'
import { readCloud } from '../src/cloud/cloudSync.ts'
import {
  bundledSupportPackages,
  getSupportPackages,
  newInstance,
  packageFor,
  resetRuntimeSupportPackages,
  supportPackages,
  supportsWindowsDriver,
  usesSingleLaneWorkspace,
} from '../src/devices/integration/model.ts'
import { createDescriptorView, parseRuntimeDescriptorSvg } from '../src/devices/shared/descriptorSvg.ts'
import { externalUrlHostname, normalizeExternalHttpUrl, openExternalUrl } from '../src/openExternalUrl.ts'

function createStorage({ failWrites = false } = {}) {
  const map = new Map()
  return {
    map,
    getItem(key) {
      return map.get(key) ?? null
    },
    setItem(key, value) {
      if (failWrites) {
        const err = new Error('QuotaExceededError')
        err.name = 'QuotaExceededError'
        throw err
      }
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

function buildCustomRemoteSvg({
  deviceId = 'custom.remote.x',
  model = 'CR-X1',
  displayName = '极客遥控器 X1',
  vid = '0x2B00',
  pid = '0x9901',
} = {}) {
  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg"
     xmlns:ak="urn:axonkey:device:1"
     width="240" height="520" viewBox="0 0 240 520"
     data-ak-schema="axonkey.device/1"
     data-ak-device="${deviceId}"
     data-ak-revision="1">
  <metadata>
    <ak:device schema="axonkey.device/1" id="${deviceId}" vendor="GeekGear" model="${model}" revision="1" display-name="${displayName}">
      <ak:identity>
        <ak:match transport="bluetooth-hid" vid="${vid}" pid="${pid}" usage-page="0x0C" usage="0x01" windows-prefix="BTHLEDEVICE" />
      </ak:identity>
      <ak:reports>
        <ak:report id="consumer" direction="input" report-id="0x02" length="3" encoding="le-u16-single" usage-page="0x0C" payload-offset="1" endian="little" state-group="consumer" />
      </ak:reports>
      <ak:inputs>
        <ak:input id="${deviceId}.ok" label="确认键" short="OK" icon="center" order="0" kind="button" target="#ok-btn" report="consumer" page="0x0C" usage="0x0041" original="true" />
        <ak:input id="${deviceId}.back" label="返回键" short="返回" icon="back" order="1" kind="button" target="#back-btn" report="consumer" page="0x0C" usage="0x0224" original="true" />
      </ak:inputs>
    </ak:device>
  </metadata>
  <g id="ok-btn"><circle cx="120" cy="180" r="36" fill="#e2e8f0" /></g>
  <g id="back-btn"><circle cx="120" cy="300" r="24" fill="#e2e8f0" /></g>
  <path data-ak-region="${deviceId}.ok" data-ak-anchor="120 180" d="M84 180a36 36 0 1 0 72 0a36 36 0 1 0 -72 0" />
  <path data-ak-region="${deviceId}.back" data-ak-anchor="120 300" d="M96 300a24 24 0 1 0 48 0a24 24 0 1 0 -48 0" />
</svg>`
}

test('bundledModelCatalog.json contains all 14 curated console models with platform tags and Markdown descriptions', () => {
  const bundled = getBundledDeviceModelCatalog()
  assert.equal(bundled.length, 14)
  const byCode = new Map(bundled.map(item => [item.code, item]))

  const expectedWinMac = ['rc003', 'phicommDb1R', 'xboxBluetooth', 'kivoK18Lite', 'g17Touch', 'mouse']
  const expectedWinOnly = [
    'cmiotA15',
    'hisenseRcf3b65',
    'rc313',
    'tclRc802a',
    'tclRc902n',
    'tclRc902v',
    'xmBt29',
    'obeRcuR5',
  ]

  for (const code of expectedWinMac) {
    const item = byCode.get(code)
    assert.ok(item, `missing curated model ${code}`)
    assert.ok(item.id.length > 10, `${code} must have real console UUID`)
    assert.ok(item.tags.includes('Win / macOS'), `${code} must carry Win / macOS tag`)
    assert.ok(item.description.length > 40, `${code} must carry curated Markdown description`)
  }
  assert.equal(byCode.get('kivoK18Lite')?.brand_name, 'Kivo')
  assert.ok(byCode.get('kivoK18Lite')?.tags.includes('OLED 屏幕'))
  for (const code of expectedWinOnly) {
    const item = byCode.get(code)
    assert.ok(item, `missing curated model ${code}`)
    assert.ok(item.id.length > 10, `${code} must have real console UUID`)
    assert.ok(item.tags.includes('仅支持 Windows'), `${code} must carry 仅支持 Windows tag`)
    assert.ok(item.description.length > 40, `${code} must carry curated Markdown description`)
  }
})

test('parseDeviceModelCatalog normalizes legacy and SVG responses, deduplicates tags, and filters unsafe links at boundary', () => {
  const svgSample = buildCustomRemoteSvg()
  const sha = 'a'.repeat(64)
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
        id: 'model-custom',
        code: 'customRemoteX',
        name: 'Custom X',
        model: 'CR-X1',
        has_svg: true,
        svg_sha256: sha.toUpperCase(),
        svg: svgSample,
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
    id: 'model-custom',
    code: 'customRemoteX',
    name: 'Custom X',
    model: 'CR-X1',
    brand_id: null,
    brand_name: null,
    description: '',
    tags: [],
    links: [],
    has_svg: true,
    svg_sha256: sha,
    svg: svgSample,
  })
  assert.throws(() => parseDeviceModelCatalog({ items: null }), /目录响应/)
})

test('fetchDeviceModelCatalog requests include_svg=1 with optional auth, refresh, and anonymous 401 fallback', async () => {
  assert.equal(deviceModelCatalogEndpoint, '/v2/device-models?app_id=axonkey&include_svg=1')

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
      ['/v2/device-models?app_id=axonkey&include_svg=1', 'refreshed-access'],
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
  assert.deepEqual(anonymousCalls, [
    { method: 'GET', path: '/v2/device-models?app_id=axonkey&include_svg=1', token: undefined },
  ])

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
    { method: 'GET', path: '/v2/device-models?app_id=axonkey&include_svg=1', token: 'access-token-1' },
    { method: 'GET', path: '/v2/device-models?app_id=axonkey&include_svg=1', token: undefined },
  ])
})

test('loadDeviceModelCatalog honors cloud cache_ttl_seconds (3600s, 0s, clamped bounds, legacy default, QuotaExceededError) and falls back to bundledModelCatalog.json when unreachable', async () => {
  try {
    // Bounds check on envelope parser
    assert.equal(parseDeviceModelCatalogEnvelope({ items: [], cache_ttl_seconds: 3600 }).ttlMs, 3_600_000)
    assert.equal(parseDeviceModelCatalogEnvelope({ items: [], cache_ttl_seconds: 0 }).ttlMs, 0)
    assert.equal(parseDeviceModelCatalogEnvelope({ items: [], cache_ttl_seconds: -10 }).ttlMs, 0)
    assert.equal(
      parseDeviceModelCatalogEnvelope({ items: [], cache_ttl_seconds: 5 }).ttlMs,
      minDeviceModelCatalogCacheTtlSeconds * 1000,
    )
    assert.equal(
      parseDeviceModelCatalogEnvelope({ items: [], cache_ttl_seconds: 99_999_999 }).ttlMs,
      maxDeviceModelCatalogCacheTtlSeconds * 1000,
    )
    assert.equal(parseDeviceModelCatalogEnvelope({ items: [] }).ttlMs, deviceModelCatalogCacheTtlMs)

    const storage = createStorage()
    let networkCalls = 0
    let offline = false
    let serverTtlSeconds = 3600
    let serverBrand = '云端小米 v1'
    const customSvg = buildCustomRemoteSvg({ deviceId: 'custom.saved.1' })

    const client = new RelayClient(
      async () => {
        networkCalls++
        if (offline) throw new Error('无法连接云端，请检查网络后重试；本地功能不受影响')
        return {
          status: 200,
          body: {
            cache_ttl_seconds: serverTtlSeconds,
            items: [
              { id: 'm1', code: 'rc003', name: '小米蓝牙遥控器2Pro', model: 'RC003', brand_name: serverBrand },
              {
                id: 'm-custom',
                code: 'customSaved1',
                name: '云端专属遥控器',
                model: 'CS-1',
                brand_name: '云端厂牌',
                svg: customSvg,
              },
            ],
          },
        }
      },
      null,
      () => {},
    )

    const t0 = 1_700_000_000_000

    // 1. Initial load fetches from cloud and caches for 3600s; customSaved1 becomes active in supportPackages
    const initial = await loadDeviceModelCatalog(client, storage, t0)
    assert.equal(networkCalls, 1)
    assert.equal(initial[0].brand_name, '云端小米 v1')
    assert.equal(packageFor('customSaved1').name, '云端专属遥控器')
    assert.equal(packageFor('customSaved1').inputs.length, 2)

    // 2. Within 3600s (e.g. t0 + 3599s), cache is fresh -> 0 network calls
    const withinTtl = await loadDeviceModelCatalog(client, storage, t0 + 3_599_000)
    assert.equal(networkCalls, 1)
    assert.equal(withinTtl[0].brand_name, '云端小米 v1')

    // 3. Reloaded localStorage clone preserves 3600s TTL across sessions
    const clonedStorage = createStorage()
    for (const [k, v] of storage.map) clonedStorage.setItem(k, v)
    assert.equal(readCachedDeviceModelCatalog(clonedStorage, t0 + 3_599_000)?.fresh, true)
    assert.equal(readCachedDeviceModelCatalog(clonedStorage, t0 + 3_600_001)?.fresh, false)

    // 4. After 3600s + offline (no retained instances) -> falls back to bundledModelCatalog.json + built-in descriptors!
    offline = true
    const offlineBundled = await loadDeviceModelCatalog(client, storage, t0 + 3_600_001)
    assert.equal(networkCalls, 2)
    assert.equal(offlineBundled.length, 14, 'falls back to all 14 curated bundled models')
    assert.equal(offlineBundled.find(i => i.code === 'rc003')?.brand_name, '小米')
    assert.equal(offlineBundled.find(i => i.code === 'kivoK18Lite')?.brand_name, 'Kivo')
    assert.equal(
      supportPackages.some(p => p.kind === 'customSaved1'),
      false,
      'unreferenced cloud-only model removed',
    )
    assert.equal(packageFor('rc003').artwork, '/device-descriptors/rc003.svg')

    // 5. Safety exception: if user has a saved instance of cloud-only model customSaved1, keep its descriptor while offline!
    const offlineWithSavedCloud = await loadDeviceModelCatalog(client, storage, t0 + 3_600_002, {
      retainedKinds: ['customSaved1'],
    })
    assert.equal(networkCalls, 3)
    assert.equal(offlineWithSavedCloud.length, 15)
    assert.equal(packageFor('customSaved1').name, '云端专属遥控器')
    assert.equal(packageFor('customSaved1').inputs.length, 2)
    assert.equal(packageFor('rc003').artwork, '/device-descriptors/rc003.svg')

    // 6. Back online with cache_ttl_seconds = 0 -> never served as fresh on subsequent loads, always re-fetches!
    offline = false
    serverTtlSeconds = 0
    serverBrand = '实时小米 v2'
    const zeroTtlFirst = await loadDeviceModelCatalog(client, storage, t0 + 4_000_000)
    assert.equal(networkCalls, 4)
    assert.equal(zeroTtlFirst[0].brand_name, '实时小米 v2')
    assert.equal(readCachedDeviceModelCatalog(storage, t0 + 4_000_000)?.fresh, false)

    serverBrand = '实时小米 v3'
    const zeroTtlSecond = await loadDeviceModelCatalog(client, storage, t0 + 4_000_001)
    assert.equal(networkCalls, 5, 'cache_ttl_seconds=0 must revalidate on next load')
    assert.equal(zeroTtlSecond[0].brand_name, '实时小米 v3')

    // 7. Completely empty cache + offline -> falls back cleanly to bundledModelCatalog.json
    clearDeviceModelCatalogCache(storage)
    assert.equal(readCachedDeviceModelCatalog(storage, t0), null)
    offline = true
    const coldOffline = await loadDeviceModelCatalog(client, storage, t0 + 5_000_000)
    assert.equal(coldOffline.length, 14)
    assert.ok(coldOffline.find(i => i.code === 'xboxBluetooth')?.tags.includes('Win / macOS'))
    assert.ok(coldOffline.find(i => i.code === 'kivoK18Lite')?.tags.includes('Win / macOS'))
    assert.ok(coldOffline.find(i => i.code === 'g17Touch')?.tags.includes('Win / macOS'))

    // 8. QuotaExceededError on localStorage still serves fresh cache from memory without throwing
    const fullStorage = createStorage({ failWrites: true })
    writeCachedDeviceModelCatalog(getBundledDeviceModelCatalog(), fullStorage, t0, 600)
    assert.equal(fullStorage.map.size, 0)
    assert.equal(readCachedDeviceModelCatalog(fullStorage, t0 + 10_000)?.fresh, true)
  } finally {
    resetRuntimeSupportPackages()
  }
})

test('parseRuntimeDescriptorSvg matches all 12 bundled SVGs and strictly rejects unsafe or malformed cloud SVGs without breaking built-in models', () => {
  try {
    // 1. Every official bundled SVG parses with identical geometry, buttons, voice, and identities
    for (const file of readdirSync('public/device-descriptors').filter(name => name.endsWith('.svg'))) {
      const key = file.slice(0, -4)
      const raw = readFileSync(`public/device-descriptors/${file}`, 'utf8')
      const bundled = createDescriptorView(key)
      const parsed = parseRuntimeDescriptorSvg(raw, { kind: key })
      assert.deepEqual(parsed.remoteView.buttons, bundled.buttons)
      assert.deepEqual(parsed.remoteView.identities, bundled.identities)
      assert.deepEqual(parsed.remoteView.voice, bundled.voice)
      assert.deepEqual(parsed.remoteView.viewBox, bundled.viewBox)
      assert.deepEqual(parsed.remoteView.keyRegions, bundled.keyRegions)
      assert.ok(parsed.artworkUrl.startsWith('data:image/svg+xml;charset=utf-8,'))
    }

    // 2. Rejects XSS, external resources, XML entities/DOCTYPE, and invalid protocol schemas
    const valid = buildCustomRemoteSvg()
    const unsafeVariants = [
      valid.replace('</svg>', '<script>alert(1)</script></svg>'),
      valid.replace('</svg>', '<foreignObject width="10" height="10"><div>x</div></foreignObject></svg>'),
      valid.replace('<g id="ok-btn">', '<g id="ok-btn" onload="alert(1)">'),
      valid.replace('<g id="ok-btn">', '<g id="ok-btn" onclick=alert(1)>'),
      valid.replace('</svg>', '<image href="https://evil.invalid/spy.png" width="10" height="10" /></svg>'),
      valid.replace('</svg>', '<use xlink:href="http://evil.invalid/defs.svg#x" /></svg>'),
      valid.replace('fill="#e2e8f0"', 'fill="url(https://evil.invalid/p.svg#g)"'),
      valid.replace('</svg>', '<style>@import "https://evil.invalid/x.css";</style></svg>'),
      `<!DOCTYPE svg [<!ENTITY xxe "boom">]>\n${valid}`,
      valid.replace('确认键', '&xxe;'),
      valid.replace('data-ak-schema="axonkey.device/1"', 'data-ak-schema="axonkey.device/99"'),
      valid.replace('viewBox="0 0 240 520"', 'viewBox="0 0 0 520"'),
      valid.replace(/<ak:match[^>]+\/>/, ''),
      valid.replace('report="consumer"', 'report="nonexistent"'),
      valid.replace('data-ak-region="custom.remote.x.ok"', 'data-ak-region="wrong.id"'),
    ]
    for (const unsafe of unsafeVariants) {
      assert.throws(() => parseRuntimeDescriptorSvg(unsafe), 'must reject unsafe or malformed SVG')
    }

    // 3. Built-in rc003 keeps bundled RemoteView if cloud item has svg: null or unsafe/malformed SVG
    const bundledRc003 = bundledSupportPackages.find(p => p.kind === 'rc003')
    activateCatalogDeviceDescriptors([
      {
        id: 'm-rc003',
        code: 'rc003',
        name: 'Tampered RC003',
        model: 'RC003',
        brand_id: null,
        brand_name: '小米',
        description: '',
        tags: [],
        links: [],
        svg: valid.replace('</svg>', '<script>alert(1)</script></svg>'),
      },
      {
        id: 'm-cmiot',
        code: 'cmiotA15',
        name: 'CMIOT-A15',
        model: 'CMIOT-A15',
        brand_id: null,
        brand_name: '中国移动',
        description: '',
        tags: [],
        links: [],
        svg: null,
      },
    ])
    assert.equal(packageFor('rc003').artwork, bundledRc003.artwork)
    assert.equal(packageFor('rc003').remoteView, bundledRc003.remoteView)
    assert.equal(getSupportPackages().length, 13)

    // 3b. Built-in kivoK18Lite and xboxBluetooth preserve single-lane workspaceLayout & OLED screenRegion when overlaid from cloud SVG
    const kivoSvg = readFileSync('public/device-descriptors/kivo-k18-lite.svg', 'utf8')
    const xboxSvg = readFileSync('public/device-descriptors/xbox.svg', 'utf8')
    const bundledKivo = bundledSupportPackages.find(p => p.kind === 'kivoK18Lite')
    activateCatalogDeviceDescriptors([
      {
        id: 'm-kivo',
        code: 'kivoK18Lite',
        name: 'Kivo K18 Lite',
        model: 'K18 Lite',
        brand_id: 'b-kivo',
        brand_name: 'Kivo',
        description: '',
        tags: [],
        links: [],
        svg: kivoSvg,
      },
      {
        id: 'm-xbox',
        code: 'xboxBluetooth',
        name: 'Xbox 无线控制器',
        model: 'Xbox Wireless Controller',
        brand_id: 'b-xbox',
        brand_name: '微软 Xbox',
        description: '',
        tags: [],
        links: [],
        svg: xboxSvg,
      },
    ])
    const hydratedKivo = packageFor('kivoK18Lite')
    assert.ok(hydratedKivo.artwork.startsWith('data:image/svg+xml;charset=utf-8,'))
    assert.equal(hydratedKivo.workspaceLayout, 'single-lane')
    assert.equal(usesSingleLaneWorkspace('kivoK18Lite'), true)
    assert.deepEqual(hydratedKivo.screenRegion, bundledKivo.screenRegion)
    assert.equal(hydratedKivo.inputs.length, 18)
    assert.equal(usesSingleLaneWorkspace('xboxBluetooth'), true)

    // 4. Unknown cloud kind before hydration returns a safe non-crashing placeholder package
    const placeholder = packageFor('notYetLoadedCloudKind')
    assert.equal(placeholder.kind, 'notYetLoadedCloudKind')
    assert.ok(placeholder.artwork.startsWith('data:image/svg+xml;charset=utf-8,'))
  } finally {
    resetRuntimeSupportPackages()
  }
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

const require = createRequire(import.meta.url)
const text = node =>
  typeof node === 'string' ? node : (Array.isArray(node) ? node : (node?.children ?? [])).map(text).join('')
const flush = () => new Promise(resolve => setImmediate(resolve))

function createUiHarness({ native = false, storage, invokeImpl } = {}) {
  const invokeCalls = []
  const warnLogs = []
  const consoleWarns = []
  const openedWindows = []
  const windowTarget = Object.assign(new EventTarget(), {
    ...(native ? { __TAURI_INTERNALS__: {} } : {}),
    ...(storage ? { localStorage: storage } : {}),
    open(url, target, features) {
      openedWindows.push([url, target, features])
      return {}
    },
  })
  function compile(path, imports = {}) {
    const source = ts.transpileModule(
      readFileSync(path, 'utf8').replaceAll('import.meta.url', JSON.stringify(`file://${process.cwd()}/${path}`)),
      {
        compilerOptions: {
          module: ts.ModuleKind.CommonJS,
          target: ts.ScriptTarget.ES2020,
          jsx: ts.JsxEmit.ReactJSX,
        },
      },
    ).outputText
    const mod = { exports: {} }
    vm.runInNewContext(source, {
      module: mod,
      exports: mod.exports,
      URL,
      TextEncoder,
      TextDecoder,
      setTimeout: (...args) => globalThis.setTimeout(...args),
      clearTimeout: (...args) => globalThis.clearTimeout(...args),
      setInterval: (...args) => globalThis.setInterval(...args),
      clearInterval: (...args) => globalThis.clearInterval(...args),
      document: {
        getElementById: () => null,
        activeElement: null,
        body: {},
        hidden: false,
        addEventListener() {},
        removeEventListener() {},
      },
      HTMLElement: class {},
      window: windowTarget,
      console: {
        ...console,
        warn: (...args) => consoleWarns.push(args.join(' ')),
      },
      require: name => {
        if (name in imports) return imports[name]
        if (name === '@tauri-apps/api/core') {
          return {
            invoke: async (cmd, payload) => {
              invokeCalls.push([cmd, payload])
              return invokeImpl ? invokeImpl(cmd, payload) : undefined
            },
          }
        }
        if (name === '@tauri-apps/api/event') return { listen: async () => () => {} }
        if (name === '@tauri-apps/plugin-log') {
          return {
            info: async () => {},
            warn: async msg => warnLogs.push(msg),
            error: async () => {},
          }
        }
        if (name === 'react-dom') return { createPortal: node => node }
        if (name === 'reicon-react') return reiconReact
        if (name.endsWith('.css')) return {}
        return require(name)
      },
    })
    return mod.exports
  }

  const runtimeLogging = compile('src/runtimeLogging.ts')
  const openExternalMod = compile('src/openExternalUrl.ts', {
    './runtimeLogging.ts': runtimeLogging,
  })
  const descriptorSvgMod = compile('src/devices/shared/descriptorSvg.ts', {
    '../generatedDescriptors.ts': require('../src/devices/generatedDescriptors.ts'),
  })
  const xboxDefinition = compile('src/devices/xbox-controller/definition.ts', {
    './xbox-controller.svg': { default: 'controller.svg' },
    './inputs.ts': require('../src/devices/xbox-controller/inputs.ts'),
  })
  const model = compile('src/devices/integration/model.ts', {
    '../xiaomi-remote/definition.ts': require('../src/devices/xiaomi-remote/definition.ts'),
    '../cmiot-a15-remote/definition.ts': require('../src/devices/cmiot-a15-remote/definition.ts'),
    '../xm-bt-29-remote/definition.ts': require('../src/devices/xm-bt-29-remote/definition.ts'),
    '../rc-313-remote/definition.ts': require('../src/devices/rc-313-remote/definition.ts'),
    '../obe-rcu-r5-remote/definition.ts': require('../src/devices/obe-rcu-r5-remote/definition.ts'),
    '../tcl-rc802a-remote/definition.ts': require('../src/devices/tcl-rc802a-remote/definition.ts'),
    '../tcl-rc902n-remote/definition.ts': require('../src/devices/tcl-rc902n-remote/definition.ts'),
    '../tcl-rc902v-remote/definition.ts': require('../src/devices/tcl-rc902v-remote/definition.ts'),
    '../hisense-rcf3b65-remote/definition.ts': require('../src/devices/hisense-rcf3b65-remote/definition.ts'),
    '../phicomm-db1-r-remote/definition.ts': require('../src/devices/phicomm-db1-r-remote/definition.ts'),
    '../kivo-k18-lite/definition.ts': require('../src/devices/kivo-k18-lite/definition.ts'),
    '../g17-touch/definition.ts': require('../src/devices/g17-touch/definition.ts'),
    '../xbox-controller/index.ts': xboxDefinition,
    '../../appStorage.ts': require('../src/appStorage.ts'),
  })
  const catalogMod = compile('src/cloud/deviceModelCatalog.ts', {
    '../devices/bundledModelCatalog.json': JSON.parse(readFileSync('src/devices/bundledModelCatalog.json', 'utf8')),
    '../devices/integration/model.ts': model,
    '../devices/shared/descriptorSvg.ts': descriptorSvgMod,
    '../openExternalUrl.ts': openExternalMod,
    '../runtimeLogging.ts': runtimeLogging,
    './relayClient.ts': require('../src/cloud/relayClient.ts'),
  })
  const useCatalogMod = compile('src/cloud/useDeviceModelCatalog.ts', {
    './deviceModelCatalog.ts': catalogMod,
  })
  const behaviorLibraryContext = compile('src/cloud/BehaviorLibraryContext.tsx')
  const modelMarkdownMod = compile('src/devices/integration/ModelMarkdown.tsx', {
    '../../openExternalUrl': openExternalMod,
  })
  const remoteControlMod = compile('src/devices/shared/RemoteControl.tsx', {
    '../../appStorage.ts': require('../src/appStorage.ts'),
    '../xiaomi-remote/view.ts': require('../src/devices/xiaomi-remote/view.ts'),
  })
  const controls = compile('src/devices/integration/IntegrationControls.tsx')
  const battery = compile('src/components/BatteryIndicator.tsx')
  const deviceHubMod = compile('src/devices/integration/DeviceHub.tsx', {
    '../../appStorage': require('../src/appStorage.ts'),
    '../../cloud/BehaviorLibraryContext': behaviorLibraryContext,
    '../../cloud/useDeviceModelCatalog': useCatalogMod,
    './InstanceWorkspace': { InstanceWorkspace: props => React.createElement('instance-workspace', props) },
    './IntegrationControls': controls,
    './ModelMarkdown': modelMarkdownMod,
    '../../components/BatteryIndicator': battery,
    './model': model,
  })
  return {
    invokeCalls,
    warnLogs,
    consoleWarns,
    openedWindows,
    BehaviorLibraryContext: behaviorLibraryContext.BehaviorLibraryContext,
    ModelMarkdown: modelMarkdownMod.ModelMarkdown,
    RemoteControl: remoteControlMod.RemoteControl,
    DeviceHub: deviceHubMod.DeviceHub,
    DeviceDiscoverySection: deviceHubMod.DeviceDiscoverySection,
    model,
    catalogMod,
    useCatalogMod,
  }
}

test('ModelMarkdown renders headings, lists, code, emphasis, and safe links while neutralizing XSS and raw HTML', async () => {
  assert.doesNotMatch(readFileSync('src/devices/integration/ModelMarkdown.tsx', 'utf8'), /dangerouslySetInnerHTML/)
  assert.doesNotMatch(readFileSync('src/devices/integration/DeviceHub.tsx', 'utf8'), /dangerouslySetInnerHTML/)

  const h = createUiHarness({ native: true })
  const markdown = [
    '# 硬件参数',
    '型号代号 OBE_RCU_R5，支持 **低功耗蓝牙** 与 *红外学习*，命令示例 `axonkey-cli list`。',
    '第二行自动换行',
    '',
    '- 供电：2 节 7 号电池',
    '- 参考：[官方文档](https://relay.wleo.cn/docs/OBE_(RCU)) 与 [危险链接](javascript:alert(1))',
    '',
    '1. 打开蓝牙设置',
    '2. 配对遥控器',
    '',
    '> 提示：<script>alert("xss")</script> <img src=x onerror=alert(1)>',
    '',
    '```',
    'vid=0x2717 pid=0x32b9',
    '```',
  ].join('\n')

  let view
  act(() => {
    view = Renderer.create(React.createElement(h.ModelMarkdown, { markdown, native: true }))
  })
  try {
    assert.equal(text(view.root.findByType('h4')), '硬件参数')
    assert.equal(text(view.root.findByType('strong')), '低功耗蓝牙')
    assert.equal(text(view.root.findByType('em')), '红外学习')
    assert.match(text(view.root.findByType('p')), /型号代号 OBE_RCU_R5/)
    assert.equal(view.root.findByType('p').findAllByType('br').length, 1)
    assert.equal(view.root.findByType('ul').findAllByType('li').length, 2)
    assert.equal(view.root.findByType('ol').findAllByType('li').length, 2)
    assert.match(text(view.root.findByType('pre')), /vid=0x2717 pid=0x32b9/)

    assert.equal(view.root.findAllByType('script').length, 0)
    assert.equal(view.root.findAllByType('img').length, 0)
    assert.match(text(view.root.findByType('blockquote')), /<script>alert\("xss"\)<\/script>/)

    const anchors = view.root.findAllByType('a')
    assert.equal(anchors.length, 1)
    assert.equal(anchors[0].props.href, 'https://relay.wleo.cn/docs/OBE_(RCU)')
    assert.equal(text(anchors[0]), '官方文档')
    assert.match(text(view.root.findByType('ul')), /危险链接/)
    assert.doesNotMatch(text(view.root.findByType('ul')), /javascript:/)

    let prevented = false
    let stopped = false
    await act(async () => {
      anchors[0].props.onClick({
        preventDefault() {
          prevented = true
        },
        stopPropagation() {
          stopped = true
        },
      })
      await flush()
    })
    assert.equal(prevented && stopped, true)
    assert.deepEqual(JSON.parse(JSON.stringify(h.invokeCalls)), [
      ['open_external_url', { url: 'https://relay.wleo.cn/docs/OBE_(RCU)' }],
    ])
  } finally {
    act(() => view.unmount())
  }
})

test('IntegrationDialog Scheme A hydrates offline bundled catalog, upgrades to cloud models + dynamic SVG models, and syncs native descriptors', async () => {
  const storage = createStorage()
  let refreshCount = 0
  const h = createUiHarness({
    native: true,
    storage,
    invokeImpl: async cmd => {
      if (cmd === 'sync_cloud_device_descriptors') return { applied: 1, rejected: [], changed: true }
      return undefined
    },
  })
  let resolveCatalog
  const catalogRequests = []
  const client = new RelayClient(
    async (method, path, _body, token) => {
      catalogRequests.push({ method, path, token })
      return new Promise(resolve => {
        resolveCatalog = resolve
      })
    },
    activeSession(),
    () => {},
  )

  const snapshot = h.model.emptySnapshot()
  const savedInstances = []
  const controller = {
    snapshot,
    error: '',
    busy: false,
    refresh: async () => {
      refreshCount++
      return snapshot
    },
    reorder: async () => {},
    refreshInformation: async () => {},
    put: async instance => {
      const saved = { ...instance, id: `inst-${savedInstances.length + 1}` }
      savedInstances.push(saved)
      snapshot.store.instances = [...savedInstances]
      return snapshot
    },
  }

  let selectedInstanceId = null
  const renderTree = (accountReady = false) =>
    React.createElement(
      h.BehaviorLibraryContext.Provider,
      {
        value: {
          client,
          userId: 'user-1',
          accountReady,
          onLogin() {},
        },
      },
      React.createElement(h.DeviceHub, {
        selectedInstanceId,
        onSelectInstance: id => {
          selectedInstanceId = id
        },
        controller,
        native: false,
        platform: 'macos',
        permissions: { accessibility: true, inputMonitoring: true },
        onBrandClick() {},
        onPermissions() {},
        onLegacy() {},
        onOpenAudioCalibration() {},
        onOpenAudioDriver() {},
        onOpenBluetoothSettings() {},
        onOpenDeviceManager() {},
        driverAction: null,
        onInstallDriver() {},
        onUnbindDevice: async () => {},
        onRemoveDevice: async () => {},
        mouseProfileName: '默认配置',
      }),
    )

  const modal = { showModal() {}, close() {} }
  let view
  await act(async () => {
    view = Renderer.create(renderTree(false), {
      createNodeMock: node => (node.type === 'dialog' ? modal : null),
    })
  })

  try {
    // 1. Before accountReady flips true, offline bundledModelCatalog.json is ALREADY synchronously hydrated!
    const openAddBtn = view.root.findAllByType('button').find(b => text(b).includes('手动添加设备'))
    await act(async () => {
      openAddBtn.props.onClick()
    })
    assert.equal(text(view.root.findByProps({ id: 'managed-integration-title' })), '添加设备')
    assert.equal(catalogRequests.length, 0, 'waits for accountReady before firing catalog request')
    const detailPane = () => view.root.findByProps({ className: 'managed-catalog-detail' })
    assert.match(text(detailPane()), /Win \/ macOS/, 'shows offline curated rc003 tags immediately')
    assert.ok(
      view.root.findByProps({ 'aria-label': '按品牌筛选' }).findAllByType('button').length >= 6,
      'shows curated brand filter pills immediately from bundled snapshot',
    )
    const nextBtn = () => view.root.findByProps({ className: 'managed-primary' })
    assert.equal(text(nextBtn()), '下一步')
    assert.equal(nextBtn().props.disabled, false)

    // 2. Flip accountReady -> true: authenticated catalog request fires with include_svg=1 and Bearer token
    await act(async () => {
      view.update(renderTree(true))
      await flush()
    })
    assert.deepEqual(catalogRequests, [
      { method: 'GET', path: '/v2/device-models?app_id=axonkey&include_svg=1', token: 'access-token-1' },
    ])

    // 3. Resolve cloud catalog including a brand-new cloud model customRemoteX with axonkey.device/1 SVG
    const customRemoteSvg = buildCustomRemoteSvg({
      deviceId: 'custom.remote.x',
      model: 'CR-X1',
      displayName: '极客遥控器 X1',
    })
    await act(async () => {
      resolveCatalog({
        status: 200,
        body: {
          cache_ttl_seconds: 1800,
          items: [
            {
              id: 'm-rc003',
              code: 'rc003',
              name: '小米蓝牙遥控器2Pro',
              model: 'RC003',
              brand_name: '小米',
              description: '支持 **BLE 语音** 与红外电源键。',
              tags: ['蓝牙语音', '7号电池'],
              links: [
                { label: '京东自营', url: 'https://item.jd.com/1000123.html' },
                { label: '小米商城', url: 'https://www.mi.com/buy/rc003' },
              ],
            },
            {
              id: 'm-tcl802a',
              code: 'tclRc802a',
              name: 'TCL RC802A',
              model: 'RC802A',
              brand_name: 'TCL',
              description: '适配 TCL 智能电视语音遥控器，详见 [规格页](https://www.tcl.com/rc802a)。',
              tags: [],
              links: [{ label: '官方配件店', url: 'https://shop.tcl.com/rc802a' }],
            },
            {
              id: 'm-custom-x',
              code: 'customRemoteX',
              name: '极客遥控器 X1',
              model: 'CR-X1',
              brand_name: '极客外设',
              description: '支持 **云端热下发** 按键热区与 HID 映射。',
              tags: ['云端上新', 'Win / macOS'],
              links: [{ label: '极客官网', url: 'https://geekgear.example.com/cr-x1' }],
              has_svg: true,
              svg: customRemoteSvg,
            },
          ],
        },
      })
      await flush()
    })

    // Native mode check via a quick DeviceDiscoverySection mount with native:true confirms sync_cloud_device_descriptors IPC
    let nativeProbe
    await act(async () => {
      nativeProbe = Renderer.create(
        React.createElement(
          h.BehaviorLibraryContext.Provider,
          { value: { client, userId: 'user-1', accountReady: true, onLogin() {} } },
          React.createElement(h.DeviceHub, {
            selectedInstanceId: null,
            onSelectInstance() {},
            controller,
            native: true,
            platform: 'macos',
            permissions: { accessibility: true, inputMonitoring: true },
            onBrandClick() {},
            onPermissions() {},
            onLegacy() {},
            onOpenAudioCalibration() {},
            onOpenAudioDriver() {},
            onOpenBluetoothSettings() {},
            onOpenDeviceManager() {},
            driverAction: null,
            onInstallDriver() {},
            onUnbindDevice: async () => {},
            onRemoveDevice: async () => {},
            mouseProfileName: '默认配置',
          }),
        ),
        { createNodeMock: node => (node.type === 'dialog' ? modal : null) },
      )
      await flush()
    })
    try {
      const openNativeAdd = nativeProbe.root.findAllByType('button').find(b => text(b).includes('手动添加设备'))
      await act(async () => {
        openNativeAdd.props.onClick()
        await flush()
      })
      const syncCall = h.invokeCalls.find(([cmd]) => cmd === 'sync_cloud_device_descriptors')
      assert.ok(syncCall, 'syncs cloud SVG descriptors to Tauri native registry')
      assert.equal(syncCall[1].descriptors.length, 1)
      assert.equal(syncCall[1].descriptors[0].kind, 'customRemoteX')
      assert.ok(refreshCount >= 1, 'refreshes native device snapshot when descriptors change')
    } finally {
      act(() => nativeProbe.unmount())
    }

    // 4. Right panel displays cloud rc003 tags, Markdown, and external links
    assert.deepEqual(detailPane().findByProps({ 'aria-label': '型号标签' }).findAllByType('li').map(text), [
      '蓝牙语音',
      '7号电池',
    ])
    assert.match(text(detailPane()), /BLE 语音/)
    const rc003Links = detailPane().findByProps({ 'aria-label': '购买与参考链接' }).findAllByType('a')
    assert.equal(rc003Links.length, 2)

    await act(async () => {
      rc003Links[0].props.onClick({ preventDefault() {}, stopPropagation() {} })
      await flush()
    })
    assert.deepEqual(h.openedWindows, [['https://item.jd.com/1000123.html', '_blank', 'noopener,noreferrer']])

    // 5. Brand pills include dynamic cloud brand "极客外设" and filter to customRemoteX
    const brandGroup = view.root.findByProps({ 'aria-label': '按品牌筛选' })
    assert.deepEqual(brandGroup.findAllByType('button').map(text), ['全部', '小米', 'TCL', '极客外设'])
    const packageCards = () =>
      view.root
        .findByProps({ className: 'managed-catalog-list-pane' })
        .findAll(node => node.type === 'button' && node.props.className === 'managed-package')
    assert.equal(packageCards().length, 14, '13 bundled + 1 dynamic cloud model')

    act(() => {
      brandGroup
        .findAllByType('button')
        .find(b => text(b) === '极客外设')
        .props.onClick()
    })
    assert.equal(packageCards().length, 1)
    assert.equal(packageCards()[0].props['data-kind'], 'customRemoteX')
    assert.match(text(detailPane()), /云端热下发/)

    // 6. Verify packageFor('customRemoteX') and RemoteControl render interactive key regions cleanly
    const customPkg = h.model.packageFor('customRemoteX')
    assert.equal(customPkg.name, '极客遥控器 X1')
    assert.equal(customPkg.model, 'CR-X1')
    assert.equal(customPkg.inputs.length, 2)
    assert.ok(customPkg.artwork.startsWith('data:image/svg+xml;charset=utf-8,'))

    let remoteControlView
    let clickedKey = null
    act(() => {
      remoteControlView = Renderer.create(
        React.createElement(h.RemoteControl, {
          activeId: 'custom.remote.x.ok',
          mappedIds: ['custom.remote.x.ok'],
          onSelect: id => {
            clickedKey = id
          },
          remoteView: customPkg.remoteView,
        }),
      )
    })
    try {
      const keyButtons = remoteControlView.root.findAll(
        node => node.type === 'g' && node.props.role === 'button' && node.props['data-remote-key'],
      )
      assert.deepEqual(
        keyButtons.map(node => node.props['data-remote-key']),
        ['custom.remote.x.ok', 'custom.remote.x.back'],
      )
      act(() => keyButtons[1].props.onClick())
      assert.equal(clickedKey, 'custom.remote.x.back')
    } finally {
      act(() => remoteControlView.unmount())
    }

    // 7. Reset brand filter, test search, integrate customRemoteX
    act(() => {
      brandGroup
        .findAllByType('button')
        .find(b => text(b) === '全部')
        .props.onClick()
    })
    const searchInput = view.root.findByProps({ 'aria-label': '搜索设备型号' })
    act(() => {
      searchInput.props.onChange({ target: { value: '云端上新' } })
    })
    assert.deepEqual(
      packageCards().map(c => c.props['data-kind']),
      ['customRemoteX'],
    )
    act(() => {
      view.root.findByProps({ 'aria-label': '清空搜索' }).props.onClick()
    })

    // Select a model omitted from cloud response (hisenseRcf3b65): shows quiet empty state
    act(() => {
      packageCards()
        .find(c => c.props['data-kind'] === 'hisenseRcf3b65')
        .props.onClick()
    })
    assert.match(text(detailPane()), /暂无型号详细介绍，可直接继续添加设备/)

    // Double-click customRemoteX -> advances to Step 2 and integrates cleanly
    act(() => {
      packageCards()
        .find(c => c.props['data-kind'] === 'customRemoteX')
        .props.onDoubleClick()
    })
    const nameInput = () => view.root.findByType('input')
    assert.equal(nameInput().props.value, '极客遥控器 X1')

    await act(async () => {
      view.root.findByProps({ className: 'managed-primary' }).props.onClick()
    })
    assert.equal(savedInstances.length, 1)
    assert.equal(savedInstances[0].kind, 'customRemoteX')
    assert.equal(savedInstances[0].name, '极客遥控器 X1')
    assert.equal(selectedInstanceId, 'inst-1')
  } finally {
    act(() => view.unmount())
  }
})

test('Step 2 opened directly from a discovered device exposes cached model details toggle without 更换型号 button', () => {
  const storage = createStorage()
  const h = createUiHarness({ native: true, storage })
  h.catalogMod.writeCachedDeviceModelCatalog(
    [
      {
        id: 'm-rc003',
        code: 'rc003',
        name: '小米蓝牙遥控器2Pro',
        model: 'RC003',
        brand_id: null,
        brand_name: '小米',
        description: '蓝牙与红外双模遥控器',
        tags: ['低功耗蓝牙'],
        links: [{ label: '官方购买', url: 'https://www.mi.com/rc003' }],
      },
    ],
    storage,
  )
  const discovered = {
    id: 'ble-rc003-1',
    kind: 'rc003',
    name: 'Xiaomi RC',
    transport: 'Bluetooth',
    identityQuality: 'serial',
    vendorId: 0x2717,
    productId: 0x32b9,
    connected: true,
    paired: true,
  }
  const snapshot = { ...h.model.emptySnapshot(), discovered: [discovered] }
  let view
  act(() => {
    view = Renderer.create(
      React.createElement(h.DeviceDiscoverySection, {
        controller: { snapshot, error: '', busy: false, refresh: async () => snapshot, put: async () => snapshot },
        native: true,
        platform: 'macos',
        permissions: { accessibility: true, inputMonitoring: true },
        onPermissions() {},
        onIntegrated() {},
      }),
      { createNodeMock: node => (node.type === 'dialog' ? { showModal() {}, close() {} } : null) },
    )
  })
  try {
    act(() => {
      view.root.find(node => node.type === 'button' && node.props['data-discovered']).props.onClick()
    })
    assert.equal(
      view.root.findAllByType('button').filter(b => text(b) === '更换型号').length,
      0,
      'discovered hardware dialog does not show manual model switcher',
    )
    const toggle = view.root.findByProps({ className: 'managed-model-info-toggle' })
    act(() => toggle.props.onClick())
    const panel = view.root.findByProps({ className: 'managed-details-catalog-panel' })
    assert.match(text(panel), /蓝牙与红外双模遥控器/)
    assert.match(text(panel), /官方购买/)
  } finally {
    act(() => view.unmount())
  }

  const css = readFileSync('src/devices/integration/DeviceHub.css', 'utf8')
  assert.match(css, /\.macos-vibrancy\s+\.managed-integration-dialog/)
  assert.match(css, /\.managed-catalog-picker[\s\S]*?min-height:\s*0/)
})

test('forceRefresh pulls newly Console-added minimal button-only models immediately within TTL and aligns Windows driver support', async () => {
  const storage = createStorage()
  resetRuntimeSupportPackages()
  let requestCount = 0
  const vendorUsbMiniPadSvg = `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg"
     xmlns:ak="urn:axonkey:device:1"
     width="240" height="240" viewBox="0 0 240 240"
     data-ak-schema="axonkey.device/1"
     data-ak-device="acme.usb-pad"
     data-ak-revision="1"
     data-ak-status="active">
  <metadata>
    <ak:device schema="axonkey.device/1" id="acme.usb-pad" vendor="Acme" model="UP-2" revision="1" display-name="Acme 免驱按键板" status="active">
      <ak:identity>
        <ak:match transport="usb-hid" vid="0x2E8A" pid="0xB010" usage-page="0xFF60" usage="0x01" required="true" />
      </ak:identity>
      <ak:reports>
        <ak:report id="captured-buttons" direction="input" report-id="0x01" length="4" encoding="bit-field" prefix="0x01" state-group="captured-buttons" />
      </ak:reports>
      <ak:inputs>
        <ak:input id="acme.usb-pad.k1" label="按键 1" short="K1" icon="center" kind="button" target="#k1" order="0" original="false" binding="captured"><ak:source report="captured-buttons" offset="1" bit="0" width="8" equals="0x01" /></ak:input>
      </ak:inputs>
    </ak:device>
  </metadata>
  <g id="k1"><rect x="20" y="20" width="80" height="80" /></g>
  <path data-ak-region="acme.usb-pad.k1" data-ak-anchor="60 60" d="M20 20h80v80h-80z" />
</svg>`
  const btMiniRemoteSvg = buildCustomRemoteSvg({
    deviceId: 'acme.bt-mini',
    model: 'BM-2',
    displayName: 'Acme 蓝牙双键器',
    vid: '0x2B11',
    pid: '0x9922',
  }).replace(' windows-prefix="BTHLEDEVICE"', '')

  let cloudItems = getBundledDeviceModelCatalog()
  const client = new RelayClient(
    async () => {
      requestCount += 1
      return { status: 200, body: { cache_ttl_seconds: 3600, items: cloudItems } }
    },
    null,
    () => {},
  )

  try {
    const t0 = 1_700_000_000_000
    const initial = await loadDeviceModelCatalog(client, storage, t0)
    assert.equal(requestCount, 1)
    assert.equal(initial.length, 14)

    // Admin adds two minimal button-only models in Relay Console 10 seconds later (well inside 3600s TTL)
    cloudItems = [
      ...cloudItems,
      {
        id: 'model-usb-pad',
        code: 'acmeUsbPad',
        name: 'Acme 免驱按键板',
        model: 'UP-2',
        brand_id: null,
        brand_name: 'Acme',
        description: 'USB 免驱双键板',
        tags: ['1 键', 'USB-C 免驱', '仅按键映射'],
        links: [],
        has_svg: true,
        svg: vendorUsbMiniPadSvg,
      },
      {
        id: 'model-bt-mini',
        code: 'acmeBtMini',
        name: 'Acme 蓝牙双键器',
        model: 'BM-2',
        brand_id: null,
        brand_name: 'Acme',
        description: '蓝牙纯按键遥控器',
        tags: ['2 键', '蓝牙 HID', '仅按键映射'],
        links: [],
        has_svg: true,
        svg: btMiniRemoteSvg,
      },
    ]

    // Passive load within TTL still serves cache
    const cachedLoad = await loadDeviceModelCatalog(client, storage, t0 + 10_000)
    assert.equal(requestCount, 1)
    assert.equal(cachedLoad.length, 14)

    // Explicit user refresh (`forceRefresh: true`) bypasses TTL and activates new models immediately
    const refreshed = await loadDeviceModelCatalog(client, storage, t0 + 10_000, { forceRefresh: true })
    assert.equal(requestCount, 2)
    assert.equal(refreshed.length, 16)

    assert.equal(packageFor('acmeUsbPad').name, 'Acme 免驱按键板')
    assert.equal(packageFor('acmeUsbPad').inputs.length, 1)
    assert.equal(supportsWindowsDriver('acmeUsbPad'), false, 'vendor USB HID 0xFF60 should be driverless on Windows')
    assert.equal(supportsWindowsDriver('acmeBtMini'), true, 'Bluetooth HID without windows-prefix still uses Quarbor on Windows')

    const created = newInstance('acmeUsbPad', 'phys-usb-pad-1')
    assert.equal(created.kind, 'acmeUsbPad')
    assert.equal(created.name, 'Acme 免驱按键板')
    assert.equal(created.binding, 'phys-usb-pad-1')
  } finally {
    resetRuntimeSupportPackages()
    clearDeviceModelCatalogCache(storage)
  }
})

test('local custom-devices overriding cloud SVG emits warn logs and displays actionable UI warnings in DeviceHub and IntegrationDialog', async () => {
  const storage = createStorage()
  let localEntries = [
    {
      kind: 'customRemoteX',
      deviceId: 'custom.remote.x',
      name: '极客遥控器 X1（本地改版）',
      model: 'CR-X1',
      vendor: 'Geek',
      svg: buildCustomRemoteSvg({
        deviceId: 'custom.remote.x',
        model: 'CR-X1',
        displayName: '极客遥控器 X1（本地改版）',
      }),
      filePath: '/Users/test/Library/Application Support/com.axonkey.app/custom-devices/custom.remote.x.svg',
    },
  ]

  const h = createUiHarness({
    native: true,
    storage,
    invokeImpl: async cmd => {
      if (cmd === 'list_local_custom_devices') return localEntries
      if (cmd === 'sync_cloud_device_descriptors') return { applied: 1, rejected: [], changed: true }
      if (cmd === 'open_local_custom_devices_dir') return '/Users/test/Library/Application Support/com.axonkey.app/custom-devices'
      return undefined
    },
  })
  h.useCatalogMod.resetNativeDescriptorSyncCache()

  const cloudSvg = buildCustomRemoteSvg({
    deviceId: 'custom.remote.x',
    model: 'CR-X1',
    displayName: '极客遥控器 X1',
  })
  const cloudItems = [
    {
      id: 'm-custom-x',
      code: 'customRemoteX',
      name: '极客遥控器 X1',
      model: 'CR-X1',
      brand_id: null,
      brand_name: '极客外设',
      description: '云端下发版本',
      tags: ['云端上新'],
      links: [],
      has_svg: true,
      svg: cloudSvg,
    },
  ]
  const client = new RelayClient(
    async () => ({ status: 200, body: { cache_ttl_seconds: 600, items: cloudItems } }),
    activeSession(),
    () => {},
  )

  const overrides = h.catalogMod.findLocalCloudDescriptorOverrides(cloudItems, localEntries)
  assert.equal(overrides.length, 1)
  assert.equal(overrides[0].kind, 'customRemoteX')
  assert.equal(overrides[0].differsFromCloud, true)
  const merged = h.catalogMod.mergeCatalogWithLocalCustomDevices(cloudItems, localEntries)
  assert.ok(merged[0].tags.includes('覆盖云端'))

  const snapshot = h.model.emptySnapshot()
  const controller = {
    snapshot,
    error: '',
    busy: false,
    refresh: async () => snapshot,
    reorder: async () => {},
    refreshInformation: async () => {},
    put: async () => snapshot,
  }

  let view
  try {
    await act(async () => {
      view = Renderer.create(
        React.createElement(
          h.BehaviorLibraryContext.Provider,
          { value: { client, userId: 'user-1', accountReady: true, onLogin() {} } },
          React.createElement(h.DeviceHub, {
            selectedInstanceId: null,
            onSelectInstance() {},
            controller,
            native: true,
            platform: 'macos',
            permissions: { accessibility: true, inputMonitoring: true },
            onBrandClick() {},
            onPermissions() {},
            onLegacy() {},
            onOpenAudioCalibration() {},
            onOpenAudioDriver() {},
            onOpenBluetoothSettings() {},
            onOpenDeviceManager() {},
            driverAction: null,
            onInstallDriver() {},
            onUnbindDevice: async () => {},
            onRemoveDevice: async () => {},
            mouseProfileName: '默认配置',
          }),
        ),
        { createNodeMock: node => (node.type === 'dialog' ? { showModal() {}, close() {} } : null) },
      )
      await flush()
    })

    // Emits console.warn + plugin-log warn
    assert.ok(
      h.consoleWarns.some(msg => msg.includes('customRemoteX') && msg.includes('custom.remote.x.svg')),
      'emits console.warn mentioning overridden kind and file path',
    )
    assert.ok(
      h.warnLogs.some(msg => msg.includes('customRemoteX') && msg.includes('覆盖')),
      'emits native plugin-log warn',
    )

    // Home page shows warning banner with 打开本机目录 action
    const homeWarnings = view.root.findAll(node => node.props?.className === 'managed-warning')
    assert.equal(homeWarnings.length, 1)
    assert.match(text(homeWarnings[0]), /极客遥控器 X1（本地改版）/)
    assert.match(text(homeWarnings[0]), /覆盖/)

    await act(async () => {
      homeWarnings[0].findByType('button').props.onClick()
      await flush()
    })
    assert.ok(h.invokeCalls.some(([cmd]) => cmd === 'open_local_custom_devices_dir'))

    // IntegrationDialog shows 覆盖云端 tag and detail pane warning
    const openAddBtn = view.root.findAllByType('button').find(b => text(b).includes('手动添加设备'))
    await act(async () => {
      openAddBtn.props.onClick()
      await flush()
    })
    const customCard = view.root
      .findByProps({ className: 'managed-catalog-list-pane' })
      .findAllByType('button')
      .find(b => b.props['data-kind'] === 'customRemoteX')
    act(() => {
      customCard.props.onClick()
    })
    const detailPane = view.root.findByProps({ className: 'managed-catalog-detail' })
    assert.ok(text(detailPane).includes('覆盖云端'))
    assert.equal(detailPane.findAll(node => node.props?.className === 'managed-warning').length, 1)

    // Removing the local custom file and clicking refresh clears the warning and restores cloud model
    localEntries = []
    const refreshBtn = view.root.findByProps({ 'aria-label': '刷新型号列表' })
    await act(async () => {
      refreshBtn.props.onClick()
      await flush()
    })
    assert.equal(view.root.findAll(node => node.props?.className === 'managed-warning').length, 0)
    assert.equal(h.model.getLocalCloudDescriptorOverrides().length, 0)
  } finally {
    if (view) act(() => view.unmount())
    h.catalogMod.resetLocalCustomDevicesForTest()
    h.model.resetRuntimeSupportPackages()
    h.catalogMod.clearDeviceModelCatalogCache(storage)
    h.useCatalogMod.resetNativeDescriptorSyncCache()
  }
})
