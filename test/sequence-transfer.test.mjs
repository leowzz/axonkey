import assert from 'node:assert/strict'
import test from 'node:test'
import { createBehavior, parseSequenceImport, serializeSequence } from '../src/behaviorModel.ts'

const payload = sequence => sequence.map(({ id, ...behavior }) => behavior)
const block = body => `axonkey/1\n${body}\nend`

test('clipboard sequences round trip every behavior, preserve order and regenerate IDs', () => {
  const sequence = [
    { type: 'shortcut', keys: ['Ctrl', 'A'] },
    { type: 'delay', ms: 20 },
    { type: 'key', key: 'Backspace' },
    { type: 'paste', text: '你好\nAxonkey' },
    { type: 'wheel', direction: 'up' },
    { type: 'mouse', button: 'back' },
    { type: 'cursorMove', direction: 'right', distance: 50 },
    { type: 'openApp', path: '/Applications/Notes.app' },
    { type: 'openWebsite', url: 'https://example.com/' },
    { type: 'disabled', enabled: false },
  ].map(createBehavior)
  const exported = payload(sequence)
  assert.ok(!serializeSequence(sequence).includes(sequence[0].id))
  const first = parseSequenceImport(serializeSequence(sequence))
  const second = parseSequenceImport(serializeSequence(sequence))
  assert.deepEqual(payload(first), exported)
  assert.deepEqual(payload(second), exported)
  const ids = [...sequence, ...first, ...second].map(step => step.id)
  assert.equal(new Set(ids).size, ids.length)
  first[0].keys.push('Shift')
  assert.deepEqual(sequence[0].keys, ['Ctrl', 'A'])
  assert.deepEqual(second[0].keys, ['Ctrl', 'A'])
})

test('only bounded text sequences are accepted, with JSON explicitly unsupported', () => {
  assert.deepEqual(parseSequenceImport(serializeSequence([])), [])
  for (const value of [
    '', 'some copied text', '{', null, [], { behaviors: [] },
    { format: 'axonkey-mapping', version: 1, behaviors: [] },
    { format: 'axonkey-sequence', version: 2, behaviors: [] },
    { format: 'axonkey-sequence', version: 1, behaviors: {} },
    { format: 'axonkey-sequence', version: 1, behaviors: [{ type: 'key', key: 'A' }] },
    JSON.stringify({ format: 'axonkey-sequence', version: 1, behaviors: [{ type: 'key', key: 'A' }] }),
    'axonkey/1\nkey A',
  ]) assert.equal(parseSequenceImport(value), null)
})

test('compact sequence text stays editable and recognizes only its versioned header', () => {
  const sequence = [
    { type: 'shortcut', keys: ['Ctrl', 'A'] }, { type: 'delay', ms: 20 },
    { type: 'shortcut', keys: ['Ctrl', 'C'] }, { type: 'delay', ms: 20 },
    { type: 'key', key: 'Backspace' },
  ].map(createBehavior)
  assert.equal(serializeSequence(sequence), block('keys Ctrl A\nwait 20ms\nkeys Ctrl C\nwait 20ms\nkey Backspace'))
  assert.deepEqual(payload(parseSequenceImport(serializeSequence(sequence).replaceAll('\n', '\r\n'))), payload(sequence))
  for (const value of [
    'keys Ctrl A', 'axonkey/2\nkey A', 'axonkey/1\nunknown A',
    'axonkey/1\nwait -1', 'axonkey/1\nwait 300001ms', 'axonkey/1\nwait nope',
    'axonkey/1\nkey A B', 'axonkey/1\nkey "unfinished', 'axonkey/1\ntext "a"b',
    'axonkey/1\noff', 'axonkey/1\nmove up 0', 'axonkey/1\nwheel wrong',
  ]) assert.equal(parseSequenceImport(value), null, value)
})

test('quoted text, empty strings, literal key symbols and disabled steps survive copying', () => {
  const sequence = [
    { type: 'paste', text: '' },
    { type: 'paste', text: '第一行\r\n"quoted"\tC:\\folder\\file\nkey A' },
    { type: 'key', key: 'Ctrl+C', enabled: false },
    { type: 'shortcut', keys: ['Ctrl', '+', '"', '\\'] },
    { type: 'shortcut', keys: ['RCtrl'] },
    { type: 'openApp', path: 'C:\\Program Files\\Tool.exe' },
  ].map(createBehavior)
  assert.deepEqual(payload(parseSequenceImport(serializeSequence(sequence))), payload(sequence))
})

test('shared captions, Markdown fences, quotes and whitespace preserve the full sequence', () => {
  const sequence = [
    { type: 'key', key: 'A' }, { type: 'delay', ms: 20 },
    { type: 'paste', text: '你好 🌍\nend\n> 原文 "quote"' },
  ].map(createBehavior)
  const snippet = serializeSequence(sequence)
  for (const shared of [
    `分享我的快捷操作\n${snippet}\n复制后粘贴到 Axonkey。`,
    `说明\n\n\x60\x60\x60text\n${snippet}\n\x60\x60\x60\n更多说明`,
    snippet.split('\n').map(line => `> ${line}`).join('\r\n'),
    snippet.split('\n').map(line => `  >> ${line}  `).join('\n'),
    `\uFEFF${snippet.replaceAll('\n', '\r')}`,
    snippet.split('\n').map(line => `\u00a0${line}\u00a0`).join('\n\n'),
  ]) assert.deepEqual(payload(parseSequenceImport(shared)), payload(sequence), shared)
  assert.equal(parseSequenceImport(`${snippet}\n另一个方案\n${snippet}`), null)
})

test('one invalid step rejects the entire shared sequence instead of silently truncating it', () => {
  for (const invalid of [
    'unknown A', 'key ""', 'key A B', 'keys', 'keys Ctrl ""',
    'wait', 'wait -1ms', 'wait 300001ms', 'wait nope',
    'move up 0', 'move up 501', 'wheel wrong',
    'text "unterminated', 'text "a"b', 'off',
    'url javascript:alert(1)', 'app relative.exe',
  ]) {
    assert.equal(parseSequenceImport(block(`key A\n${invalid}\nkey B`)), null, invalid)
  }
})
