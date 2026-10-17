import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync, existsSync } from 'node:fs'
import { createRequire } from 'node:module'
import { resolve, dirname, extname } from 'node:path'
import vm from 'node:vm'
import ts from 'typescript'
import React from 'react'
import Renderer, { act } from 'react-test-renderer'

const require = createRequire(import.meta.url)
const cache = new Map()

function load(file) {
  file = resolve(file)
  if (cache.has(file)) return cache.get(file).exports
  const module = { exports: {} }
  cache.set(file, module)
  const source = ts.transpileModule(readFileSync(file, 'utf8'), { compilerOptions: {
    module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020, jsx: ts.JsxEmit.ReactJSX,
  } }).outputText
  const localRequire = name => {
    if (!name.startsWith('.')) return require(name)
    const path = resolve(dirname(file), name)
    if (extname(path)) return load(path)
    if (existsSync(`${path}.tsx`)) return load(`${path}.tsx`)
    return load(`${path}.ts`)
  }
  vm.runInNewContext(source, { module, exports: module.exports, require: localRequire, console }, { filename: file })
  return module.exports
}

const { BehaviorEditor } = load('src/components/BehaviorEditor.tsx')
const { keyDisplayName, keyGroupsForPlatform } = load('src/appConfig.tsx')

test('media controls expose supported presets and manual keys on each platform', () => {
  for (const platform of ['macos', 'windows']) {
    const applied = []
    let view
    act(() => {
      view = Renderer.create(React.createElement(BehaviorEditor, {
        editorRef: { current: null }, attention: false, platform,
        button: { id: 'menu', label: '菜单', icon: 'menu' }, trigger: 'click', behaviors: [],
        onApplyCommonBehavior: preset => applied.push(preset),
        onAddAdvancedBehavior: () => {}, onRemoveBehavior: () => {},
        onMoveBehavior: () => {}, onEditBehavior: () => {}, onReturnToMappings: () => {},
      }))
    })
    try {
      act(() => view.root.findByProps({ id: 'behavior-menu-click-media-tab' }).props.onClick())
      const labels = ['上一首', '下一首', ...(platform === 'windows' ? ['停止播放'] : [])]
      const buttons = view.root.findByProps({ id: 'behavior-menu-click-media-panel' }).findAllByType('button')
      for (const label of labels) {
        const button = buttons.find(item => item.findAllByType('strong').some(node => node.children.includes(label)))
        assert.ok(button, `${platform}: ${label}`)
        act(() => button.props.onClick())
      }
      assert.deepEqual(applied, ['mediaPrevious', 'mediaNext', ...(platform === 'windows' ? ['mediaStop'] : [])])

      const keys = keyGroupsForPlatform(platform).find(group => group.label === '媒体按键').options
      assert.deepEqual(Array.from(keys.filter(option => ['MediaPrevious', 'MediaNext', 'MediaStop'].includes(option.value)), option => option.label), labels)
      if (platform === 'windows') assert.equal(keyDisplayName('MediaStop', platform), '停止播放')
      assert.equal(buttons.some(item => item.findAllByType('strong').some(node => node.children.includes('停止播放'))), platform === 'windows')
    } finally {
      act(() => view.unmount())
    }
  }
})
