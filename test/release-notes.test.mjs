import assert from 'node:assert/strict'
import test from 'node:test'
import { summarizeRelease, responsesUrl } from '../scripts/generate-release-notes.mjs'

const config = { endpoint: 'https://example.com', apiKey: 'test-only', model: 'test-model', input: 'commits' }
const completed = { status: 'completed', output: [{ type: 'reasoning' }, { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: '### 修复\n- 修复问题。' }] }] }

test('normalizes Responses endpoint paths', () => {
  for (const base of ['https://example.com', 'https://example.com/', 'https://example.com/v1', 'https://example.com/v1/responses']) assert.equal(responsesUrl(base), 'https://example.com/v1/responses')
  assert.throws(() => responsesUrl('http://example.com'))
})

test('extracts only completed assistant text and sends Responses configuration', async () => {
  const notes = await summarizeRelease({ ...config, fetchImpl: async (url, options) => {
    assert.equal(url, 'https://example.com/v1/responses')
    assert.equal(options.redirect, 'error')
    assert.equal(options.headers.Authorization, 'Bearer test-only')
    const body = JSON.parse(options.body)
    assert.equal(body.model, config.model)
    assert.equal(body.store, false)
    assert.equal(body.stream, false)
    return { ok: true, json: async () => completed }
  } })
  assert.equal(notes, '### 修复\n- 修复问题。')
})

test('HTTP failure, invalid JSON, refusal, empty and incomplete results cause fallback', async () => {
  for (const data of [{ status: 'incomplete', output: completed.output }, { status: 'failed' }, { status: 'completed', output: [] }, { status: 'completed', output: [{ type: 'message', role: 'assistant', content: [{ type: 'refusal', refusal: 'No' }] }] }]) {
    await assert.rejects(summarizeRelease({ ...config, fetchImpl: async () => ({ ok: true, json: async () => data }) }))
  }
  await assert.rejects(summarizeRelease({ ...config, fetchImpl: async () => ({ ok: false }) }))
  await assert.rejects(summarizeRelease({ ...config, fetchImpl: async () => ({ ok: true, json: async () => { throw new Error('invalid JSON') } }) }))
})

test('aborts a stalled request at its deadline', async () => {
  const keepAlive = setTimeout(() => {}, 1000)
  try {
    await assert.rejects(summarizeRelease({ ...config, timeoutMs: 10, fetchImpl: (_, { signal }) => new Promise((_, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true })) }), { name: 'TimeoutError' })
  } finally { clearTimeout(keepAlive) }
})
