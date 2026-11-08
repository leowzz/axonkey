import assert from 'node:assert/strict'
import test from 'node:test'
import { deviceInputSelectionStorageKey, getStoredDeviceInput, storeDeviceInput } from '../src/deviceInputSelection.ts'

test('input selections persist independently for each device, including devices of the same model', t => {
  const values = new Map()
  const previousWindow = globalThis.window
  t.after(() => { globalThis.window = previousWindow })
  globalThis.window = { localStorage: {
    getItem: key => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, value),
  } }
  const inputs = ['power', 'voice', 'home']
  assert.equal(getStoredDeviceInput('remote-a', inputs), 'power')
  storeDeviceInput('remote-a', 'voice')
  storeDeviceInput('remote-b', 'home')
  storeDeviceInput('mouse', 'mouse.right')
  assert.equal(getStoredDeviceInput('remote-a', inputs), 'voice')
  assert.equal(getStoredDeviceInput('remote-b', inputs), 'home')
  assert.equal(getStoredDeviceInput('mouse', ['mouse.left', 'mouse.right']), 'mouse.right')
  storeDeviceInput('remote-a', 'home')
  assert.equal(getStoredDeviceInput('remote-a', inputs), 'home')
  assert.equal(getStoredDeviceInput('remote-b', inputs), 'home')

  values.set(deviceInputSelectionStorageKey, JSON.stringify({ 'remote-a': 'removed-input', 'remote-b': 42 }))
  assert.equal(getStoredDeviceInput('remote-a', inputs), 'power')
  assert.equal(getStoredDeviceInput('remote-b', inputs), 'power')
})

test('invalid or unavailable storage falls back without blocking selection', t => {
  let stored = '{invalid'
  const previousWindow = globalThis.window
  t.after(() => { globalThis.window = previousWindow })
  globalThis.window = { localStorage: {
    getItem: () => stored,
    setItem: (_, value) => { stored = value },
  } }
  for (const value of ['{invalid', 'null', '[]', '42']) {
    stored = value
    assert.equal(getStoredDeviceInput('remote', ['power', 'voice']), 'power')
  }
  storeDeviceInput('remote', 'voice')
  assert.equal(getStoredDeviceInput('remote', ['power', 'voice']), 'voice')
  Object.defineProperty(window, 'localStorage', { get: () => { throw new Error('Unavailable') } })
  assert.equal(getStoredDeviceInput('remote', ['power', 'voice']), 'power')
  assert.doesNotThrow(() => storeDeviceInput('remote', 'voice'))
})
