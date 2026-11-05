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

const require = createRequire(import.meta.url)
const nodeText = node => typeof node === 'string' ? node : (Array.isArray(node) ? node : node?.children ?? []).map(nodeText).join('')

async function settingsView(overrides = {}) {
  const calls = []
  const cloud = {
    user: null, busy: false, ready: true, error: '', message: '', conflict: null, pendingRestore: null,
    clearFeedback() {},
    sendCode: async (channel, target, sent) => { calls.push(['code', channel, target]); sent(60) },
    sync: overwrite => calls.push(['sync', overwrite]),
    ...overrides,
  }
  const source = ts.transpileModule(readFileSync('src/components/CloudSyncSettings.tsx', 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020, jsx: ts.JsxEmit.ReactJSX } }).outputText
  const module = { exports: {} }
  vm.runInNewContext(source, {
    module, exports: module.exports, Date,
    window: { setTimeout: () => 1, clearTimeout() {} },
    require: name => name.endsWith('.css') ? {} : name === './SettingsHelp' ? { SettingsHelp: () => null } : require(name),
  })
  let view
  await act(async () => { view = Renderer.create(React.createElement(module.exports.CloudSyncSettings, { cloud })) })
  const button = label => view.root.findAllByType('button').find(node => nodeText(node) === label)
  return {
    view, calls, button,
    input: id => view.root.findByProps({ id }),
    click: async label => { await act(async () => button(label).props.onClick()) },
    close: async () => { await act(async () => view.unmount()) },
  }
}

test('login methods are direct buttons with email first and preserve each contact when switching', async () => {
  const app = await settingsView()
  try {
    assert.equal(app.view.root.findAllByType('select').length, 0)
    const group = app.view.root.findByProps({ role: 'group' })
    assert.deepEqual(group.findAllByType('button').map(nodeText), ['邮箱登录', '手机登录'])
    assert.equal(app.button('邮箱登录').props['aria-pressed'], true)
    await act(async () => app.input('cloud-target').props.onChange({ target: { value: 'user@example.invalid' } }))
    await app.click('手机登录')
    assert.equal(app.input('cloud-target').props.type, 'tel')
    await app.click('邮箱登录')
    assert.equal(app.input('cloud-target').props.value, 'user@example.invalid')
  } finally { await app.close() }
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
  } finally { await app.close() }
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
  } finally { await app.close() }
})

async function setup({ credential = null, stored = null } = {}) {
  const values = new Map()
  if (stored) values.set('axonkey.relay.v1', JSON.stringify(stored))
  const timers = new Map()
  let timerId = 0
  const requests = []
  let offline = false
  let settings = null
  let snapshot = { documents: [], settings: { enabled: true } }
  let controller
  let restores = 0
  const schedule = callback => { timers.set(++timerId, callback); return timerId }
  const source = ts.transpileModule(readFileSync('src/cloud/useCloudSync.ts', 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 } }).outputText
  const module = { exports: {} }
  vm.runInNewContext(source, {
    module, exports: module.exports, Date, Error, navigator: { userAgent: 'test' },
    localStorage: { getItem: key => values.get(key) ?? null, setItem: (key, value) => values.set(key, value) },
    window: { setTimeout: schedule, setInterval: schedule, clearTimeout: id => timers.delete(id), clearInterval: id => timers.delete(id), addEventListener() {}, removeEventListener() {} },
    require(name) {
      if (name === './relayClient') return clientModule
      if (name === './cloudSync') return syncModule
      if (name === '../../package.json') return { version: 'test' }
      if (name === '@tauri-apps/api/core') return { invoke: async (_command, request) => {
        if (_command === 'load_relay_session') return credential
        if (_command === 'save_relay_session') {
          assert.equal(request.session?.access_token, undefined)
          values.set('session-file', request.session)
          return
        }
        if (_command === 'open_external_page') { requests.push({ command: _command, ...request }); return }
        requests.push(request)
        if (offline) throw '无法连接云端，请检查网络后重试；本地功能不受影响'
        if (request.path === '/auth/verify') return { status: 200, body: { access_token: 'access', refresh_token: 'refresh', expires_at: Date.now() / 1000 + 900, user: { id: 'user', email: 'user@example.invalid', phone: null } } }
        if (request.path === '/auth/console-ticket') return { status: 200, body: { ticket: 'A'.repeat(43), expires_in: 60 } }
        if (request.path === '/auth/logout') return { status: 204, body: null }
        if (request.path.startsWith('/device-')) return { status: 200, body: { items: [] } }
        if (request.method === 'PUT') { settings = { ...request.body, revision: (settings?.revision ?? 0) + 1 }; return { status: 200, body: settings } }
        return settings ? { status: 200, body: settings } : { status: 404, body: {} }
      } }
      return require(name)
    },
  })
  function App() {
    controller = module.exports.useCloudSync({ native: true, ready: true, snapshot: () => snapshot, restore: async () => { restores++ } })
    return React.createElement('local-editor', { enabled: snapshot.settings.enabled })
  }
  let view
  await act(async () => { view = Renderer.create(React.createElement(App)) })
  return {
    get cloud() { return controller }, requests, values, get restores() { return restores },
    offline: value => { offline = value },
    edit: value => { snapshot = { documents: [], settings: { enabled: value } } },
    remoteEdit: value => { settings = { schema_version: 1, revision: (settings?.revision ?? 0) + 1, settings: { enabled: value } } },
    call: async fn => { await act(async () => { await fn(controller) }) },
    tick: async () => { await act(async () => { for (const callback of [...timers.values()]) callback(); await new Promise(resolve => setImmediate(resolve)) }) },
    close: async () => { await act(async () => view.unmount()) },
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
    assert.deepEqual(app.requests.map(request => request.path), ['/auth/verify'])
    assert.equal(app.cloud.autoSync, false)
    await app.call(cloud => cloud.sync())
    assert.equal(app.requests.filter(request => request.method === 'PUT').length, 1)
    assert.equal(app.cloud.autoSync, false)
    assert.ok(app.cloud.lastSync)
    const stored = JSON.parse(app.values.get('axonkey.relay.v1'))
    assert.equal(stored.session, undefined)
    assert.equal(app.values.get('session-file').refresh_token, 'refresh')
  } finally { await app.close() }
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
      else { assert.equal(app.cloud.user, null); assert.match(app.cloud.error, /格式无效/) }
    } finally { await app.close() }
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
  } finally { await app.close() }
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
    await app.call(cloud => cloud.confirmRestore())
    assert.equal(app.restores, 1)
    assert.equal(app.cloud.autoSync, false)
  } finally { await app.close() }
})

test('console button is signed-in only and launches with a one-time ticket without syncing', async () => {
  const signedOut = await settingsView()
  assert.equal(signedOut.button('前往控制台'), undefined)
  await signedOut.close()
  let opened = 0
  const signedIn = await settingsView({ user: { email: 'user@example.invalid' }, openConsole: () => { opened++ } })
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
    assert.deepEqual(JSON.parse(JSON.stringify(app.requests[1])), { command: 'open_external_page', page: 'console', ticket: 'A'.repeat(43) })
    assert.equal(app.cloud.autoSync, false)
    assert.equal(app.cloud.error, '')
    app.offline(true)
    app.requests.length = 0
    await app.call(c => c.openConsole())
    assert.equal(app.requests.length, 1)
    assert.ok(app.cloud.user)
  } finally { await app.close() }
})
