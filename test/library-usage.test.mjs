import assert from 'node:assert/strict'
import test from 'node:test'
import { registerHooks } from 'node:module'
import { createBehavior, createEmptyBehaviorMap, createMappingExport, parseMappingImport, parseStoredBehaviors } from '../src/behaviorModel.ts'
import { behaviorsToWorkflow, insertedWorkflowSteps, takeWorkflowLibraryAdditions, workflowBranches, workflowToBehaviors } from '../src/components/workflowBehaviorBridge.ts'
import { createSavedSequence, parseSavedSequences, savedSequenceBehaviors } from '../src/savedSequences.ts'
import { createDataBackup, parseDataBackup } from '../src/dataBackup.ts'
import { parseLibraryPage, publishRecommendation, submitSequence } from '../src/cloud/behaviorLibrary.ts'
import { createLibraryUsageReporter } from '../src/cloud/libraryUsage.ts'
import { RelayClient } from '../src/cloud/relayClient.ts'
import { sampleData } from './fixtures/data-backup.mjs'

const assets = registerHooks({ load(url, context, next) { return url.endsWith('.svg') ? { format: 'module', source: 'export default "asset.svg"', shortCircuit: true } : next(url, context) } })
const { createCloudSnapshot, prepareCloudRestore } = await import('../src/cloud/cloudData.ts')
assets.deregister()
const source = '00000000-0000-4000-8000-000000000001'
const sequence = () => [createBehavior({ type: 'key', key: 'Enter', libraryItemId: source }), createBehavior({ type: 'delay', ms: 30, libraryItemId: source }), createBehavior({ type: 'paste', text: '文本', enabled: false, libraryItemId: source })]
const withoutIds = values => values.map(({ id, ...behavior }) => behavior)

test('library provenance survives mappings, workflow edits, saved sequences, backups and cloud restore', () => {
  const behaviors = sequence()
  const map = createEmptyBehaviorMap()
  map.tv.click = behaviors
  assert.deepEqual(parseStoredBehaviors(JSON.stringify(map)).tv.click, behaviors)
  assert.deepEqual(parseMappingImport(createMappingExport(map, true)).behaviors.tv.click, behaviors)
  assert.deepEqual(workflowToBehaviors(behaviorsToWorkflow(map.tv, behavior => behavior.type)).click, behaviors)
  const saved = createSavedSequence('来自行为库', behaviors)
  assert.deepEqual(withoutIds(savedSequenceBehaviors(parseSavedSequences(JSON.stringify([saved]))[0])), withoutIds(behaviors))
  const data = sampleData()
  data.behaviors.tv.click = behaviors
  data.savedSequences = [saved]
  const backup = createDataBackup(data, '1.8.13')
  const parsed = parseDataBackup(JSON.stringify(backup))
  assert.deepEqual(withoutIds(savedSequenceBehaviors(parsed.savedSequences[0])), withoutIds(behaviors))
  const snapshot = createCloudSnapshot(backup, [])
  const document = snapshot.documents.find(item => item.key === 'legacy-rc003')
  const previousStorage = globalThis.localStorage
  globalThis.localStorage = { getItem: () => null }
  try {
    const restored = prepareCloudRestore({ models: [{ id: 'model', code: 'rc003' }], documents: [{ id: 'cloud', model_id: 'model', revision: 1, config: document.config }], settings: { settings: snapshot.settings } }, createDataBackup(sampleData(), '1.8.13'), [], { devices: [{ documentId: 'cloud', profileIds: [data.activeProfileIds.rc003], targetId: 'legacy:rc003' }], settings: false, savedBehaviors: true })
    assert.deepEqual(restored.backup.profiles.at(-1).behaviors.tv.click, behaviors)
    assert.deepEqual(withoutIds(savedSequenceBehaviors(restored.backup.savedSequences[0])), withoutIds(behaviors))
  } finally { globalThis.localStorage = previousStorage }
})

test('expanded cloud sequences keep one provenance on all actions and one temporary addition marker', () => {
  const saved = createSavedSequence('推荐序列', sequence())
  const step = parseLibraryPage({ items: [{ id: source, version_id: 'version', title: '推荐序列', source: 'community', content_schema_version: 1, platforms: ['windows'], content: { kind: 'sequence', behaviors: sequence() } }] }, 'windows', []).steps[0]
  const nodes = insertedWorkflowSteps({ ...step, id: 'inserted' }, 'windows', behavior => behavior.type)
  assert.deepEqual(nodes.map(node => node.properties.libraryItemId), [source, source, source])
  const definition = behaviorsToWorkflow({ click: [], doubleClick: [], longPress: [] }, behavior => behavior.type)
  workflowBranches(definition).click.push(...nodes)
  assert.deepEqual(takeWorkflowLibraryAdditions(definition), [source])
  assert.deepEqual(takeWorkflowLibraryAdditions(definition), [])
  assert.ok(nodes.every(node => node.properties.libraryItemId === source))
  const local = insertedWorkflowSteps({ id: 'local', type: 'savedSequence', properties: { ...saved }, componentType: 'task', name: saved.name }, 'windows', behavior => behavior.type)
  assert.deepEqual(local.filter(node => node.properties.pendingLibraryAddition).map(node => node.properties.pendingLibraryAddition), [source])
  assert.ok(local.every(node => node.properties.libraryItemId === source))
})

test('public shares and official recommendations omit private provenance metadata', async () => {
  const requests = []
  const saved = createSavedSequence('库序列', sequence())
  const client = new RelayClient(async (method, path, body) => { requests.push({ method, path, body }); return { status: 200, body: {} } }, { access_token: 'access', refresh_token: 'refresh', expires_at: Date.now() / 1000 + 3600, user: { id: 'user' } }, () => {})
  await submitSequence(client, saved, 'windows', '', false)
  await publishRecommendation(client, { type: 'savedSequence', componentType: 'task', name: saved.name, properties: { ...saved, savedSequenceId: saved.id } }, 'windows', 'composite')
  assert.equal(requests.length, 2)
  for (const request of requests) {
    assert.ok(request.body.snapshot.content.behaviors.every(behavior => !('libraryItemId' in behavior)))
    assert.deepEqual(withoutIds(request.body.snapshot.content.behaviors), withoutIds(sequence()).map(({ libraryItemId, ...behavior }) => behavior))
  }
})

test('anonymous usage times out without acknowledging and retries the identical native batch without refreshing login', async () => {
  const batch = { device_id: '00000000-0000-4000-8000-000000000002', batch_id: '00000000-0000-4000-8000-000000000003', items: [{ item_id: source, addition_count: 1, execution_count: 2 }] }
  const requests = [], acknowledged = []
  let available = true
  const client = new RelayClient(async (method, path, body, token) => {
    requests.push({ method, path, body, token })
    if (requests.length === 1) return new Promise(() => {})
    return { status: 204, body: null }
  }, { access_token: 'expired', refresh_token: 'refresh', expires_at: 0, user: { id: 'user' } }, () => { assert.fail('usage must not change login') })
  const reporter = createLibraryUsageReporter(client, 'windows', { take: async () => available ? batch : null, ack: async id => { acknowledged.push(id); available = false } }, 5)
  await Promise.all([reporter.flush(), reporter.flush()])
  assert.equal(requests.length, 1)
  assert.deepEqual(acknowledged, [])
  await reporter.flush()
  assert.equal(requests.length, 2)
  assert.deepEqual(requests[0], requests[1])
  assert.equal(requests[0].path, '/v2/behavior-library/usage')
  assert.equal(requests[0].token, undefined)
  assert.deepEqual(requests[0].body, { app_id: 'axonkey', platform: 'windows', ...batch })
  assert.deepEqual(acknowledged, [batch.batch_id])
  await reporter.flush()
  assert.equal(requests.length, 2)
})
