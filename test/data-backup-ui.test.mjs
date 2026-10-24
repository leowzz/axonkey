import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import vm from 'node:vm'
import ts from 'typescript'
import React from 'react'
import Renderer, { act } from 'react-test-renderer'
import * as model from '../src/dataBackup.ts'
import { devices } from '../src/deviceModel.ts'
import { sampleData } from './fixtures/data-backup.mjs'

const require = createRequire(import.meta.url)
const text = node => typeof node === 'string' ? node : (Array.isArray(node) ? node : node?.children ?? []).map(text).join('')
const backup = () => model.createDataBackup(sampleData(), '1.0.14', new Date(2026, 9, 22, 18, 2, 3))

async function setup({ saveResult = '/backup.json', exportError, restoreError, openError } = {}) {
  const source = ts.transpileModule(readFileSync('src/components/DataBackupSettings.tsx', 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020, jsx: ts.JsxEmit.ReactJSX },
  }).outputText
  const calls = []
  const restores = []
  const module = { exports: {} }
  vm.runInNewContext(source, {
    module, exports: module.exports, Date, Error,
    require(name) {
      if (name === '../dataBackup') return model
      if (name === '../deviceModel') return { devices }
      if (name === './SettingsHelp') return { SettingsHelp: props => React.createElement('help', props) }
      if (name === '../runtimeLogging') return { logError() {} }
      if (name === '@tauri-apps/plugin-dialog') return { save: async options => { calls.push({ type: 'save', options }); return typeof saveResult === 'function' ? saveResult() : saveResult } }
      if (name === '@tauri-apps/api/core') return { invoke: async (command, args) => {
        calls.push({ type: 'invoke', command, args })
        if (exportError) throw new Error(exportError)
        if (command === 'open_backup_location' && openError) throw new Error(openError)
      } }
      return require(name)
    },
  })
  let view
  await act(async () => { view = Renderer.create(React.createElement(module.exports.DataBackupSettings, {
    nativeRuntime: true, onCreateBackup: backup,
    onRestoreBackup: data => { if (restoreError) throw new Error(restoreError); restores.push(data) },
  })) })
  const button = label => view.root.findAllByType('button').find(node => text(node) === label)
  return {
    view, calls, restores, button,
    content: () => text(view.toJSON()),
    click: async label => { await act(async () => button(label).props.onClick()) },
    async importFile(content, name = 'axonkey-backup-20261022-180203.json') {
      const target = { files: [{ name, text: typeof content === 'string' ? async () => content : content }], value: 'selected.json' }
      await act(async () => view.root.findByType('input').props.onChange({ target }))
      assert.equal(target.value, '', 'the same file can be selected again')
    },
    unmount: async () => { await act(async () => view.unmount()) },
  }
}

test('native backup export proposes a timestamped filename and writes a complete restorable JSON', async () => {
  const app = await setup()
  try {
    await app.click('导出备份')
    assert.equal(app.calls[0].options.defaultPath, 'axonkey-backup-20261022-180203.json')
    assert.equal(app.calls[1].command, 'write_mapping_file')
    assert.equal(app.calls[1].args.path, '/backup.json')
    assert.equal(model.parseDataBackup(app.calls[1].args.content).profiles.length, 4)
    assert.ok(app.content().includes('已导出 backup.json'))
    assert.ok(app.button('打开文件'))
    assert.ok(app.button('打开目录'))
  } finally { await app.unmount() }
})

test('cancelling export writes nothing and a failed file write reports failure without claiming success', async () => {
  const canceled = await setup({ saveResult: null })
  try {
    await canceled.click('导出备份')
    assert.equal(canceled.calls.length, 1)
    assert.ok(!canceled.content().includes('已导出'))
    assert.equal(canceled.button('打开文件'), undefined)
    assert.equal(canceled.button('打开目录'), undefined)
  } finally { await canceled.unmount() }
  const failed = await setup({ exportError: '磁盘已满' })
  try {
    await failed.click('导出备份')
    assert.ok(failed.content().includes('磁盘已满'))
    assert.ok(!failed.content().includes('已导出'))
    assert.equal(failed.button('导出备份').props.disabled, false)
    assert.equal(failed.button('打开文件'), undefined)
  } finally { await failed.unmount() }
})

test('post-export actions open the actual chosen file and its containing folder', async () => {
  const path = '/用户/我的备份 100% & data.json'
  const app = await setup({ saveResult: path })
  try {
    assert.equal(app.button('打开文件'), undefined)
    await app.click('导出备份')
    assert.ok(app.content().includes('已导出 我的备份 100% & data.json'))
    await app.click('打开文件')
    assert.equal(app.calls.at(-1).command, 'open_backup_location')
    assert.equal(app.calls.at(-1).args.path, path)
    assert.equal(app.calls.at(-1).args.directory, false)
    await app.click('打开目录')
    assert.equal(app.calls.at(-1).args.path, path)
    assert.equal(app.calls.at(-1).args.directory, true)
  } finally { await app.unmount() }
})

test('opening errors retain export actions for retry, while a canceled new export clears stale actions', async () => {
  let path = '/backup.json'
  const app = await setup({ saveResult: () => path, openError: '备份文件不存在' })
  try {
    await app.click('导出备份')
    await app.click('打开文件')
    assert.ok(app.content().includes('打开文件失败：备份文件不存在'))
    assert.equal(app.button('打开文件').props.disabled, false)
    path = null
    await app.click('导出备份')
    assert.equal(app.button('打开文件'), undefined)
    assert.equal(app.button('打开目录'), undefined)
  } finally { await app.unmount() }
})

test('import previews all profiles and saved behaviors, cancel leaves data untouched, and only explicit confirmation restores', async () => {
  const app = await setup()
  try {
    const file = JSON.stringify(backup())
    await app.importFile(file)
    for (const expected of ['工作（导入后使用）', '娱乐（导入后使用）', '小米遥控器 ·', '鼠标 ·', '粘贴并确认', '将覆盖当前所有配置文件', '重新加载界面']) assert.ok(app.content().includes(expected), expected)
    assert.equal(app.restores.length, 0)
    await app.click('取消')
    assert.equal(app.restores.length, 0)
    assert.equal(app.view.root.findAllByProps({ 'aria-label': '备份导入预览' }).length, 0)
    await app.importFile(file)
    await app.click('导入并覆盖')
    assert.equal(app.restores.length, 1)
    assert.deepEqual(app.restores[0].activeProfileIds, { rc003: 'rc003:play', mouse: 'mouse:work' })
    assert.equal(app.button('导入并覆盖').props.disabled, true, 'avoid duplicate imports while the app reloads')
  } finally { await app.unmount() }
})

test('invalid imports and restore failures never claim success or discard the preview needed for retry', async () => {
  const app = await setup({ restoreError: '存储空间不足' })
  try {
    await app.importFile('invalid JSON')
    assert.equal(app.restores.length, 0)
    assert.equal(app.view.root.findAllByProps({ 'aria-label': '备份导入预览' }).length, 0)
    assert.ok(app.content().includes('不是有效的 JSON'))
    await app.importFile(JSON.stringify(backup()))
    await app.click('导入并覆盖')
    assert.ok(app.content().includes('存储空间不足'))
    assert.equal(app.button('导入并覆盖').props.disabled, false)
    assert.equal(app.restores.length, 0)
  } finally { await app.unmount() }
})

test('late file reads cannot restore or reopen a preview after leaving settings', async () => {
  let resolve
  const pending = new Promise(done => { resolve = done })
  const app = await setup()
  await app.importFile(() => pending)
  await app.unmount()
  await act(async () => resolve(JSON.stringify(backup())))
  assert.equal(app.restores.length, 0)
})
