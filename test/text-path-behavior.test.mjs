import assert from 'node:assert/strict'
import test from 'node:test'
import { createBehavior, createEmptyBehaviorMap, createMappingExport, normalizeBehavior, normalizeFilePath, parseMappingImport, parseSequenceImport, parseStoredBehaviors, serializeSequence } from '../src/behaviorModel.ts'
import { behaviorsToWorkflow, insertedWorkflowSteps, workflowToBehaviors } from '../src/components/workflowBehaviorBridge.ts'
import { workflowBehaviorProperties, workflowStepBehavior } from '../src/components/workflowStepEditing.ts'
import { createDataBackup, parseDataBackup } from '../src/dataBackup.ts'
import { parseBackupImport } from '../src/backupImport.ts'
import { inspectConfigMigration, legacyProfilesKey } from '../src/configMigration.ts'
import { registerHooks } from 'node:module'
const assets = registerHooks({ load(url, context, next) { return url.endsWith('.svg') ? { format: 'module', source: 'export default "asset.svg"', shortCircuit: true } : next(url, context) } })
const { createCloudSnapshot, prepareCloudRestore } = await import('../src/cloud/cloudData.ts')
assets.deregister()
import { parseLibraryPage, submitSequence } from '../src/cloud/behaviorLibrary.ts'
import { RelayClient } from '../src/cloud/relayClient.ts'
import { readCloud, uploadCloud } from '../src/cloud/cloudSync.ts'
import { sampleData } from './fixtures/data-backup.mjs'

const sequence = () => [
  createBehavior({ type: 'typeText', text: '中文🙂\n"quoted"\t', id: 'typing' }),
  createBehavior({ type: 'delay', ms: 30, id: 'wait' }),
  createBehavior({ type: 'openPath', path: 'C:\\文档 & 文件夹\\test.txt', enabled: false, id: 'path' }),
]
const withoutIds = entries => entries.map(({ id, ...entry }) => entry)
const session = { access_token: 'access', refresh_token: 'refresh', expires_at: Date.now() / 1000 + 900, user: { id: 'user', email: 'user@example.invalid', phone: null } }

test('new actions retain distinct JSON types through storage, workflow, sequence and mapping transfers', () => {
  const behaviors = sequence()
  const map = createEmptyBehaviorMap()
  map.menu.click = behaviors
  assert.deepEqual(parseStoredBehaviors(JSON.stringify(map)), map)
  const workflow = behaviorsToWorkflow(map.menu, behavior => behavior.type)
  assert.deepEqual(workflowToBehaviors(workflow), map.menu)
  const text = serializeSequence(behaviors)
  assert.match(text, /^axonkey\/2\n/)
  assert.deepEqual(withoutIds(parseSequenceImport(text)), withoutIds(behaviors))
  assert.match(serializeSequence([createBehavior({ type: 'paste', text: 'legacy' })]), /^axonkey\/1\ntext /)
  const exported = createMappingExport(map, true)
  assert.equal(exported.version, 3)
  assert.equal(exported.minAppVersion, '1.8.11')
  assert.deepEqual(parseMappingImport(exported).behaviors, map)
  assert.equal(parseMappingImport({ ...exported, version: 4 }), null)
  assert.equal(parseSequenceImport('axonkey/3\ntype "text"\nend'), null)
  assert.equal(parseSequenceImport('axonkey/2\ntype "text"\nfuture action\nend'), null)
})

test('file paths accept platform absolute paths and preserve shell characters as literal text', () => {
  for (const path of ['/Users/name/资料 & notes.txt', 'C:\\资料\\a.txt', '\\\\server\\share\\folder']) {
    assert.equal(normalizeFilePath(` "${path}" `), path)
    assert.equal(normalizeBehavior({ type: 'openPath', path }).path, path)
  }
  for (const path of ['', 'relative.txt', 'C:relative.txt', 'https://example.com', 'file:///tmp/a', '/tmp/a\0', 42]) {
    assert.equal(normalizeBehavior({ type: 'openPath', path }), null)
  }
  assert.equal(normalizeBehavior({ type: 'typeText', text: 42 }), null)
})

test('new toolbox actions remain drafts until valid editor values are saved', () => {
  for (const behavior of sequence().filter(item => item.type !== 'delay')) {
    const [step] = insertedWorkflowSteps({ id: behavior.id, type: behavior.type, componentType: 'task', name: '', properties: {} }, 'windows', item => item.type)
    assert.equal(step.properties.draftGroup, behavior.id)
    assert.equal(workflowStepBehavior(step).type, behavior.type)
    const properties = workflowBehaviorProperties(step, behavior)
    assert.ok(properties)
    assert.equal(properties[behavior.type === 'typeText' ? 'text' : 'path'], behavior[behavior.type === 'typeText' ? 'text' : 'path'])
  }
})

test('backup import and migration preserve new actions, while unknown actions reject the full import', () => {
  const data = sampleData()
  data.behaviors.tv.click = sequence()
  data.savedSequences[0].sequence = serializeSequence(sequence())
  const backup = createDataBackup(data, '1.8.11')
  assert.equal(backup.version, 3)
  const parsed = parseDataBackup(JSON.stringify(backup))
  assert.deepEqual(parsed.profiles.find(profile => profile.id === data.activeProfileIds.rc003).behaviors.tv.click, sequence())
  assert.equal(parseBackupImport(JSON.stringify(backup)).kind, 'current')
  const storage = { getItem: key => key === legacyProfilesKey ? JSON.stringify({ version: 1, profiles: [{ id: 'old', name: 'old', behaviors: { tv: { click: sequence() } } }] }) : null }
  assert.equal(inspectConfigMigration(storage).error, '')
  backup.savedBehaviors[0].behaviors.push({ type: 'futureAction' })
  assert.throws(() => parseDataBackup(JSON.stringify(backup)), /不支持.*futureAction/)
})

test('cloud upload and restore preserve new actions in legacy profiles, device instances and saved sequences', async t => {
  const data = sampleData()
  data.behaviors.tv.click = sequence()
  data.savedSequences[0].sequence = serializeSequence(sequence())
  const backup = createDataBackup(data, '1.8.11')
  const local = createDataBackup(sampleData(), '1.8.11')
  assert.equal(backup.version, 3)
  assert.equal(local.version, 2)
  const instance = { id: 'device', kind: 'rc003', name: '遥控器', enabled: true, binding: null, activeProfileId: 'profile', profiles: [{ id: 'profile', name: '新行为', behaviors: { power: { click: sequence(), doubleClick: [], longPress: [] } } }] }
  assert.deepEqual(createCloudSnapshot(local, [instance]).documents.find(doc => doc.key === instance.id).config.profiles[0].behaviors.power.click, sequence())
  const models = ['rc003', 'cmiotA15', 'mouse'].map(code => ({ id: code, code }))
  const documents = []
  let settings = null
  const client = new RelayClient(async (method, path, body) => {
    if (method === 'GET') {
      if (path.startsWith('/v2/device-models?')) return { status: 200, body: { items: models } }
      if (path.startsWith('/v2/device-configs?')) return { status: 200, body: { items: documents, total: documents.length } }
      assert.equal(path, '/v2/app-settings/axonkey')
      return settings ? { status: 200, body: settings } : { status: 404, body: { code: 'not_found' } }
    }
    if (path === '/v2/device-configs') {
      assert.equal(method, 'POST')
      const document = { ...structuredClone(body), id: body.instance_key, revision: 1 }
      documents.push(document)
      return { status: 200, body: document }
    }
    assert.equal(method, 'PUT')
    assert.equal(path, '/v2/app-settings/axonkey')
    settings = { ...structuredClone(body), revision: 1 }
    return { status: 200, body: settings }
  }, session, () => {})
  await uploadCloud(client, { ...createCloudSnapshot(backup, [instance]), source: { source_platform: 'windows', source_installation_id: '00000000-0000-4000-8000-000000000001', source_computer_name: null } }, {}, () => {})
  const cloud = await readCloud(client)
  const legacy = cloud.documents.find(doc => doc.instance_key === 'legacy-rc003')
  const device = cloud.documents.find(doc => doc.instance_key === instance.id)
  assert.deepEqual(legacy.config.profiles.find(profile => profile.id === data.activeProfileIds.rc003).behaviors.tv.click, sequence())
  assert.deepEqual(device.config.profiles[0].behaviors.power.click, sequence())
  assert.deepEqual(withoutIds(cloud.settings.settings.savedBehaviors[0].behaviors), withoutIds(sequence()))
  const previousStorage = globalThis.localStorage
  globalThis.localStorage = { getItem: () => null }
  t.after(() => { globalThis.localStorage = previousStorage })
  const restored = prepareCloudRestore(cloud, local, [], { devices: [
    { documentId: legacy.id, profileIds: [data.activeProfileIds.rc003], targetId: 'legacy:rc003' },
    { documentId: device.id, profileIds: ['profile'], targetId: 'new:restored' },
  ], settings: false, savedBehaviors: true })
  assert.equal(restored.imported, 2)
  assert.deepEqual(restored.backup.profiles.at(-1).behaviors.tv.click, sequence())
  assert.deepEqual(restored.instances[0].profiles[0].behaviors.power.click, sequence())
  assert.deepEqual(withoutIds(parseSequenceImport(restored.backup.savedSequences[0].sequence)), withoutIds(sequence()))
})

test('sharing and downloading a sequence preserve new action types, contents, order and disabled state', async () => {
  const saved = { id: 'new-actions', name: '新行为', sequence: serializeSequence(sequence()) }
  let submission
  const client = new RelayClient(async (method, path, body) => {
    assert.equal(method, 'POST')
    assert.equal(path, '/v2/behavior-library/submissions')
    submission = structuredClone(body)
    return { status: 200, body: { id: 'shared' } }
  }, session, () => {})
  await submitSequence(client, saved, 'windows', '  备注  ', false)
  assert.equal(submission.source_sequence_key, saved.id)
  assert.equal(submission.submission_note, '备注')
  assert.deepEqual(withoutIds(submission.snapshot.content.behaviors), withoutIds(sequence()))
  const page = parseLibraryPage({ items: [{ ...submission.snapshot, id: 'shared', version_id: 'v1', source: 'community' }] }, 'windows', [])
  assert.equal(page.skipped, 0)
  assert.equal(page.steps.length, 1)
  assert.deepEqual(withoutIds(parseSequenceImport(page.steps[0].properties.sequence)), withoutIds(sequence()))
})

test('cloud sequences with unknown actions are skipped whole', () => {
  const page = parseLibraryPage({ items: [{ id: 'future', version_id: 'v1', title: 'future', source: 'community', content_schema_version: 1, platforms: ['windows'], content: { kind: 'sequence', behaviors: [...sequence(), { type: 'futureAction' }] } }] }, 'windows', [])
  assert.equal(page.steps.length, 0)
  assert.equal(page.skipped, 1)
})

test('unsupported local actions disable the whole lane instead of dropping a step', () => {
  const map = createEmptyBehaviorMap()
  map.menu.click = [...sequence(), { type: 'futureAction' }]
  assert.deepEqual(parseStoredBehaviors(map).menu.click.map(item => item.type), ['disabled'])
})
