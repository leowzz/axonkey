import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync, mkdtempSync, rmSync, rmdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createRequire } from 'node:module'
import vm from 'node:vm'
import ts from 'typescript'
import React from 'react'
import Renderer, { act } from 'react-test-renderer'
import * as migration from '../src/configMigration.ts'

const require = createRequire(import.meta.url)
const text = node => typeof node === 'string' ? node : (Array.isArray(node) ? node : node?.children ?? []).map(text).join('')
function compile(file, imports, globals = {}) {
  const source = ts.transpileModule(readFileSync(file, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020, jsx: ts.JsxEmit.ReactJSX },
  }).outputText
  const module = { exports: {} }
  vm.runInNewContext(source, { module, exports: module.exports, ...globals,
    require: name => imports[name] ?? (name.endsWith('.css') ? {} : require(name)) })
  return module.exports
}
const { ConfigMigrationDialog } = compile('src/components/ConfigMigrationDialog.tsx', {}, {
  document: { activeElement: null, body: { style: { overflow: '' } } }, HTMLElement: class {},
})
const noData = { found: false, error: '', mouse: [], remote: null, mouseActiveId: '' }
const found = { ...noData, found: true, mouse: [{ name: '工作' }], remote: { profiles: [{ name: '工作' }] } }
async function dialog(plan, overrides = {}) {
  const calls = []
  let view
  await act(async () => { view = Renderer.create(React.createElement(ConfigMigrationDialog, {
    plan, busy: false, status: '', error: '', completed: false, exportedPath: '',
    remotes: [], remoteTargetId: 'new', loadingRemotes: false, remoteLoadError: '',
    onSelectRemote: id => calls.push(['select', id]), onReloadRemotes: () => calls.push('reload'),
    onStart: () => calls.push('start'), onExportAndDelete: () => calls.push('export'), onClose: () => calls.push('close'), ...overrides,
  }), { createNodeMock: () => ({ showModal() {}, close() {} }) }) })
  return { view, calls, button: label => view.root.findAllByType('button').find(node => text(node) === label),
    async click(label) { await act(async () => this.button(label).props.onClick()) },
    async close() { await act(async () => view.unmount()) } }
}

test('no old data shows only a close action', async () => {
  const ui = await dialog(noData)
  assert.match(text(ui.view.toJSON()), /无需迁移/)
  assert.equal(ui.view.root.findAllByType('button').length, 1)
  await ui.click('关闭')
  assert.deepEqual(ui.calls, ['close'])
  await ui.close()
})

test('export-and-delete and Escape require confirmation; returning preserves data', async () => {
  const ui = await dialog(found)
  assert.match(text(ui.view.toJSON()), /将覆盖当前鼠标配置/)
  await ui.click('导出并删除')
  assert.match(text(ui.view.toJSON()), /保存成功后删除应用中的旧配置/)
  assert.deepEqual(ui.calls, [])
  await ui.click('返回迁移')
  assert.deepEqual(ui.calls, [])
  await act(async () => ui.view.root.findByType('dialog').props.onCancel({ preventDefault() {} }))
  await ui.click('导出并删除')
  assert.deepEqual(ui.calls, ['export'])
  await ui.close()
})

test('start is explicit and busy state prevents closing or another action', async () => {
  const ui = await dialog(found)
  assert.deepEqual(ui.calls, [])
  await ui.click('开始迁移')
  assert.deepEqual(ui.calls, ['start'])
  await ui.close()
  const busy = await dialog(found, { busy: true, status: '正在保存…' })
  assert.ok(busy.view.root.findAllByType('button').every(button => button.props.disabled))
  await act(async () => busy.view.root.findByType('dialog').props.onCancel({ preventDefault() {} }))
  assert.deepEqual(busy.calls, [])
  await busy.close()
})

async function flow(old, instances = [], invoke, { downloads = '/Users/test/Downloads', pathError } = {}) {
  const values = new Map()
  if (old) values.set(migration.legacyProfilesKey, JSON.stringify(old))
  if (instances.length) values.set(migration.previewInstancesKey, JSON.stringify({ version: 1, revision: 7, instances }))
  const storage = { getItem: key => values.get(key) ?? null, setItem: (key, value) => values.set(key, value), removeItem: key => values.delete(key) }
  const { ConfigMigrationFlow } = compile('src/components/ConfigMigrationFlow.tsx', {
    '../app/index': { default: props => React.createElement('app', props) },
    './ConfigMigrationDialog': { ConfigMigrationDialog: props => React.createElement('migration', props) },
    '../configMigration': migration,
    '@tauri-apps/api/core': { invoke: invoke ?? (() => assert.fail('browser preview must not call native')) },
    '@tauri-apps/api/path': { downloadDir: async () => {
      if (pathError) throw new Error(pathError)
      return downloads
    }, join: async (...parts) => join(...parts) },
  }, { window: { localStorage: storage, ...(invoke ? { __TAURI_INTERNALS__: {} } : {}) }, JSON })
  let view
  await act(async () => { view = Renderer.create(React.createElement(ConfigMigrationFlow)) })
  return { view, storage, values }
}
const old = { version: 1, activeProfileId: 'one', profiles: [{ id: 'one', name: '工作', behaviors: { power: 'A', 'mouse.top.up': 'B' } }] }

test('startup holds the app until save completes, then requests binding of the newly saved remote', async () => {
  const { view, storage } = await flow(old)
  assert.equal(view.root.findAllByType('app').length, 0)
  assert.ok(storage.getItem(migration.legacyProfilesKey))
  await act(async () => { view.root.findByType('migration').props.onStart(); await Promise.resolve() })
  const app = view.root.findByType('app')
  const saved = JSON.parse(storage.getItem(migration.previewInstancesKey))
  assert.equal(saved.instances.length, 1)
  assert.equal(saved.instances[0].id, app.props.initialBindingId)
  assert.equal(saved.instances[0].profiles[0].behaviors.power.click[0].key, 'A')
  assert.equal(storage.getItem(migration.legacyProfilesKey), null)
  await act(async () => app.props.onOpenConfigMigration())
  assert.equal(view.root.findByType('migration').props.plan.found, false)
  await act(async () => view.root.findByType('migration').props.onClose())
  assert.equal(view.root.findByType('app').props.initialBindingId, null)
  await act(async () => view.unmount())
})

test('manual entry with no old data shows the result and closes back to the app', async () => {
  const { view } = await flow()
  await act(async () => view.root.findByType('app').props.onOpenConfigMigration())
  assert.equal(view.root.findAllByType('app').length, 0)
  assert.equal(view.root.findByType('migration').props.plan.found, false)
  await act(async () => view.root.findByType('migration').props.onClose())
  assert.equal(view.root.findAllByType('app').length, 1)
  await act(async () => view.unmount())
})

test('export writes a complete file to Downloads before deleting old source, without creating a device', async () => {
  const downloads = mkdtempSync(join(tmpdir(), 'axonkey-migration-export-'))
  let completeWrite
  const pendingWrite = new Promise(resolve => { completeWrite = resolve })
  let exported
  const { view, storage } = await flow(old, [], async (command, args) => {
    if (command === 'device_snapshot') return { error: null, store: { version: 1, revision: 0, instances: [] } }
    assert.equal(command, 'write_mapping_file')
    exported = args
    await pendingWrite
    writeFileSync(args.path, args.content, 'utf8')
  }, { downloads })
  const props = () => view.root.findByType('migration').props
  try {
    const before = storage.getItem(migration.legacyProfilesKey)
    await act(async () => { props().onExportAndDelete(); await Promise.resolve() })
    assert.equal(props().busy, true)
    assert.equal(props().completed, false)
    assert.equal(storage.getItem(migration.legacyProfilesKey), before, 'wait for the file write')
    await act(async () => { completeWrite(); await Promise.resolve() })
    assert.equal(exported.path, join(downloads, exported.path.split(/[\\/]/).pop()))
    assert.match(exported.path, /axonkey-legacy-config-\d{8}-\d{6}\.json$/)
    const document = JSON.parse(readFileSync(exported.path, 'utf8'))
    assert.equal(document.storage[migration.legacyProfilesKey], before)
    assert.equal(storage.getItem(migration.legacyProfilesKey), null)
    assert.equal(storage.getItem(migration.previewInstancesKey), null)
    assert.equal(props().exportedPath, exported.path)
    assert.equal(props().completed, true)
    await act(async () => props().onClose())
    assert.equal(view.root.findByType('app').props.initialBindingId, null)
  } finally {
    await act(async () => view.unmount())
    if (exported) rmSync(exported.path, { force: true })
    rmdirSync(downloads)
  }
})

test('download directory and write failures retain all old data and allow retry', async () => {
  for (const failure of ['directory', 'write']) {
    let failWrite = failure === 'write'
    const { view, storage, values } = await flow(old, [], async (command) => {
      if (command === 'device_snapshot') return { error: null, store: { version: 1, revision: 0, instances: [] } }
      assert.equal(command, 'write_mapping_file')
      if (failWrite) throw new Error('磁盘已满')
    }, { pathError: failure === 'directory' ? '无法获取下载目录' : undefined })
    const before = new Map(values)
    const props = () => view.root.findByType('migration').props
    await act(async () => { props().onExportAndDelete(); await Promise.resolve() })
    assert.deepEqual(values, before)
    assert.match(props().error, /导出失败，未删除旧配置/)
    assert.equal(props().busy, false)
    assert.equal(props().completed, false)
    if (failure === 'write') {
      failWrite = false
      await act(async () => { props().onExportAndDelete(); await Promise.resolve() })
      assert.equal(storage.getItem(migration.legacyProfilesKey), null)
      assert.equal(props().completed, true)
    }
    await act(async () => view.unmount())
  }
})

test('browser preview cannot confirm a disk write and keeps old data', async () => {
  const { view, values } = await flow(old)
  const before = new Map(values)
  await act(async () => { view.root.findByType('migration').props.onExportAndDelete(); await Promise.resolve() })
  assert.deepEqual(values, before)
  assert.match(view.root.findByType('migration').props.error, /请在桌面应用中/)
  await act(async () => view.unmount())
})

test('export success shows the actual file path and close even when the old config cannot migrate', async () => {
  const ui = await dialog({ ...found, error: '旧配置无法解析' }, {
    completed: true, exportedPath: 'C:\\用户\\下载\\axonkey-legacy-config.json',
  })
  assert.match(text(ui.view.toJSON()), /旧配置已导出并删除/)
  assert.match(text(ui.view.toJSON()), /C:\\用户\\下载/)
  assert.doesNotMatch(text(ui.view.toJSON()), /旧配置无法解析/)
  assert.equal(ui.view.root.findAllByType('button').length, 1)
  await ui.click('关闭')
  assert.deepEqual(ui.calls, ['close'])
  await ui.close()
})

const existing = (id, kind = 'rc003', binding = 'physical-' + id) => ({
  id, kind, name: '遥控器 ' + id, binding, enabled: false, audioGainDb: 3,
  profiles: [{ id: 'current', name: '当前配置', behaviors: {} }], activeProfileId: 'current',
})

test('existing remotes require a destination and disclose overwrite before starting', async () => {
  const ui = await dialog(found, { remotes: [existing('living'), existing('study')], remoteTargetId: '' })
  assert.equal(ui.button('开始迁移').props.disabled, true)
  const select = ui.view.root.findByType('select')
  assert.deepEqual(select.findAllByType('option').map(option => option.props.value), ['', 'living', 'study', 'new'])
  await act(async () => select.props.onChange({ target: { value: 'study' } }))
  assert.deepEqual(ui.calls, [['select', 'study']])
  await ui.close()
  const selected = await dialog(found, { remotes: [existing('study')], remoteTargetId: 'study' })
  assert.equal(selected.button('开始迁移').props.disabled, false)
  assert.match(text(selected.view.toJSON()), /将覆盖该遥控器的全部配置/)
  await selected.close()
})

test('loading or failed device inspection blocks migration and offers a read retry', async () => {
  const loading = await dialog(found, { loadingRemotes: true })
  assert.equal(loading.button('开始迁移').props.disabled, true)
  assert.match(text(loading.view.toJSON()), /正在检查已有遥控器/)
  await loading.close()
  const failed = await dialog(found, { remoteLoadError: '设备读取失败' })
  assert.equal(failed.button('开始迁移').props.disabled, true)
  await failed.click('重新检查')
  assert.deepEqual(failed.calls, ['reload'])
  await failed.close()
})

test('only matching remotes are offered and overwrite updates exactly the selected bound instance', async () => {
  const instances = [existing('living'), existing('other', 'cmiotA15'), existing('study')]
  const { view, storage } = await flow(old, instances)
  const props = () => view.root.findByType('migration').props
  assert.deepEqual(Array.from(props().remotes, remote => remote.id), ['living', 'study'])
  assert.equal(props().remoteTargetId, '')
  await act(async () => props().onSelectRemote('study'))
  await act(async () => { props().onStart(); await Promise.resolve() })
  const saved = JSON.parse(storage.getItem(migration.previewInstancesKey))
  assert.equal(saved.revision, 8)
  assert.equal(saved.instances.length, 3)
  assert.deepEqual(saved.instances.slice(0, 2), instances.slice(0, 2))
  assert.deepEqual(saved.instances[2], { ...instances[2], profiles: props().plan.remote.profiles,
    activeProfileId: props().plan.remote.activeProfileId })
  assert.equal(props().completed, true)
  await act(async () => props().onClose())
  assert.equal(view.root.findByType('app').props.initialBindingId, null)
  await act(async () => view.unmount())
})

test('new remote remains an explicit option when matching devices exist', async () => {
  const instances = [existing('living')]
  const { view, storage } = await flow(old, instances)
  await act(async () => view.root.findByType('migration').props.onSelectRemote('new'))
  await act(async () => { view.root.findByType('migration').props.onStart(); await Promise.resolve() })
  const saved = JSON.parse(storage.getItem(migration.previewInstancesKey))
  assert.equal(saved.instances.length, 2)
  assert.deepEqual(saved.instances[0], instances[0])
  assert.notEqual(saved.instances[1].id, instances[0].id)
  assert.equal(view.root.findByType('app').props.initialBindingId, saved.instances[1].id)
  await act(async () => view.unmount())
})

test('a resumed overwrite preselects its existing unbound target and opens binding after saving', async () => {
  const { view, storage } = await flow({ ...old, migrationRemoteTargetId: 'study', migrationRemoteId: 'new-remote' },
    [existing('study', 'rc003', null)])
  assert.equal(view.root.findByType('migration').props.remoteTargetId, 'study')
  await act(async () => { view.root.findByType('migration').props.onStart(); await Promise.resolve() })
  assert.equal(JSON.parse(storage.getItem(migration.previewInstancesKey)).instances.length, 1)
  assert.equal(view.root.findByType('app').props.initialBindingId, 'study')
  await act(async () => view.unmount())
})

test('native device read failure keeps old data, retry lists targets and saves with the native revision', async () => {
  let reads = 0
  const writes = []
  const target = existing('native')
  const { view, storage } = await flow(old, [], async (command, args) => {
    if (command === 'device_snapshot') {
      if (++reads === 1) throw new Error('设备服务读取失败')
      return { error: null, store: { version: 1, revision: 12, instances: [target] } }
    }
    assert.equal(command, 'put_device_instance')
    writes.push(args)
  })
  const props = () => view.root.findByType('migration').props
  assert.match(props().remoteLoadError, /设备服务读取失败/)
  assert.equal(writes.length, 0)
  assert.ok(storage.getItem(migration.legacyProfilesKey))
  await act(async () => { props().onReloadRemotes(); await Promise.resolve() })
  assert.equal(props().remoteLoadError, '')
  assert.equal(props().remotes[0].id, 'native')
  await act(async () => props().onSelectRemote('native'))
  await act(async () => { props().onStart(); await Promise.resolve() })
  assert.equal(writes.length, 1)
  assert.equal(writes[0].revision, 12)
  assert.equal(writes[0].instance.id, target.id)
  assert.equal(writes[0].instance.binding, target.binding)
  assert.equal(writes[0].instance.profiles[0].behaviors.power.click[0].key, 'A')
  assert.equal(props().completed, true)
  assert.equal(storage.getItem(migration.legacyProfilesKey), null)
  await act(async () => view.unmount())
})
