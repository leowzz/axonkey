import assert from 'node:assert/strict'
import test from 'node:test'
import {
  behaviorToCliBehavior,
  behaviorKeysToCliKeys,
  canonicalizeCliKeyToken,
  canonicalizeCliShortcutKeys,
  cliKeysToBehaviorKeys,
  normalizeCliBehavior,
  normalizeCliSequence,
} from '../src/cliContract.ts'

test('canonicalizes platform-neutral shortcut tokens and ordering', () => {
  assert.equal(canonicalizeCliKeyToken('command'), 'Mod')
  assert.equal(canonicalizeCliKeyToken('option'), 'Alt')
  assert.deepEqual(canonicalizeCliShortcutKeys('p+shift+cmd'), ['Mod', 'Shift', 'P'])
  assert.deepEqual(canonicalizeCliShortcutKeys(['Ctrl', 'Shift', 'P']), ['Ctrl', 'Shift', 'P'])
  assert.equal(canonicalizeCliShortcutKeys(['Ctrl', 'Ctrl', 'P']), null)
  assert.equal(canonicalizeCliShortcutKeys(['Ctrl', 'A', 'B']), null)
  assert.equal(normalizeCliBehavior({ type: 'shortcut', keys: ['Mod', 'Ctrl', 'P'] }, 'windows'), null)
})

test('maps Mod to the persisted platform key names and back', () => {
  assert.deepEqual(cliKeysToBehaviorKeys(['Mod', 'Shift', 'P'], 'windows'), ['Ctrl', 'Shift', 'P'])
  assert.deepEqual(cliKeysToBehaviorKeys(['Mod', 'Shift', 'P'], 'macos'), ['Win', 'Shift', 'P'])
  assert.deepEqual(behaviorKeysToCliKeys(['Ctrl', 'Shift', 'P'], 'windows'), ['Mod', 'Shift', 'P'])
  assert.deepEqual(behaviorKeysToCliKeys(['Win', 'Shift', 'P'], 'macos'), ['Mod', 'Shift', 'P'])
})

test('normalizes every public behavior shape without exposing internal ids', () => {
  assert.deepEqual(normalizeCliBehavior({ type: 'key', key: 'escape' }, 'windows'), {
    type: 'key',
    key: 'Esc',
    enabled: true,
  })
  assert.deepEqual(normalizeCliBehavior({ type: 'shortcut', keys: 'cmd+shift+p' }, 'macos'), {
    type: 'shortcut',
    keys: ['Win', 'Shift', 'P'],
    enabled: true,
  })
  assert.deepEqual(normalizeCliBehavior({ type: 'cursorMove', direction: 'left', distance: 40.4 }, 'windows'), {
    type: 'cursorMove',
    direction: 'left',
    distance: 40,
    enabled: true,
  })
  assert.deepEqual(normalizeCliBehavior({ type: 'switchProfile', direction: 'next' }, 'windows'), {
    type: 'switchProfile',
    direction: 'next',
    wrap: true,
    enabled: true,
  })
  assert.deepEqual(normalizeCliBehavior({ type: 'typeText', text: '你好🙂\n第二行' }, 'windows'), {
    type: 'typeText',
    text: '你好🙂\n第二行',
    enabled: true,
  })
  assert.deepEqual(normalizeCliBehavior({ type: 'openPath', path: 'C:\\Users\\name\\Documents' }, 'windows'), {
    type: 'openPath',
    path: 'C:\\Users\\name\\Documents',
    enabled: true,
  })
  assert.equal(normalizeCliBehavior({ type: 'openPath', path: 'relative/file.txt' }, 'windows'), null)
  assert.equal(normalizeCliBehavior({ type: 'delay', ms: 300001 }, 'windows'), null)
  assert.equal(normalizeCliBehavior({ type: 'openWebsite', url: 'javascript:alert(1)' }, 'windows'), null)
})

test('allows an empty sequence to represent the original input', () => {
  assert.deepEqual(normalizeCliSequence([], 'windows'), [])
  assert.equal(normalizeCliSequence([{ type: 'mouse', button: 'middle' }], 'windows'), null)
})

test('exposes new text and path behaviors through the public shape', () => {
  assert.deepEqual(behaviorToCliBehavior({ id: 'text', enabled: true, type: 'typeText', text: '你好' }, 'windows'), {
    type: 'typeText',
    text: '你好',
    enabled: true,
  })
  assert.deepEqual(
    behaviorToCliBehavior(
      { id: 'path', enabled: false, type: 'openPath', path: 'C:\\Users\\name\\file.txt' },
      'windows',
    ),
    { type: 'openPath', path: 'C:\\Users\\name\\file.txt', enabled: false },
  )
})
