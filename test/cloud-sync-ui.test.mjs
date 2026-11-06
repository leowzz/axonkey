import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import vm from 'node:vm'
import ts from 'typescript'
import React from 'react'
import Renderer, { act } from 'react-test-renderer'
import * as clientModule from '../src/cloud/relayClient.ts'
import * as syncModule from '../src/cloud/cloudSync.ts'
import * as loggingModule from '../src/cloud/cloudLogging.ts'
import * as captchaModule from '../src/cloud/captcha.ts'

const require = createRequire(import.meta.url)
const nodeText = node =>
  typeof node === 'string' ? node : (Array.isArray(node) ? node : (node?.children ?? [])).map(nodeText).join('')

async function settingsView(overrides = {}, component = 'CloudSyncSettings') {
  const calls = []
  const cloud = {
    user: null,
    busy: false,
    ready: true,
    error: '',
    message: '',
    conflict: null,
    pendingRestore: null,
    clearFeedback() {},
    clearLocalData: () => calls.push(['clearLocalData']),
    sendCode: async (channel, target, sent) => {
      calls.push(['code', channel, target])
      sent(60)
    },
    sync: overwrite => calls.push(['sync', overwrite]),
    ...overrides,
  }
  const source = ts.transpileModule(readFileSync(`src/components/${component}.tsx`, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020, jsx: ts.JsxEmit.ReactJSX },
  }).outputText
  const module = { exports: {} }
  const root = { inert: false }
  vm.runInNewContext(source, {
    module,
    exports: module.exports,
    Date,
    localStorage: { getItem: () => null, setItem() {} },
    document: { getElementById: () => root, activeElement: null, body: { style: { overflow: '' } } },
    HTMLElement: class {},
    window: { setTimeout: () => 1, clearTimeout() {} },
    require: name =>
      name.endsWith('.css')
        ? {}
        : name === './CloudRestorePicker'
          ? { CloudRestorePicker: () => null }
          : name === './SettingsHelp'
            ? { SettingsHelp: () => null }
            : name === 'react-dom'
              ? { createPortal: children => children }
              : require(name),
  })
  let view
  await act(async () => {
    view = Renderer.create(React.createElement(module.exports[component], { cloud }))
  })
  const button = label => view.root.findAllByType('button').find(node => nodeText(node) === label)
  return {
    view,
    calls,
    button,
    root,
    input: id => view.root.findByProps({ id }),
    click: async label => {
      await act(async () => button(label).props.onClick())
    },
    close: async () => {
      await act(async () => view.unmount())
    },
  }
}

test('login methods are direct buttons with email first and preserve each contact when switching', async () => {
  const app = await settingsView()
  try {
    assert.equal(app.button('清除本地数据'), undefined)
    assert.equal(app.view.root.findAllByType('select').length, 0)
    const group = app.view.root.findByProps({ role: 'group' })
    assert.deepEqual(group.findAllByType('button').map(nodeText), ['邮箱登录', '手机登录'])
    assert.equal(app.button('邮箱登录').props['aria-pressed'], true)
    await act(async () => app.input('cloud-target').props.onChange({ target: { value: 'user@example.invalid' } }))
    await app.click('手机登录')
    assert.equal(app.input('cloud-target').props.type, 'tel')
    await app.click('邮箱登录')
    assert.equal(app.input('cloud-target').props.value, 'user@example.invalid')
  } finally {
    await app.close()
  }
})

test('sent-code feedback stays beside its code field and disappears for another contact or channel', async () => {
  const app = await settingsView()
  try {
    await act(async () => app.input('cloud-target').props.onChange({ target: { value: 'user@example.invalid' } }))
    await app.click('获取验证码')
    assert.deepEqual(app.calls, [['code', 'email', 'user@example.invalid']])
    const field = app.view.root.findByProps({ className: 'cloud-code-field' })
    assert.equal(nodeText(field.findByProps({ role: 'status' })), '验证码已发送')
    assert.ok(app.button('60 秒后重发').props.disabled)
    await app.click('手机登录')
    assert.ok(!nodeText(app.view.toJSON()).includes('验证码已发送'))
    await app.click('邮箱登录')
    await act(async () => app.input('cloud-target').props.onChange({ target: { value: 'another@example.invalid' } }))
    assert.ok(!nodeText(app.view.toJSON()).includes('验证码已发送'))
  } finally {
    await app.close()
  }
})

test('first-sync selection is neutral, aligned with controls, and confirms upload in one action', async () => {
  const app = await settingsView({ user: { email: 'user@example.invalid' }, conflict: 'initial', autoSync: false })
  try {
    assert.equal(app.view.root.findAllByProps({ role: 'alert' }).length, 0)
    const feedback = app.view.root.findByProps({ className: 'cloud-feedback-content' })
    assert.match(nodeText(feedback), /首次同步/)
    assert.ok(!nodeText(app.view.toJSON()).includes('自动同步已暂停'))
    await app.click('使用本机配置并同步')
    assert.deepEqual(app.calls, [['sync', true]])
    assert.equal(app.view.root.findAllByProps({ 'aria-label': '确认覆盖云端配置' }).length, 0)
  } finally {
    await app.close()
  }
})

test('local reset is available without login and requires a warning and a second confirmation', async () => {
  const app = await settingsView({}, 'LocalDataResetSettings')
  try {
    await app.click('清除本地数据')
    assert.equal(app.root.inert, true)
    const dialog = app.view.root.findByProps({ role: 'alertdialog' })
    assert.match(nodeText(dialog), /驱动和系统授权保留/)
    assert.match(nodeText(dialog), /建议先导出备份/)
    assert.equal(app.button('确认清除'), undefined)
    await app.click('取消')
    assert.equal(app.root.inert, false)
    assert.deepEqual(app.calls, [])
    await app.click('清除本地数据')
    await app.click('继续')
    assert.match(nodeText(app.view.toJSON()), /无法撤销/)
    assert.deepEqual(app.calls, [])
    await app.click('返回')
    assert.equal(app.button('确认清除'), undefined)
    await app.click('继续')
    await app.click('确认清除')
    assert.deepEqual(app.calls, [['clearLocalData']])
  } finally {
    await app.close()
  }
})

test('local reset is disabled while configuration is loading or cloud work is running', async () => {
  for (const overrides of [{ busy: true }, { ready: false }]) {
    const app = await settingsView(overrides, 'LocalDataResetSettings')
    try {
      assert.equal(app.button('清除本地数据').props.disabled, true)
    } finally {
      await app.close()
    }
  }
})

async function setup({ credential = null, stored = null, clearError = null } = {}) {
  const logs = []
  const previousWindow = globalThis.window
  globalThis.window = {
    __TAURI_INTERNALS__: {
      invoke: async (command, args) => {
        assert.equal(command, 'plugin:log|log')
        if (args.message.startsWith('[relay] ')) logs.push({ ...JSON.parse(args.message.slice(8)), level: args.level })
      },
    },
  }
  const values = new Map()
  if (stored) values.set('axonkey.relay.v1', JSON.stringify(stored))
  const timers = new Map()
  let timerId = 0
  const requests = []
  let offline = false
  let settings = null
  const sourceInfo = {
    source_platform: 'macos',
    source_installation_id: 'test-installation',
    source_computer_name: null,
  }
  let snapshot = { source: sourceInfo, documents: [], settings: { enabled: true } }
  let controller
  let restores = 0
  let clears = 0
  let clearPreferences
  const schedule = callback => {
    timers.set(++timerId, callback)
    return timerId
  }
  const source = ts.transpileModule(readFileSync('src/cloud/useCloudSync.ts', 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
  }).outputText
  const module = { exports: {} }
  vm.runInNewContext(source, {
    module,
    exports: module.exports,
    Date,
    Error,
    navigator: { userAgent: 'test' },
    localStorage: { getItem: key => values.get(key) ?? null, setItem: (key, value) => values.set(key, value) },
    window: {
      setTimeout: schedule,
      setInterval: schedule,
      clearTimeout: id => timers.delete(id),
      clearInterval: id => timers.delete(id),
      addEventListener() {},
      removeEventListener() {},
    },
    require(name) {
      if (name === './relayClient') return clientModule
      if (name === './cloudSync') return syncModule
      if (name === './cloudLogging') return loggingModule
      if (name === './captcha') return captchaModule
      if (name === '../../package.json') return { version: 'test' }
      if (name === '@tauri-apps/api/core')
        return {
          invoke: async (_command, request) => {
            if (_command === 'load_relay_session') return credential
            if (_command === 'save_relay_session') {
              assert.equal(request.session?.access_token, undefined)
              values.set('session-file', request.session)
              return
            }
            if (_command === 'open_external_page') {
              requests.push({ command: _command, ...request })
              return
            }
            requests.push(request)
            if (offline) throw '无法连接云端，请检查网络后重试；本地功能不受影响'
            if (request.path === '/auth/v2/verify')
              return {
                status: 200,
                body: {
                  access_token: 'access',
                  refresh_token: 'refresh',
                  expires_at: Date.now() / 1000 + 900,
                  user: { id: 'user', email: 'user@example.invalid', phone: null },
                },
              }
            if (request.path === '/auth/console-ticket')
              return { status: 200, body: { ticket: 'A'.repeat(43), expires_in: 60 } }
            if (request.path === '/auth/logout') return { status: 204, body: null }
            if (request.path.startsWith('/v2/device-')) return { status: 200, body: { items: [], total: 0 } }
            if (request.method === 'PUT') {
              settings = { ...request.body, revision: (settings?.revision ?? 0) + 1 }
              return { status: 200, body: settings }
            }
            return settings
              ? { status: 200, etag: `"settings:${settings.revision}"`, body: settings }
              : { status: 404, body: {} }
          },
        }
      return require(name)
    },
  })
  function App() {
    controller = module.exports.useCloudSync({
      native: true,
      ready: true,
      snapshot: () => snapshot,
      restore: async () => {
        restores++
      },
      clearLocalData: async () => {
        clears++
        clearPreferences = JSON.parse(values.get('axonkey.relay.v1'))
        if (clearError) throw new Error(clearError)
      },
    })
    return React.createElement('local-editor', { enabled: snapshot.settings.enabled })
  }
  let view
  await act(async () => {
    view = Renderer.create(React.createElement(App))
  })
  return {
    get cloud() {
      return controller
    },
    requests,
    values,
    logs,
    get restores() {
      return restores
    },
    get clears() {
      return clears
    },
    get clearPreferences() {
      return clearPreferences
    },
    offline: value => {
      offline = value
    },
    edit: value => {
      snapshot = { source: sourceInfo, documents: [], settings: { enabled: value } }
    },
    remoteEdit: value => {
      settings = { schema_version: 1, revision: (settings?.revision ?? 0) + 1, settings: { enabled: value } }
    },
    call: async fn => {
      await act(async () => {
        await fn(controller)
      })
    },
    tick: async () => {
      await act(async () => {
        for (const callback of [...timers.values()]) callback()
        await new Promise(resolve => setImmediate(resolve))
      })
    },
    close: async () => {
      await act(async () => view.unmount())
      globalThis.window = previousWindow
    },
  }
}

test('local startup and login stay offline until explicit manual sync; manual sync leaves auto off', async () => {
  const app = await setup()
  try {
    await app.tick()
    app.edit(false)
    await app.tick()
    assert.equal(app.requests.length, 0)
    await app.call(cloud => cloud.login('email', 'user@example.invalid', '123456'))
    await app.tick()
    assert.deepEqual(
      app.requests.map(request => request.path),
      ['/auth/v2/verify'],
    )
    assert.equal(app.cloud.autoSync, false)
    await app.call(cloud => cloud.sync())
    assert.equal(app.requests.filter(request => request.method === 'PUT').length, 1)
    assert.equal(app.cloud.autoSync, false)
    assert.ok(app.cloud.lastSync)
    const stored = JSON.parse(app.values.get('axonkey.relay.v1'))
    assert.equal(stored.session, undefined)
    assert.equal(app.values.get('session-file').refresh_token, 'refresh')
  } finally {
    await app.close()
  }
})

test('a saved login loads without network and malformed session files cannot block local startup', async () => {
  for (const credential of [
    { refresh_token: 'saved-refresh', user: { id: 'user', email: 'user@example.invalid', phone: null } },
    { refresh_token: 42 },
  ]) {
    const app = await setup({ credential })
    try {
      await app.tick()
      assert.equal(app.requests.length, 0)
      assert.equal(app.cloud.busy, false)
      if (typeof credential.refresh_token === 'string') assert.equal(app.cloud.user.id, 'user')
      else {
        assert.equal(app.cloud.user, null)
        assert.match(app.cloud.error, /格式无效/)
      }
    } finally {
      await app.close()
    }
  }
})

test('auto upload follows local edits, stops when disabled, and offline failure preserves session and local snapshot', async () => {
  const app = await setup()
  try {
    await app.call(cloud => cloud.login('email', 'user@example.invalid', '123456'))
    await app.call(cloud => cloud.setAutoSync(true))
    await app.tick()
    assert.equal(app.requests.filter(request => request.method === 'PUT').length, 1)
    await app.tick()
    assert.equal(app.requests.filter(request => request.method === 'PUT').length, 1)
    app.edit(false)
    await app.tick()
    assert.equal(app.requests.filter(request => request.method === 'PUT').length, 2)
    await app.call(cloud => cloud.setAutoSync(false))
    app.edit(true)
    await app.tick()
    assert.equal(app.requests.filter(request => request.method === 'PUT').length, 2)
    app.offline(true)
    await app.call(cloud => cloud.sync())
    assert.equal(app.cloud.error, '')
    assert.match(app.cloud.message, /暂时无法同步/)
    assert.ok(app.cloud.user)
    await app.call(cloud => cloud.logout())
    assert.equal(app.cloud.user, null)
    assert.equal(app.cloud.autoSync, false)
    await app.tick()
    assert.match(app.cloud.message, /已退出本机账号/)
  } finally {
    await app.close()
  }
})

test('cloud conflict pauses automatic upload and restore requires a separate confirmation', async () => {
  const app = await setup()
  try {
    await app.call(cloud => cloud.login('email', 'user@example.invalid', '123456'))
    app.remoteEdit(false)
    await app.call(cloud => cloud.setAutoSync(true))
    await app.tick()
    assert.equal(app.cloud.autoSync, false)
    assert.equal(app.cloud.conflict, 'initial')
    assert.equal(app.cloud.error, '')
    assert.equal(app.requests.filter(request => request.method === 'PUT').length, 0)
    await app.call(cloud => cloud.fetchRestore())
    assert.ok(app.cloud.pendingRestore)
    assert.equal(app.restores, 0)
    await app.call(cloud => cloud.cancelRestore())
    assert.equal(app.restores, 0)
    await app.call(cloud => cloud.fetchRestore())
    await app.call(cloud => cloud.confirmRestore({ devices: [], settings: true, savedBehaviors: false }))
    assert.equal(app.restores, 1)
    assert.equal(app.cloud.autoSync, false)
  } finally {
    await app.close()
  }
})

test('clearing local data pauses sync and forgets revisions before deletion, preserving login and cloud data', async () => {
  const app = await setup()
  try {
    await app.call(c => c.login('email', 'user@example.invalid', '123456'))
    await app.call(c => c.setAutoSync(true))
    await app.tick()
    assert.ok(app.cloud.lastSync)
    const before = app.requests.length
    await app.call(c => c.clearLocalData())
    assert.equal(app.clears, 1)
    assert.equal(app.clearPreferences.autoSync, false)
    assert.deepEqual(app.clearPreferences.accounts, {})
    assert.equal(app.cloud.user.id, 'user')
    assert.equal(app.cloud.autoSync, false)
    assert.equal(app.cloud.lastSync, undefined)
    app.edit(false)
    await app.tick()
    assert.equal(app.requests.length, before)
  } finally {
    await app.close()
  }
})

test('local reset failures remain visible and keep automatic sync paused for a retry', async () => {
  const app = await setup({ clearError: '设备配置无法写入' })
  try {
    await app.call(c => c.login('email', 'user@example.invalid', '123456'))
    await app.call(c => c.setAutoSync(true))
    await app.call(c => c.clearLocalData())
    assert.match(app.cloud.error, /设备配置无法写入/)
    assert.equal(app.cloud.autoSync, false)
    assert.equal(app.cloud.busy, false)
    assert.equal(app.cloud.user.id, 'user')
    assert.equal(app.requests.length, 1)
    await app.call(c => c.clearLocalData())
    assert.equal(app.clears, 2)
  } finally {
    await app.close()
  }
})

test('console button is signed-in only and launches with a one-time ticket without syncing', async () => {
  const signedOut = await settingsView()
  assert.equal(signedOut.button('前往控制台'), undefined)
  await signedOut.close()
  let opened = 0
  const signedIn = await settingsView({
    user: { email: 'user@example.invalid' },
    openConsole: () => {
      opened++
    },
  })
  await signedIn.click('前往控制台')
  assert.equal(opened, 1)
  await signedIn.close()
  const app = await setup()
  try {
    await app.call(c => c.login('email', 'user@example.invalid', '123456'))
    app.requests.length = 0
    await app.call(c => c.openConsole())
    assert.equal(app.requests.length, 2)
    assert.equal(app.requests[0].path, '/auth/console-ticket')
    assert.equal(app.requests[0].token, 'access')
    assert.deepEqual(JSON.parse(JSON.stringify(app.requests[1])), {
      command: 'open_external_page',
      page: 'console',
      ticket: 'A'.repeat(43),
    })
    assert.equal(app.cloud.autoSync, false)
    assert.equal(app.cloud.error, '')
    app.offline(true)
    app.requests.length = 0
    await app.call(c => c.openConsole())
    assert.equal(app.requests.length, 1)
    assert.ok(app.cloud.user)
  } finally {
    await app.close()
  }
})

test('account and sync logs explain outcomes without credentials, contacts, or configuration content', async () => {
  const app = await setup()
  try {
    assert.ok(app.logs.some(log => log.event === 'session.load.complete' && !log.signed_in))
    await app.call(c => c.login('email', 'user@example.invalid', '123456'))
    await app.call(c => c.openConsole())
    await app.call(c => c.sync())
    assert.ok(app.logs.some(log => log.event === 'operation.complete' && log.operation === 'auth.login.email'))
    assert.ok(app.logs.some(log => log.event === 'operation.complete' && log.operation === 'console.open'))
    assert.ok(app.logs.some(log => log.event === 'operation.complete' && log.operation === 'sync.manual'))
    await app.call(c => c.setAutoSync(true))
    app.edit(false)
    await app.tick()
    assert.ok(app.logs.some(log => log.event === 'operation.start' && log.operation === 'sync.automatic'))
    const idleCount = app.logs.length
    await app.tick()
    assert.equal(app.logs.length, idleCount)
    app.remoteEdit(true)
    await app.call(c => c.sync())
    assert.ok(app.logs.some(log => log.event === 'sync.conflict' && log.auto_sync_paused))
    await app.call(c => c.fetchRestore())
    await app.call(c => c.cancelRestore())
    await app.call(c => c.fetchRestore())
    await app.call(c => c.confirmRestore({ devices: [], settings: true, savedBehaviors: false }))
    assert.ok(app.logs.some(log => log.event === 'restore.cancelled'))
    assert.ok(app.logs.some(log => log.event === 'operation.complete' && log.operation === 'restore.apply'))
    app.offline(true)
    const start = app.logs.length
    await app.call(c => c.sync())
    assert.ok(
      app.logs.slice(start).some(log => log.event === 'sync.deferred' && log.error_type === 'network_unavailable'),
    )
    assert.ok(!app.logs.slice(start).some(log => log.event === 'operation.complete'))
    await app.call(c => c.logout())
    assert.ok(
      app.logs.some(
        log => log.event === 'operation.complete' && log.operation === 'auth.logout' && log.outcome === 'local_only',
      ),
    )
    const raw = JSON.stringify(app.logs)
    for (const secret of ['user@example.invalid', '123456', 'A'.repeat(43), '"access"', '"refresh"', '"settings":{"'])
      assert.ok(!raw.includes(secret), secret)
  } finally {
    await app.close()
  }
})

test('restore refuses a stale settings preview and requires a fresh selection', async () => {
  const app = await setup()
  try {
    await app.call(c => c.login('email', 'user@example.invalid', '123456'))
    app.remoteEdit(false)
    await app.call(c => c.fetchRestore())
    app.remoteEdit(true)
    await app.call(c => c.confirmRestore({ devices: [], settings: true, savedBehaviors: false }))
    assert.equal(app.restores, 0)
    assert.match(app.cloud.error, /已更新/)
    assert.equal(app.cloud.pendingRestore.settings.settings.enabled, true)
    await app.call(c => c.confirmRestore({ devices: [], settings: false, savedBehaviors: false }))
    assert.equal(app.restores, 0)
    assert.match(app.cloud.error, /请先选择/)
  } finally {
    await app.close()
  }
})

test('restore picker defaults to the local device and asks only when the destination is ambiguous', async t => {
  const { registerHooks } = await import('node:module')
  const assets = registerHooks({
    load(url, context, next) {
      return url.endsWith('.svg')
        ? { format: 'module', source: 'export default "asset.svg"', shortCircuit: true }
        : next(url, context)
    },
  })
  const model = await import('../src/devices/integration/model.ts')
  assets.deregister()
  const source = ts.transpileModule(readFileSync('src/components/CloudRestorePicker.tsx', 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020, jsx: ts.JsxEmit.ReactJSX },
  }).outputText
  const module = { exports: {} }
  vm.runInNewContext(source, {
    module,
    exports: module.exports,
    crypto: globalThis.crypto,
    require: name => (name === '../devices/integration/model' ? model : require(name)),
  })
  let result, view
  const state = {
    models: [{ id: 'model', code: 'rc003' }],
    documents: [
      {
        id: 'cloud',
        model_id: 'model',
        source_platform: 'windows',
        source_computer_name: 'ThinkBook',
        config: {
          name: 'Remote',
          profiles: [
            { id: 'one', name: 'Read', app_version: '1.8.4', behaviors: {} },
            { id: 'two', name: 'Work', behaviors: {} },
          ],
        },
      },
    ],
    settings: { settings: { savedBehaviors: [] } },
  }
  await act(async () => {
    view = Renderer.create(
      React.createElement(module.exports.CloudRestorePicker, {
        state,
        instances: [
          { id: 'mac', kind: 'rc003', name: 'Mac Remote' },
          { id: 'other', kind: 'cmiotA15', name: 'Wrong Model' },
        ],
        platform: 'macos',
        busy: false,
        onConfirm: value => {
          result = value
        },
        onCancel() {},
      }),
    )
  })
  try {
    const apply = () => view.root.findAllByType('button')[0]
    assert.ok(view.root.findAllByType('input').every(input => input.props.checked === false))
    assert.equal(apply().props.disabled, true)
    const profile = view.root.findByProps({ className: 'cloud-restore-profiles' }).findAllByType('input')[0]
    await act(async () => profile.props.onChange({ target: { checked: true } }))
    assert.equal(apply().props.disabled, false)
    const target = view.root.findByProps({ 'aria-label': 'Remote恢复到' })
    assert.ok(!target.findAllByType('option').some(option => option.props.value === 'other'))
    assert.match(nodeText(view.toJSON()), /跨系统恢复/)
    assert.equal(target.props.value, 'mac')
    assert.deepEqual(
      target.findAllByType('option').map(option => option.props.value),
      ['mac', 'new'],
    )
    assert.equal(apply().props.disabled, false)
    await act(async () => apply().props.onClick())
    assert.deepEqual(JSON.parse(JSON.stringify(result)), {
      devices: [{ documentId: 'cloud', profileIds: ['one'], targetId: 'mac' }],
      settings: false,
      savedBehaviors: false,
    })
  } finally {
    await act(async () => view.unmount())
  }
  for (const scenario of [
    { name: 'no local device creates a new device without asking', kind: 'rc003', instances: [], expected: 'new:' },
    { name: 'mouse restores directly to the local mouse', kind: 'mouse', instances: [], expected: 'legacy:mouse' },
    {
      name: 'multiple local devices require an explicit choice',
      kind: 'rc003',
      instances: [
        { id: 'a', kind: 'rc003', name: 'A' },
        { id: 'b', kind: 'rc003', name: 'B' },
      ],
      expected: 'b',
    },
  ]) {
    await t.test(scenario.name, async () => {
      let confirmed
      await act(async () => {
        view = Renderer.create(
          React.createElement(module.exports.CloudRestorePicker, {
            state: { ...state, models: [{ id: 'model', code: scenario.kind }] },
            instances: scenario.instances,
            platform: 'macos',
            busy: false,
            onConfirm: value => {
              confirmed = value
            },
            onCancel() {},
          }),
        )
      })
      try {
        const apply = () => view.root.findAllByType('button')[0]
        const profile = view.root.findByProps({ className: 'cloud-restore-profiles' }).findAllByType('input')[0]
        await act(async () => profile.props.onChange({ target: { checked: true } }))
        assert.ok(!nodeText(view.toJSON()).includes('旧版映射'))
        if (scenario.instances.length > 1) {
          assert.equal(apply().props.disabled, true)
          await act(async () =>
            view.root.findByProps({ 'aria-label': 'Remote恢复到' }).props.onChange({ target: { value: 'b' } }),
          )
        } else {
          assert.equal(view.root.findAllByType('select').length, 1)
        }
        assert.equal(apply().props.disabled, false)
        await act(async () => apply().props.onClick())
        assert.ok(confirmed.devices[0].targetId.startsWith(scenario.expected))
      } finally {
        await act(async () => view.unmount())
      }
    })
  }
})
