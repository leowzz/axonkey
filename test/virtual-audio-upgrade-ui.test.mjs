import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import vm from 'node:vm'
import ts from 'typescript'
import React from 'react'
import Renderer, { act } from 'react-test-renderer'
import * as migration from '../src/configMigration.ts'

const require = createRequire(import.meta.url)
const text = node => typeof node === 'string' ? node : (Array.isArray(node) ? node : node?.children ?? []).map(text).join('')
const deferred = () => {
  let resolve, reject
  const promise = new Promise((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}
const installResult = { driverInstalled: true, rebootRequired: false, logPath: 'new-driver.log' }
const removalResult = { rebootRequired: false, logPath: 'old-driver.log', error: null }

async function flow({ old = true, native = true, probe = true, installed = false, install = installResult, remove = removalResult, manual = false } = {}) {
  const calls = []
  const values = new Map(old ? [[migration.legacyProfilesKey, JSON.stringify({ version: 1, activeProfileId: 'one', profiles: [{ id: 'one', name: '旧配置', behaviors: { power: 'A' } }] })]] : [])
  const before = new Map(values)
  const storage = { getItem: key => values.get(key) ?? null, setItem: () => assert.fail('upgrade must not migrate configurations'), removeItem: () => assert.fail('upgrade must not remove configurations') }
  const source = ts.transpileModule(readFileSync('src/components/VirtualAudioUpgradeFlow.tsx', 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020, jsx: ts.JsxEmit.ReactJSX },
  }).outputText
  const module = { exports: {} }
  vm.runInNewContext(source, { module, exports: module.exports,
    window: { localStorage: storage, ...(native ? { __TAURI_INTERNALS__: {} } : {}) },
    document: { activeElement: null, body: { style: { overflow: '' } } }, HTMLElement: class {},
    require: name => name.endsWith('.css') ? {} : name === '../configMigration' ? migration
      : name === '@tauri-apps/api/core' ? { invoke: async (command, args) => {
        calls.push([command, args])
        const result = command === 'probe_legacy_audio_driver' ? probe : command === 'probe_windows_audio_driver' ? installed : command === 'launch_driver_action' ? install : command === 'uninstall_legacy_audio_driver' ? remove : assert.fail(command)
        if (result instanceof Error) throw result
        const reply = await (typeof result === 'function' ? result() : result)
        if (command === 'launch_driver_action' && reply.driverInstalled === true) installed = true
        return reply
      } } : require(name),
  })
  let mounted = 0, completed = 0
  function ConfigurationMigration() { React.useEffect(() => { mounted++ }, []); return React.createElement('migration') }
  const appSource = ts.transpileModule(readFileSync('src/App.tsx', 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020, jsx: ts.JsxEmit.ReactJSX },
  }).outputText
  const appModule = { exports: {} }
  vm.runInNewContext(appSource, { module: appModule, exports: appModule.exports, require: name => {
    if (name === './components/VirtualAudioUpgradeFlow') return module.exports
    if (name === './components/ConfigMigrationFlow') return { ConfigMigrationFlow: ConfigurationMigration }
    if (name === './components/DriverMigrationDialog') return { DriverMigrationFlow: ({ children }) => children }
    if (name === './components/LegacyCleanupDialog') return { LegacyCleanupFlow: ({ children }) => children }
    return require(name)
  } })
  let view
  const element = manual
    ? React.createElement(module.exports.VirtualAudioUpgradeDialog, { manual: true, onContinue: () => completed++ })
    : React.createElement(appModule.exports.default)
  await act(async () => { view = Renderer.create(element, {
    createNodeMock: () => ({ showModal() {}, close() {}, focus() {} }),
  }) })
  return {
    view, calls, get mounted() { return mounted }, get completed() { return completed },
    button(label) { return view.root.findAllByType('button').find(button => text(button) === label) },
    async click(label) { await act(async () => { this.button(label).props.onClick() }) },
    async escape() { await act(async () => view.root.findByType('dialog').props.onCancel({ preventDefault() {} })) },
    async close() { assert.deepEqual(values, before); await act(async () => view.unmount()) },
  }
}
const commands = ui => ui.calls.map(call => call[0])

test('manual settings entry opens without legacy config and returns to settings instead of migration', async () => {
  const ui = await flow({ old: false, manual: true })
  assert.deepEqual(commands(ui), [])
  assert.doesNotMatch(text(ui.view.toJSON()), /检测到你的电脑安装了/)
  await ui.click('只安装新版')
  assert.deepEqual(commands(ui), ['probe_windows_audio_driver', 'launch_driver_action'])
  assert.equal(ui.button('继续迁移配置'), undefined)
  await ui.click('完成')
  assert.equal(ui.completed, 1)
  assert.equal(ui.mounted, 0)
  await ui.close()
  const skip = await flow({ old: false, manual: true })
  await skip.click('跳过')
  assert.doesNotMatch(text(skip.view.toJSON()), /迁移配置/)
  assert.equal(skip.completed, 0)
  await skip.click('仍然跳过')
  assert.equal(skip.completed, 1)
  assert.deepEqual(commands(skip), [])
  await skip.close()
})

test('only native startup with old configurations probes; absent old device proceeds directly', async () => {
  for (const options of [{ old: false }, { native: false }, { probe: false }]) {
    const ui = await flow(options)
    assert.equal(ui.mounted, 1)
    assert.equal(ui.view.root.findAllByType('dialog').length, 0)
    assert.deepEqual(commands(ui), options.probe === false ? ['probe_legacy_audio_driver'] : [])
    await ui.close()
  }
})

test('both upgrade choices skip installation when Quarbor is already installed', async () => {
  for (const removeLegacy of [false, true]) {
    const ui = await flow({ installed: true, install: () => assert.fail('must not reinstall an existing driver') })
    await ui.click(removeLegacy ? '卸载VB-CABLE并安装新版' : '只安装新版')
    assert.deepEqual(commands(ui), [
      'probe_legacy_audio_driver', 'probe_windows_audio_driver',
      ...(removeLegacy ? ['uninstall_legacy_audio_driver'] : []),
    ])
    assert.match(text(ui.view.toJSON()), /已跳过安装/)
    assert.doesNotMatch(text(ui.view.toJSON()), /需要重启电脑/)
    assert.equal(ui.mounted, 0)
    assert.ok(ui.button('继续迁移配置'))
    await ui.close()
  }
})

test('Quarbor status failure blocks install and cleanup, and retry checks actual state again', async () => {
  let attempts = 0
  const ui = await flow({ installed: () => ++attempts === 1 ? Promise.reject('status failed') : true })
  await ui.click('卸载VB-CABLE并安装新版')
  assert.deepEqual(commands(ui), ['probe_legacy_audio_driver', 'probe_windows_audio_driver'])
  assert.match(text(ui.view.toJSON()), /status failed/)
  assert.equal(ui.button('继续迁移配置'), undefined)
  await ui.click('卸载VB-CABLE并安装新版')
  assert.deepEqual(commands(ui), ['probe_legacy_audio_driver', 'probe_windows_audio_driver', 'probe_windows_audio_driver', 'uninstall_legacy_audio_driver'])
  assert.match(text(ui.view.toJSON()), /已跳过安装/)
  await ui.close()
})

test('pending Quarbor check blocks duplicate actions and Escape before cleanup can start', async () => {
  const check = deferred()
  const ui = await flow({ installed: check.promise })
  await ui.click('卸载VB-CABLE并安装新版')
  assert.match(text(ui.view.toJSON()), /正在检查 Quarbor/)
  assert.ok(ui.view.root.findAllByType('button').every(button => button.props.disabled))
  await ui.escape()
  await ui.click('卸载VB-CABLE并安装新版')
  assert.deepEqual(commands(ui), ['probe_legacy_audio_driver', 'probe_windows_audio_driver'])
  await act(async () => check.resolve(true))
  assert.deepEqual(commands(ui), ['probe_legacy_audio_driver', 'probe_windows_audio_driver', 'uninstall_legacy_audio_driver'])
  await ui.close()
})

test('reboot notice includes both sources when new installation and old removal request a restart', async () => {
  const ui = await flow({ install: { ...installResult, rebootRequired: true }, remove: { ...removalResult, rebootRequired: true } })
  await ui.click('卸载VB-CABLE并安装新版')
  assert.match(text(ui.view.toJSON()), /Quarbor 驱动安装需要重启电脑/)
  assert.match(text(ui.view.toJSON()), /VB-CABLE 卸载需要重启电脑/)
  await ui.close()
})

test('both old configurations and VB-CABLE gate configuration migration until confirmed skip', async () => {
  const ui = await flow()
  assert.equal(ui.mounted, 0)
  assert.match(text(ui.view.toJSON()), /VB-CABLE/)
  await ui.click('跳过')
  assert.match(text(ui.view.toJSON()), /跳过会导致遥控器麦克风功能失效/)
  assert.equal(ui.mounted, 0)
  await ui.click('返回升级')
  await act(async () => ui.view.root.findByType('dialog').props.onKeyDown({ key: 'Escape', preventDefault() {}, stopPropagation() {} }))
  assert.match(text(ui.view.toJSON()), /跳过会导致遥控器麦克风功能失效/)
  await ui.click('返回升级')
  await ui.escape()
  assert.equal(ui.mounted, 0)
  await ui.click('仍然跳过')
  assert.equal(ui.mounted, 1)
  assert.deepEqual(commands(ui), ['probe_legacy_audio_driver'])
  await ui.close()
})

test('device probe failure is retryable and never offers uninstall without detecting VB-CABLE', async () => {
  let attempts = 0
  const ui = await flow({ probe: () => ++attempts === 1 ? Promise.reject('probe failed') : true })
  assert.equal(ui.mounted, 0)
  assert.match(text(ui.view.toJSON()), /probe failed/)
  assert.equal(ui.button('卸载VB-CABLE并安装新版'), undefined)
  await ui.click('重新检查')
  assert.equal(attempts, 2)
  assert.ok(ui.button('卸载VB-CABLE并安装新版'))
  await ui.close()
})

test('only-install reuses audio install command and keeps old driver; user acknowledges result', async () => {
  const ui = await flow({ install: { ...installResult, rebootRequired: true, warning: '安装器提示' } })
  await ui.click('只安装新版')
  assert.equal(ui.calls[2][0], 'launch_driver_action')
  assert.equal(ui.calls[2][1].driver, 'audio')
  assert.equal(ui.calls[2][1].action, 'install')
  assert.deepEqual(commands(ui), ['probe_legacy_audio_driver', 'probe_windows_audio_driver', 'launch_driver_action'])
  assert.match(text(ui.view.toJSON()), /已保留 VB-CABLE/)
  assert.match(text(ui.view.toJSON()), /需要重启电脑/)
  assert.match(text(ui.view.toJSON()), /Quarbor 驱动安装需要重启/)
  assert.doesNotMatch(text(ui.view.toJSON()), /VB-CABLE 卸载需要重启/)
  assert.match(text(ui.view.toJSON()), /安装器提示/)
  assert.equal(ui.mounted, 0)
  await ui.click('继续迁移配置')
  assert.equal(ui.mounted, 1)
  await ui.close()
})

test('combined upgrade installs first, blocks Escape/duplicates while busy, then removes old driver', async () => {
  const install = deferred(), remove = deferred()
  const ui = await flow({ install: install.promise, remove: remove.promise })
  await ui.click('卸载VB-CABLE并安装新版')
  assert.ok(ui.view.root.findAllByType('button').every(button => button.props.disabled))
  await ui.escape()
  await ui.click('卸载VB-CABLE并安装新版')
  assert.equal(ui.calls.length, 3)
  await act(async () => install.resolve(installResult))
  assert.deepEqual(commands(ui), ['probe_legacy_audio_driver', 'probe_windows_audio_driver', 'launch_driver_action', 'uninstall_legacy_audio_driver'])
  assert.equal(ui.mounted, 0)
  await act(async () => remove.resolve({ ...removalResult, rebootRequired: true }))
  assert.match(text(ui.view.toJSON()), /VB-CABLE 已卸载/)
  assert.match(text(ui.view.toJSON()), /需要重启电脑/)
  assert.match(text(ui.view.toJSON()), /VB-CABLE 卸载需要重启/)
  assert.doesNotMatch(text(ui.view.toJSON()), /Quarbor 驱动安装需要重启/)
  assert.match(text(ui.view.toJSON()), /old-driver.log/)
  assert.equal(ui.mounted, 0)
  await ui.click('继续迁移配置')
  assert.equal(ui.mounted, 1)
  await ui.close()
})

test('failed/cancelled/unconfirmed new installation never uninstalls the old driver', async () => {
  for (const install of [new Error('UAC cancelled'), { ...installResult, driverInstalled: false }, { ...installResult, driverInstalled: undefined, rebootRequired: true }]) {
    const ui = await flow({ install })
    await ui.click('卸载VB-CABLE并安装新版')
    assert.deepEqual(commands(ui), ['probe_legacy_audio_driver', 'probe_windows_audio_driver', 'launch_driver_action'])
    assert.equal(ui.mounted, 0)
    assert.ok(ui.view.root.findAllByProps({ role: 'alert' }).length > 0)
    assert.equal(ui.button('继续迁移配置'), undefined)
    await ui.close()
  }
})

test('partial cleanup preserves reboot notice and retries cleanup without reinstalling new driver', async () => {
  let attempts = 0
  const ui = await flow({ remove: () => ++attempts === 1 ? { ...removalResult, error: 'in use', rebootRequired: true } : removalResult })
  await ui.click('卸载VB-CABLE并安装新版')
  assert.match(text(ui.view.toJSON()), /新版驱动已安装，卸载 VB-CABLE 失败/)
  assert.match(text(ui.view.toJSON()), /需要重启电脑/)
  assert.equal(ui.mounted, 0)
  await ui.click('卸载VB-CABLE并安装新版')
  assert.deepEqual(commands(ui), ['probe_legacy_audio_driver', 'probe_windows_audio_driver', 'launch_driver_action', 'uninstall_legacy_audio_driver', 'probe_windows_audio_driver', 'uninstall_legacy_audio_driver'])
  assert.match(text(ui.view.toJSON()), /需要重启电脑/)
  assert.ok(ui.button('继续迁移配置'))
  await ui.close()
})
