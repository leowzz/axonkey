import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import test from 'node:test'
import vm from 'node:vm'
import React from 'react'
import Renderer, { act } from 'react-test-renderer'
import * as reiconReact from 'reicon-react'
import ts from 'typescript'
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

const require = createRequire(import.meta.url)
const text = node =>
  typeof node === 'string' ? node : (Array.isArray(node) ? node : (node?.children ?? [])).map(text).join('')
const flush = () => new Promise(resolve => setImmediate(resolve))

function createUiHarness({ native = false, storage } = {}) {
  const invokeCalls = []
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
      setTimeout: (...args) => globalThis.setTimeout(...args),
      clearTimeout: (...args) => globalThis.clearTimeout(...args),
      setInterval: (...args) => globalThis.setInterval(...args),
      clearInterval: (...args) => globalThis.clearInterval(...args),
      document: { getElementById: () => null, activeElement: null, body: {} },
      HTMLElement: class {},
      window: windowTarget,
      require: name => {
        if (name in imports) return imports[name]
        if (name === '@tauri-apps/api/core') {
          return {
            invoke: async (cmd, payload) => {
              invokeCalls.push([cmd, payload])
            },
          }
        }
        if (name === '@tauri-apps/api/event') return { listen: async () => () => {} }
        if (name === '@tauri-apps/plugin-log') return { info: async () => {}, error: async () => {} }
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
  const catalogMod = compile('src/cloud/deviceModelCatalog.ts', {
    '../openExternalUrl.ts': openExternalMod,
    './relayClient.ts': require('../src/cloud/relayClient.ts'),
  })
  const useCatalogMod = compile('src/cloud/useDeviceModelCatalog.ts', {
    './deviceModelCatalog.ts': catalogMod,
  })
  const behaviorLibraryContext = compile('src/cloud/BehaviorLibraryContext.tsx')
  const modelMarkdownMod = compile('src/devices/integration/ModelMarkdown.tsx', {
    '../../openExternalUrl': openExternalMod,
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
    '../xbox-controller/index.ts': xboxDefinition,
  })
  const controls = compile('src/devices/integration/IntegrationControls.tsx')
  const battery = compile('src/components/BatteryIndicator.tsx')
  const deviceHubMod = compile('src/devices/integration/DeviceHub.tsx', {
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
    openedWindows,
    BehaviorLibraryContext: behaviorLibraryContext.BehaviorLibraryContext,
    ModelMarkdown: modelMarkdownMod.ModelMarkdown,
    DeviceHub: deviceHubMod.DeviceHub,
    DeviceDiscoverySection: deviceHubMod.DeviceDiscoverySection,
    model,
    catalogMod,
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
    // OBE_RCU_R5 underscores must remain intact and never split into <em>RCU</em>
    assert.match(text(view.root.findByType('p')), /型号代号 OBE_RCU_R5/)
    assert.equal(view.root.findByType('p').findAllByType('br').length, 1)
    assert.equal(view.root.findByType('ul').findAllByType('li').length, 2)
    assert.equal(view.root.findByType('ol').findAllByType('li').length, 2)
    assert.match(text(view.root.findByType('pre')), /vid=0x2717 pid=0x32b9/)

    // Raw HTML tags are escaped as plain text; zero script/img DOM nodes exist
    assert.equal(view.root.findAllByType('script').length, 0)
    assert.equal(view.root.findAllByType('img').length, 0)
    assert.match(text(view.root.findByType('blockquote')), /<script>alert\("xss"\)<\/script>/)

    // Only the HTTPS link renders an <a>; javascript:alert(1) is stripped to plain label text
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

test('IntegrationDialog Scheme A supports brand/search filtering, tags, Markdown, external links, back navigation, and integration', async () => {
  const storage = createStorage()
  const h = createUiHarness({ native: false, storage })
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
    refresh: async () => snapshot,
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
    // Open manual add while accountReady is still false: dialog opens immediately and never blocks
    const openAddBtn = view.root.findAllByType('button').find(b => text(b).includes('手动添加设备'))
    await act(async () => {
      openAddBtn.props.onClick()
    })
    assert.equal(catalogRequests.length, 0, 'waits for accountReady before firing catalog request')
    const detailPane = () => view.root.findByProps({ className: 'managed-catalog-detail' })
    assert.match(text(detailPane()), /加载型号说明中/)
    assert.equal(view.root.findAllByProps({ 'aria-label': '按品牌筛选' }).length, 0, 'hides brand pills until brands exist')
    const nextBtn = () => view.root.findByProps({ className: 'managed-primary' })
    assert.equal(text(nextBtn()), '下一步')
    assert.equal(nextBtn().props.disabled, false, 'slow network never blocks advancing')

    // Flip accountReady -> true: authenticated catalog request fires with Bearer token
    await act(async () => {
      view.update(renderTree(true))
      await flush()
    })
    assert.deepEqual(catalogRequests, [
      { method: 'GET', path: '/v2/device-models?app_id=axonkey', token: 'access-token-1' },
    ])

    // Resolve catalog with brands, tags, Markdown description, and purchase links
    await act(async () => {
      resolveCatalog({
        status: 200,
        body: {
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
          ],
        },
      })
      await flush()
    })

    // Right panel immediately displays pre-selected rc003 tags, Markdown, and links
    assert.deepEqual(
      detailPane()
        .findByProps({ 'aria-label': '型号标签' })
        .findAllByType('li')
        .map(text),
      ['蓝牙语音', '7号电池'],
    )
    assert.match(text(detailPane()), /BLE 语音/)
    const rc003Links = detailPane().findByProps({ 'aria-label': '购买与参考链接' }).findAllByType('a')
    assert.equal(rc003Links.length, 2)
    assert.match(text(rc003Links[0]), /京东自营/)
    assert.match(text(rc003Links[0]), /jd\.com/)

    // Clicking purchase link opens external browser WITHOUT closing or advancing the dialog
    await act(async () => {
      rc003Links[0].props.onClick({ preventDefault() {}, stopPropagation() {} })
      await flush()
    })
    assert.deepEqual(h.openedWindows, [['https://item.jd.com/1000123.html', '_blank', 'noopener,noreferrer']])
    assert.equal(view.root.findAllByProps({ className: 'managed-catalog-picker' }).length, 1)

    // Filter by brand pill "TCL": left grid narrows and right panel switches to TCL RC802A (empty tags omitted!)
    const brandGroup = view.root.findByProps({ 'aria-label': '按品牌筛选' })
    assert.deepEqual(brandGroup.findAllByType('button').map(text), ['全部', '小米', 'TCL'])
    act(() => {
      brandGroup.findAllByType('button').find(b => text(b) === 'TCL').props.onClick()
    })
    const packageCards = () =>
      view.root
        .findByProps({ className: 'managed-catalog-list-pane' })
        .findAll(node => node.type === 'button' && node.props.className === 'managed-package')
    assert.equal(packageCards().length, 1)
    assert.equal(packageCards()[0].props['data-kind'], 'tclRc802a')
    assert.match(text(detailPane()), /适配 TCL 智能电视语音遥控器/)
    assert.equal(detailPane().findAllByProps({ 'aria-label': '型号标签' }).length, 0, 'omits empty tags row')

    // Reset brand to All and test search input + clear button
    act(() => {
      brandGroup.findAllByType('button').find(b => text(b) === '全部').props.onClick()
    })
    const searchInput = view.root.findByProps({ 'aria-label': '搜索设备型号' })
    act(() => {
      searchInput.props.onChange({ target: { value: '7号电池' } })
    })
    assert.deepEqual(
      packageCards().map(c => c.props['data-kind']),
      ['rc003'],
    )
    act(() => {
      view.root.findByProps({ 'aria-label': '清空搜索' }).props.onClick()
    })
    assert.equal(packageCards().length, h.model.supportPackages.length)

    // Select a model with no cloud entry (hisenseRcf3b65): shows quiet empty state and zero fake tags
    act(() => {
      packageCards()
        .find(c => c.props['data-kind'] === 'hisenseRcf3b65')
        .props.onClick()
    })
    assert.match(text(detailPane()), /暂无型号详细介绍，可直接继续添加设备/)
    assert.equal(detailPane().findAllByProps({ 'aria-label': '型号标签' }).length, 0)

    // Select rc003 and click 下一步 -> enters Step 2 (details) with name initialized
    act(() => {
      packageCards()
        .find(c => c.props['data-kind'] === 'rc003')
        .props.onClick()
    })
    act(() => {
      nextBtn().props.onClick()
    })
    assert.equal(view.root.findAllByProps({ className: 'managed-catalog-picker' }).length, 0)
    const nameInput = () => view.root.findByType('input')
    assert.equal(nameInput().props.value, '小米蓝牙遥控器2Pro')

    // Step 2 has collapsible 型号说明 toggle in product header
    const infoToggle = () => view.root.findByProps({ className: 'managed-model-info-toggle' })
    assert.equal(infoToggle().props['aria-expanded'], false)
    act(() => infoToggle().props.onClick())
    assert.equal(infoToggle().props['aria-expanded'], true)
    const detailsCatalogPanel = view.root.findByProps({ className: 'managed-details-catalog-panel' })
    assert.match(text(detailsCatalogPanel), /京东自营/)
    assert.match(text(detailsCatalogPanel), /BLE 语音/)

    // Customize name, click 更换型号 -> back to kind -> switching model resets name, keeping model keeps custom name
    act(() => {
      nameInput().props.onChange({ target: { value: '客厅主遥控' } })
    })
    const changeModelBtn = view.root.findAllByType('button').find(b => text(b) === '更换型号')
    assert.ok(changeModelBtn)
    act(() => changeModelBtn.props.onClick())
    assert.equal(view.root.findAllByProps({ className: 'managed-catalog-picker' }).length, 1)

    // Keep same model (rc003) -> preserves custom name "客厅主遥控"
    act(() => nextBtn().props.onClick())
    assert.equal(nameInput().props.value, '客厅主遥控')

    // Go back again and double-click TCL RC802A -> advances directly and resets name to "TCL RC802A"
    act(() => {
      view.root
        .findAllByType('button')
        .find(b => text(b) === '更换型号')
        .props.onClick()
    })
    act(() => {
      packageCards()
        .find(c => c.props['data-kind'] === 'tclRc802a')
        .props.onDoubleClick()
    })
    assert.equal(nameInput().props.value, 'TCL RC802A')

    // Save device integration
    await act(async () => {
      view.root.findByProps({ className: 'managed-primary' }).props.onClick()
    })
    assert.equal(savedInstances.length, 1)
    assert.equal(savedInstances[0].kind, 'tclRc802a')
    assert.equal(savedInstances[0].name, 'TCL RC802A')
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
