import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import vm from 'node:vm'
import ts from 'typescript'
import React from 'react'
import Renderer, { act } from 'react-test-renderer'
import * as reiconReact from 'reicon-react'
import { createFileRequire } from './helpers/resolve-compiled-require.mjs'
import {
  countConfiguredInputs,
  getBundledPresetsForKind,
  getPresetsForDevice,
  materializePresetToProfile,
  pickDefaultPreset,
  summarizePresetHighlights,
} from '../src/devices/bundledPresets.ts'
import { packageFor } from '../src/devices/integration/model.ts'

const require = createRequire(import.meta.url)
const text = node =>
  typeof node === 'string' ? node : (Array.isArray(node) ? node : (node?.children ?? [])).map(text).join('')

function compile(path, imports = {}, globals = {}) {
  const resolveFileRequire = createFileRequire(path, require)
  const source = ts.transpileModule(
    readFileSync(path, 'utf8').replaceAll('import.meta.url', JSON.stringify(`file://${process.cwd()}/${path}`)),
    {
      compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020, jsx: ts.JsxEmit.ReactJSX },
    },
  ).outputText
  const module = { exports: {} }
  vm.runInNewContext(source, {
    module,
    exports: module.exports,
    URL,
    document: { activeElement: null, querySelector: () => null },
    HTMLElement: class {},
    ...globals,
    require: name => (name in imports ? imports[name] : name === 'reicon-react' ? reiconReact : resolveFileRequire(name)),
  })
  return module.exports
}

test('bundled presets cover all 15 hardware models with valid device input IDs and actions', () => {
  const kinds = [
    'rc003',
    'cmiotA15',
    'rc313',
    'xmBt29',
    'obeRcuR5',
    'tclRc802a',
    'tclRc902n',
    'tclRc902v',
    'hisenseRcf3b65',
    'phicommDb1R',
    'oneplusRc001a',
    'rmfTx800c',
    'xboxBluetooth',
    'kivoK18Lite',
    'g17Touch',
  ]
  for (const kind of kinds) {
    const pkg = packageFor(kind)
    const validIds = new Set(pkg.inputs.map(input => input.id))
    const presets = getBundledPresetsForKind(kind)
    assert.ok(presets.length >= 1, `${kind} should provide at least 1 bundled preset`)
    const defaultPreset = pickDefaultPreset(presets)
    assert.ok(defaultPreset, `${kind} should provide a default regular preset`)
    for (const preset of presets) {
      assert.ok(countConfiguredInputs(preset.behaviors) >= 8, `${kind}/${preset.slug} configures key mappings`)
      for (const inputId of Object.keys(preset.behaviors)) {
        assert.ok(validIds.has(inputId), `${kind}/${preset.slug} references valid input ${inputId}`)
      }
      const highlights = summarizePresetHighlights(preset, pkg.inputs, 'macos')
      assert.ok(highlights.length >= 2, `${kind}/${preset.slug} generates highlight pills`)
    }
  }
})

test('cloud presets override bundled defaults when present for the current platform', () => {
  const cloudModel = {
    id: 'm-rc003',
    code: 'rc003',
    name: '小米遥控器',
    model: 'RC003',
    brand_id: null,
    brand_name: '小米',
    description: '',
    tags: [],
    links: [],
    presets: [
      {
        id: 'cloud-win',
        slug: 'win-only',
        name: 'Windows 专属',
        description: '仅 Windows',
        platform: 'windows',
        is_default: true,
        quick: false,
        prompt_mode: false,
        sort_order: 5,
        behaviors: { confirm: { click: [{ id: 'a1', enabled: true, type: 'mouse', button: 'left' }], doubleClick: [], longPress: [] } },
      },
      {
        id: 'cloud-all',
        slug: 'cloud-mouse',
        name: '云端飞鼠',
        description: '来自云端下发',
        platform: 'all',
        is_default: false,
        quick: false,
        prompt_mode: false,
        sort_order: 20,
        behaviors: { confirm: { click: [{ id: 'a2', enabled: true, type: 'mouse', button: 'right' }], doubleClick: [], longPress: [] } },
      },
    ],
  }

  const macPresets = getPresetsForDevice('rc003', cloudModel, 'macos')
  assert.equal(macPresets.length, 1)
  assert.equal(macPresets[0].slug, 'cloud-mouse')
  assert.equal(macPresets[0].source, 'cloud')

  const winPresets = getPresetsForDevice('rc003', cloudModel, 'windows')
  assert.equal(winPresets.length, 2)
  assert.equal(winPresets[0].slug, 'win-only')

  // When cloud presets exist only for another platform, fall back cleanly to bundled presets
  const emptyMacFallback = getPresetsForDevice(
    'rc003',
    { ...cloudModel, presets: [cloudModel.presets[0]] },
    'macos',
  )
  assert.equal(emptyMacFallback[0].source, 'bundled')
})

test('materializePresetToProfile generates fresh IDs and disambiguates duplicate names', () => {
  const [preset] = getBundledPresetsForKind('rc003')
  const first = materializePresetToProfile(preset, { existingNames: ['飞鼠操控'] })
  const second = materializePresetToProfile(preset, { existingNames: ['飞鼠操控', first.name] })
  assert.notEqual(first.id, preset.id)
  assert.notEqual(first.id, second.id)
  assert.equal(first.name, '飞鼠操控 (2)')
  assert.equal(second.name, '飞鼠操控 (3)')
  assert.ok(first.name.length <= 40)
  assert.notEqual(first.behaviors.confirm.click[0].id, second.behaviors.confirm.click[0].id)
})

test('PresetProfileDialog displays preset sources and wires copy/overwrite actions', () => {
  const { PresetProfileDialog } = compile('src/components/PresetProfileDialog.tsx')
  const presets = getPresetsForDevice('rc003', { presets: undefined }, 'macos')
  const copied = []
  const overwritten = []
  const modal = { showModal() {}, close() {} }
  let view
  act(() => {
    view = Renderer.create(
      React.createElement(PresetProfileDialog, {
        deviceName: '卧室遥控器',
        platform: 'macos',
        inputs: packageFor('rc003').inputs,
        presets,
        activeProfileName: '默认配置',
        activeProfileIsQuick: false,
        onCopyAsNew: preset => copied.push(preset.slug),
        onOverwriteCurrent: preset => overwritten.push(preset.slug),
        onClose() {},
      }),
      { createNodeMock: node => (node.type === 'dialog' ? modal : null) },
    )
  })
  try {
    assert.ok(text(view.root).includes('飞鼠操控'))
    assert.ok(text(view.root).includes('影音与阅读'))
    assert.ok(text(view.root).includes('演示翻页'))
    const cards = view.root.findAllByType('article')
    assert.equal(cards.length, 3)
    const buttons = cards[1].findAllByType('button')
    act(() => buttons[0].props.onClick())
    act(() => buttons[1].props.onClick())
    assert.deepEqual(overwritten, ['media-reading'])
    assert.deepEqual(copied, ['media-reading'])
  } finally {
    act(() => view.unmount())
  }
})
