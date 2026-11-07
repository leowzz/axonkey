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
const { createCloudSnapshot } = await import('../src/cloud/cloudData.ts')
assets.deregister()
import { parseLibraryPage, submitSequence } from '../src/cloud/behaviorLibrary.ts'
import { sampleData } from './fixtures/data-backup.mjs'

const sequence = () => [
  createBehavior({ type: 'typeText', text: '中文🙂\n"quoted"\t', id: 'typing' }),
  createBehavior({ type: 'delay', ms: 30, id: 'wait' }),
  createBehavior({ type: 'openPath', path: 'C:\\文档 & 文件夹\\test.txt', enabled: false, id: 'path' }),
]
const withoutIds = entries => entries.map(({ id, ...entry }) => entry)

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

test('cloud upload and sharing reject new actions before sending any requests; unknown sequences are skipped whole', () => {
  const data = sampleData()
  data.savedSequences[0].sequence = serializeSequence(sequence())
  const backup = createDataBackup(data, '1.8.11')
  assert.throws(() => createCloudSnapshot(backup, []), /云端尚不支持/)
  assert.throws(() => submitSequence({ request() { assert.fail('must not send') } }, data.savedSequences[0], 'windows', '', false), /云端行为库尚不支持/)
  const page = parseLibraryPage({ items: [{ id: 'future', version_id: 'v1', title: 'future', source: 'community', content_schema_version: 1, platforms: ['windows'], content: { kind: 'sequence', behaviors: [...sequence(), { type: 'futureAction' }] } }] }, 'windows', [])
  assert.equal(page.steps.length, 0)
  assert.equal(page.skipped, 1)
})

test('unsupported local actions disable the whole lane instead of dropping a step', () => {
  const map = createEmptyBehaviorMap()
  map.menu.click = [...sequence(), { type: 'futureAction' }]
  assert.deepEqual(parseStoredBehaviors(map).menu.click.map(item => item.type), ['disabled'])
})
