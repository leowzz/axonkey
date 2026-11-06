import assert from 'node:assert/strict'
import test from 'node:test'
import { solveCaptcha } from '../src/cloud/captcha.ts'

test('Cap loads domestic versioned assets, solves a fresh token and removes workers on failure', async () => {
  const previous = { window: globalThis.window, document: globalThis.document }
  const scripts = [], options = []
  let removed = 0, fail = false
  globalThis.window = {
    setTimeout, clearTimeout,
    Cap: class {
      constructor(config) { options.push(config); this.widget = { remove() { removed++ } } }
      async solve() { if (fail) throw new Error('private upstream detail'); return { success: true, token: 'one-time-token' } }
    },
  }
  globalThis.document = {
    createElement: () => ({ remove() {} }),
    head: { appendChild(script) { scripts.push(script.src); queueMicrotask(() => script.onload()) } },
  }
  const config = { enabled: true, api_endpoint: 'https://cap.wleo.cn/site/', assets_url: 'https://cap.wleo.cn/assets/' }
  try {
    assert.equal(await solveCaptcha(config), 'one-time-token')
    assert.deepEqual(scripts, ['https://cap.wleo.cn/assets/cap-widget/0.1.58/cap.min.js'])
    for (const name of ['CAP_CUSTOM_WASM_URL', 'CAP_CUSTOM_HASHWX_URL', 'CAP_PAKO_URL']) assert.ok(window[name].startsWith(config.assets_url))
    assert.equal(options[0].apiEndpoint, config.api_endpoint)
    fail = true
    await assert.rejects(solveCaptcha(config), /人机验证未完成/)
    assert.equal(options.length, 2)
    assert.equal(removed, 2)
    assert.equal(await solveCaptcha({ enabled: false }), '')
  } finally {
    globalThis.window = previous.window
    globalThis.document = previous.document
  }
})
