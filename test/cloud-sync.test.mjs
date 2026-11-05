import assert from 'node:assert/strict'
import test from 'node:test'
import { RelayClient, RelayError } from '../src/cloud/relayClient.ts'
import { uploadCloud, readCloud, fingerprint, SyncConflict } from '../src/cloud/cloudSync.ts'
import { registerHooks } from 'node:module'
import { createDataBackup } from '../src/dataBackup.ts'
import { sampleData } from './fixtures/data-backup.mjs'

const assets = registerHooks({ load(url, context, next) {
  return url.endsWith('.svg') ? { format: 'module', source: 'export default "asset.svg"', shortCircuit: true } : next(url, context)
} })
const { createCloudSnapshot, prepareCloudRestore } = await import('../src/cloud/cloudData.ts')
assets.deregister()

const session = () => ({ access_token: 'access', refresh_token: 'refresh', expires_at: Date.now() / 1000 + 900, user: { id: 'test-user', email: 'user@example.invalid', phone: null } })

test('a logged-out client makes no startup requests and rejects cloud access locally', async () => {
  const calls = []
  const client = new RelayClient(async (...args) => { calls.push(args) }, null, () => {})
  assert.deepEqual(calls, [])
  await assert.rejects(client.request('GET', '/app-settings/axonkey'), /请先登录/)
  assert.deepEqual(calls, [])
})

test('login uses the app domain and persists credentials without touching configurations', async () => {
  const calls = [], saved = []
  const client = new RelayClient(async (method, path, body) => {
    calls.push({ method, path, body })
    return { status: 200, body: path.endsWith('/code') ? { retry_after: 60 } : session() }
  }, null, value => saved.push(value))
  await client.sendCode('sms', ' 13800000000 ')
  await client.login('email', ' user@example.invalid ', '123456')
  assert.deepEqual(calls.map(call => call.path), ['/auth/code', '/auth/verify'])
  assert.equal(calls[0].body.phone, '13800000000')
  assert.equal(calls[1].body.email, 'user@example.invalid')
  assert.equal(calls[1].body.app_id, 'axonkey')
  assert.equal(saved[0].user.id, 'test-user')
})

test('refresh persists its retry ID before sending and reuses it after a timeout and restart', async () => {
  let saved = { ...session(), expires_at: 0 }
  let firstRequest
  const client = new RelayClient(async (_method, path, body) => {
    assert.equal(path, '/auth/refresh')
    assert.equal(saved.requestId, body.request_id)
    firstRequest = body
    throw new Error('network timeout')
  }, saved, value => { saved = structuredClone(value) })
  await assert.rejects(client.request('GET', '/app-settings/axonkey'), /timeout/)
  const restarted = new RelayClient(async (_method, path, body) => {
    if (path === '/auth/refresh') {
      assert.deepEqual(body, firstRequest)
      return { status: 200, body: { ...session(), refresh_token: 'rotated' } }
    }
    return { status: 200, body: { ok: true } }
  }, saved, value => { saved = structuredClone(value) })
  assert.deepEqual(await restarted.request('GET', '/app-settings/axonkey'), { ok: true })
  assert.equal(saved.refresh_token, 'rotated')
  assert.equal(saved.requestId, undefined)
})

test('concurrent requests share one refresh, and service outages keep credentials', async () => {
  let refreshes = 0
  const client = new RelayClient(async (_method, path) => {
    if (path === '/auth/refresh') { refreshes++; await new Promise(resolve => setTimeout(resolve, 10)); return { status: 200, body: session() } }
    return { status: 503, body: { code: 'service_unavailable', detail: '服务暂不可用' } }
  }, { ...session(), expires_at: 0 }, () => {})
  const results = await Promise.allSettled([client.request('GET', '/one'), client.request('GET', '/two')])
  assert.equal(refreshes, 1)
  assert.ok(results.every(result => result.status === 'rejected'))
  assert.equal(client.session.refresh_token, 'refresh')
})

test('a failed retry-ID save prevents refresh from consuming credentials', async () => {
  let calls = 0
  const initial = { ...session(), expires_at: 0 }
  const client = new RelayClient(async () => { calls++; return { status: 200, body: session() } }, initial, async () => { throw new Error('disk full') })
  await assert.rejects(client.request('GET', '/app-settings/axonkey'), /disk full/)
  assert.equal(calls, 0)
  assert.equal(client.session, initial)
})

test('malformed successful auth responses never become an active login', async () => {
  const client = new RelayClient(async () => ({ status: 200, body: { access_token: 'incomplete' } }), null, () => {})
  await assert.rejects(client.login('email', 'user@example.invalid', '123456'), /响应无效/)
  assert.equal(client.session, null)
})

test('invalid sessions clear login, while business refusals keep the session', async () => {
  for (const status of [401, 403, 429]) {
    const client = new RelayClient(async () => ({ status, body: { code: 'rejected' } }), session(), () => {})
    await assert.rejects(client.request('GET', '/one'), RelayError)
    assert.equal(client.session === null, status === 401)
  }
  const client = new RelayClient(async () => { throw new Error('offline') }, session(), () => {})
  await assert.rejects(client.logout(), /offline/)
  assert.equal(client.session, null)
})

function cloudServer({ documents = [], settings = null, models = [{ id: 'model', code: 'rc003' }], failWrite = 0 } = {}) {
  const writes = []
  const client = new RelayClient(async (method, path, body) => {
    if (method === 'GET') {
      if (path.startsWith('/device-models')) return { status: 200, body: { items: models } }
      if (path.startsWith('/device-configs')) return { status: 200, body: { items: documents } }
      return settings ? { status: 200, body: settings } : { status: 404, body: { code: 'not_found' } }
    }
    writes.push({ method, path, body })
    if (writes.length === failWrite) throw new Error('offline')
    return { status: 200, body: { ...body, id: 'remote', revision: body.revision + 1 } }
  }, session(), () => {})
  return { client, writes }
}
const snapshot = () => ({ documents: [{ key: 'local-instance', kind: 'rc003', config: { name: 'Local' } }], settings: { enabled: true } })
const remote = () => ({ id: 'remote', model_id: 'model', instance_key: 'local-instance', schema_version: 1, revision: 2, config: { name: 'Cloud' } })

test('first upload creates documents and settings with revision zero and remembers successes', async () => {
  const server = cloudServer()
  let memory = {}
  await uploadCloud(server.client, snapshot(), memory, value => { memory = value })
  assert.equal(server.writes.length, 2)
  assert.ok(server.writes.every(write => write.body.revision === 0))
  assert.equal(memory['rc003/local-instance'].revision, 1)
  assert.equal(memory.settings.revision, 1)
})

test('first upload fills empty or compatible partial settings without an unnecessary conflict', async () => {
  for (const settings of [{}, { enabled: true }, { enabled: true, sidebarCollapsed: false }]) {
    const server = cloudServer({ settings: { schema_version: 1, revision: 3, settings } })
    const data = snapshot()
    data.settings = { enabled: true, mouseEnabled: true }
    await uploadCloud(server.client, data, {}, () => {})
    const written = server.writes.find(write => write.path === '/app-settings/axonkey')
    assert.equal(written.body.revision, 3)
    assert.deepEqual(written.body.settings, { ...settings, ...data.settings })
  }
})

test('a different first cloud value requests a choice, while a later revision change remains protected', async () => {
  const server = cloudServer({ settings: { schema_version: 1, revision: 3, settings: { enabled: false } } })
  for (const [memory, initial] of [[{}, true], [{ settings: { revision: 2 } }, false]]) {
    await assert.rejects(uploadCloud(server.client, snapshot(), memory, () => {}), error => error instanceof SyncConflict && error.initial === initial)
    assert.equal(server.writes.length, 0)
  }
})

test('unknown or changed cloud data conflicts before any writes, explicit overwrite uses fetched revisions', async () => {
  for (const memory of [{}, { 'rc003/local-instance': { revision: 1, content: '{}' } }]) {
    const server = cloudServer({ documents: [remote()] })
    await assert.rejects(uploadCloud(server.client, snapshot(), memory, () => {}), SyncConflict)
    assert.equal(server.writes.length, 0)
    await uploadCloud(server.client, snapshot(), memory, () => {}, true)
    assert.equal(server.writes[0].body.revision, 2)
  }
})

test('known revisions allow local edits; partial failure retains only successful revisions', async () => {
  const server = cloudServer({ documents: [remote()], failWrite: 2 })
  let memory = { 'rc003/local-instance': { revision: 2, content: '{}' } }
  await assert.rejects(uploadCloud(server.client, snapshot(), memory, value => { memory = value }), /offline/)
  assert.equal(memory['rc003/local-instance'].revision, 3)
  assert.equal(memory.settings, undefined)
})

test('equal JSON ignores key order and does not write; remotely deleted known data conflicts', async () => {
  const data = snapshot()
  const server = cloudServer({ documents: [{ ...remote(), config: data.documents[0].config }], settings: { schema_version: 1, revision: 4, settings: data.settings } })
  await uploadCloud(server.client, data, {}, () => {})
  assert.equal(server.writes.length, 0)
  assert.equal(fingerprint({ b: 1, a: 2 }), fingerprint({ a: 2, b: 1 }))
  await assert.rejects(uploadCloud(cloudServer().client, data, { settings: { revision: 4, content: '{}' } }, () => {}), SyncConflict)
})

test('missing model and newer schemas stop upload without partial writes', async () => {
  const server = cloudServer({ models: [] })
  await assert.rejects(uploadCloud(server.client, snapshot(), {}, () => {}), /型号/)
  assert.equal(server.writes.length, 0)
  await assert.rejects(readCloud(cloudServer({ documents: [{ ...remote(), schema_version: 2 }] }).client), /版本较新/)
})

test('portable round trip includes mouse and library but excludes local bindings and credentials', () => {
  const backup = createDataBackup(sampleData(), '1.7.15')
  const instance = { id: 'instance', kind: 'rc003', name: 'Living room', enabled: true, binding: 'physical-id', bindingQuality: 'serial', quarborTarget: 'driver', hideDriverMissingReminder: true, audioGainDb: 6, activeProfileId: 'default', profiles: [{ id: 'default', name: 'Default', behaviors: {} }] }
  const data = createCloudSnapshot(backup, [instance])
  assert.ok(data.documents.some(doc => doc.key === 'system-mouse'))
  assert.equal(data.settings.savedBehaviors.length, backup.savedBehaviors.length)
  for (const key of ['binding', 'bindingQuality', 'quarborTarget', 'hideDriverMissingReminder']) assert.equal(data.documents[0].config[key], undefined)
  const models = ['rc003', 'cmiotA15', 'mouse'].map(code => ({ id: code, code }))
  const cloud = { models, documents: data.documents.map(doc => ({ id: doc.key, instance_key: doc.key, model_id: doc.kind, schema_version: 1, revision: 1, config: doc.config })), settings: { schema_version: 1, revision: 1, settings: data.settings } }
  const restored = prepareCloudRestore(cloud, backup, [])
  assert.equal(restored.instances[0].binding, null)
  assert.equal(restored.instances[0].audioGainDb, 6)
  assert.deepEqual(restored.backup.settings, sampleData().settings)
  assert.deepEqual(restored.backup.savedSequences, sampleData().savedSequences)
  assert.equal(prepareCloudRestore(cloud, backup, [instance]).instances[0].binding, 'physical-id')
  cloud.documents[0].config.profiles[0].behaviors.unknownInput = { click: [], doubleClick: [], longPress: [] }
  assert.throws(() => prepareCloudRestore(cloud, backup, []), /不支持/)
})
