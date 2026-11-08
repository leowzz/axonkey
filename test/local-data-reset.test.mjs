import assert from 'node:assert/strict'
import test from 'node:test'
import { clearLocalData } from '../src/localDataReset.ts'

test('reset removes saved device instances and personal data while retaining login and driver-related state', async () => {
  const values = new Map(Object.entries({
    'axonkey.settings.v1': 'settings',
    'axonkey.mapping-profiles.v1': 'old profiles',
    'axonkey.mapping-profiles.v2': 'profiles',
    'axonkey.saved-sequences.v1': 'behaviors',
    'axonkey.audio-settings.v2': 'audio',
    'axonkey.ui-state.v1': 'preferences',
    'axonkey.device-instances.preview.v1': 'preview devices',
    'axonkey.remote-interaction-hint.v1': 'dismissed',
    'axonkey.device-hub-discovered-expanded.v1': 'collapsed',
    'axonkey.device-input-selection.v1': '{"remote":"voice"}',
    'axonkey.relay.v1': 'account',
    'axonkey.onboarding-completed.v1': 'true',
    unrelated: 'untouched',
  }))
  const removed = []
  const instances = [{ id: 'a', binding: 'physical-a' }, { id: 'b', binding: 'physical-b' }]
  await clearLocalData({ removeItem: key => values.delete(key) }, {
    snapshot: { store: { instances: [...instances] } },
    remove: async id => {
      assert.equal(values.get('axonkey.settings.v1'), 'settings')
      removed.push(id)
      instances.splice(instances.findIndex(instance => instance.id === id), 1)
    },
  })
  assert.deepEqual(removed, ['a', 'b'])
  assert.deepEqual(instances, [])
  assert.deepEqual(Object.fromEntries(values), {
    'axonkey.relay.v1': 'account',
    'axonkey.onboarding-completed.v1': 'true',
    unrelated: 'untouched',
  })
})

test('a native removal failure reports partial progress and retains personal settings for retry', async () => {
  const removed = []
  await assert.rejects(clearLocalData({ removeItem: () => assert.fail('preferences must be preserved') }, {
    snapshot: { store: { instances: [{ id: 'a' }, { id: 'b' }, { id: 'c' }] } },
    remove: async id => {
      if (id === 'b') throw new Error('写入失败')
      removed.push(id)
    },
  }), /清除未完成（已移除 1 个设备）.*写入失败/)
  assert.deepEqual(removed, ['a'])
})

test('storage failures report incomplete reset and do not claim success', async () => {
  await assert.rejects(clearLocalData({ removeItem: () => { throw new Error('存储不可用') } }, {
    snapshot: { store: { instances: [] } }, remove: async () => assert.fail('no devices to remove'),
  }), /清除未完成.*存储不可用/)
})
