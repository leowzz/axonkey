import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import vm from 'node:vm'
import ts from 'typescript'
import React from 'react'
import Renderer, { act } from 'react-test-renderer'

const require = createRequire(import.meta.url)
const { QRCodeSVG } = require('qrcode.react')
const source = ts.transpileModule(readFileSync('src/components/WechatGroupCard.tsx', 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020, jsx: ts.JsxEmit.ReactJSX },
}).outputText
const text = node => typeof node === 'string' ? node : (node?.children ?? []).map(text).join('')

async function mount(request) {
  const calls = []
  const module = { exports: {} }
  vm.runInNewContext(source, {
    module, exports: module.exports, require, AbortController, AbortSignal,
    fetch: async (url, options) => {
      calls.push({ url, options })
      return request(calls.length)
    },
  })
  let view
  await act(async () => { view = Renderer.create(React.createElement(module.exports.WechatGroupCard)) })
  return {
    view, calls,
    button: () => view.root.findByType('button'),
    refresh: async () => { await act(async () => view.root.findByType('button').props.onClick()) },
    close: async () => { await act(async () => view.unmount()) },
  }
}

test('loads anonymously, renders the response content as a real QR, and refreshes it', async () => {
  let finish
  const firstContent = 'https://weixin.qq.com/g/first-group'
  const secondContent = 'https://weixin.qq.com/g/replacement-group'
  const app = await mount(call => call === 1
    ? new Promise(resolve => { finish = resolve })
    : Response.json({ content: secondContent }))
  try {
    assert.match(text(app.view.toJSON()), /正在加载二维码/)
    assert.equal(app.button().props.disabled, true)
    const { url, options } = app.calls[0]
    assert.equal(url, 'https://relay.wleo.cn/api/axonkey/wechat-group-qr')
    assert.equal(options.credentials, 'omit')
    assert.equal(options.cache, 'no-store')
    assert.equal(options.headers, undefined)
    await act(async () => { finish(Response.json({ content: firstContent, updated_at: '2026-11-05T18:01:52Z' })) })
    assert.equal(app.view.root.findByType(QRCodeSVG).props.value, firstContent)
    assert.equal(app.view.root.findByType(QRCodeSVG).props.marginSize, 4)
    const firstPaths = app.view.root.findAllByType('path').map(path => path.props.d)
    assert.ok(firstPaths.some(path => path.length > 100))
    assert.equal(app.button().props.disabled, false)
    await app.refresh()
    assert.equal(app.calls.length, 2)
    assert.equal(app.view.root.findByType(QRCodeSVG).props.value, secondContent)
    assert.notDeepEqual(app.view.root.findAllByType('path').map(path => path.props.d), firstPaths)
  } finally { await app.close() }
})

test('HTTP, network and malformed responses show a retry action and recover', async () => {
  for (const failure of [
    () => new Response('', { status: 503 }),
    () => { throw new TypeError('offline') },
    () => new Response('{invalid json'),
    () => Response.json(null),
    () => Response.json({ content: 42 }),
  ]) {
    const app = await mount(call => call === 1 ? failure() : Response.json({ content: 'https://weixin.qq.com/g/recovered' }))
    try {
      assert.match(text(app.view.toJSON()), /二维码加载失败/)
      assert.equal(app.view.root.findAllByType(QRCodeSVG).length, 0)
      assert.equal(text(app.button()), '重试')
      await app.refresh()
      assert.equal(app.view.root.findByType(QRCodeSVG).props.value, 'https://weixin.qq.com/g/recovered')
    } finally { await app.close() }
  }
})

test('empty content never produces an empty QR and can be fetched again', async () => {
  const app = await mount(() => Response.json({ content: '  ' }))
  try {
    assert.match(text(app.view.toJSON()), /暂无群二维码/)
    assert.equal(app.view.root.findAllByType(QRCodeSVG).length, 0)
    assert.equal(text(app.button()), '重新获取')
    await app.refresh()
    assert.equal(app.calls.length, 2)
  } finally { await app.close() }
})

test('leaving the page cancels the active request', async () => {
  const app = await mount(() => new Promise(() => {}))
  assert.equal(app.calls[0].options.signal.aborted, false)
  await app.close()
  assert.equal(app.calls[0].options.signal.aborted, true)
})
