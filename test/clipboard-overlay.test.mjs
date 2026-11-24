import assert from 'node:assert/strict'
import test from 'node:test'
import { existsSync, readFileSync } from 'node:fs'
import { createRequire, registerHooks } from 'node:module'
import { dirname, extname, resolve } from 'node:path'
import vm from 'node:vm'
import ts from 'typescript'
import React from 'react'
import Renderer, { act } from 'react-test-renderer'
import { sampleData } from './fixtures/data-backup.mjs'

const assets = registerHooks({
  load(url, context, next) {
    return url.endsWith('.svg')
      ? { format: 'module', source: 'export default "asset.svg"', shortCircuit: true }
      : next(url, context)
  },
})

const {
  clipboardOverlayMinAppVersion,
  createBehavior,
  isCommunityShareableBehavior,
  minAppVersionForBehaviors,
  normalizeBehavior,
  parseSequenceImport,
  serializeSequence,
} = await import('../src/behaviorModel.ts')
const { behaviorSummary } = await import('../src/behaviorSummary.ts')
const { createDataBackup, parseDataBackup } = await import('../src/dataBackup.ts')
const { behaviorToCliBehavior, normalizeCliBehavior } = await import('../src/cliContract.ts')
const { processInstanceCliRequest } = await import('../src/devices/integration/instanceCli.ts')
const { processMouseCliRequest } = await import('../src/mouseCli.ts')
const { createDefaultDeviceProfiles, composeActiveProfileBehaviors } = await import('../src/deviceProfiles.ts')
const { quickOverlayAllowsToolboxStep } = await import('../src/components/quickOverlayConfiguration.ts')
const { insertedWorkflowSteps } = await import('../src/components/workflowBehaviorBridge.ts')
const { workflowBehaviorProperties, workflowStepBehavior } = await import('../src/components/workflowStepEditing.ts')
const { buildQuickOverlayView, summarizeQuickTrigger } = await import('../src/components/quickOverlayModel.ts')

assets.deregister()

const require = createRequire(import.meta.url)
const tsCache = new Map()
function loadTs(file) {
  file = resolve(file)
  if (tsCache.has(file)) return tsCache.get(file).exports
  const module = { exports: {} }
  tsCache.set(file, module)
  const source = ts.transpileModule(readFileSync(file, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX },
    fileName: file,
  }).outputText
  const localRequire = name => {
    if (name.endsWith('.css')) return {}
    if (name.endsWith('.svg')) return 'asset.svg'
    if (name === '@tauri-apps/api/core') return { invoke: async () => null }
    if (name.startsWith('@tauri-apps/')) return {}
    if (!name.startsWith('.')) return require(name)
    const base = resolve(dirname(file), name)
    if (extname(base) && existsSync(base)) return loadTs(base)
    for (const ext of ['.ts', '.tsx', '.js', '.mjs']) {
      if (existsSync(base + ext)) return loadTs(base + ext)
    }
    return require(base)
  }
  vm.runInNewContext(source, { module, exports: module.exports, require: localRequire, globalThis, console }, { filename: file })
  return module.exports
}

const { workflowToolboxPalettes } = loadTs('src/components/workflowToolboxPalettes.ts')

const text = node => (typeof node === 'string' ? node : (node?.children ?? []).map(text).join(''))

function loadQuickOverlayPresentation() {
  const require = createRequire(import.meta.url)
  const modules = new Map()
  const listeners = new Map()
  function load(file) {
    file = resolve(file)
    if (modules.has(file)) return modules.get(file).exports
    const module = { exports: {} }
    modules.set(file, module)
    const source = ts.transpileModule(readFileSync(file, 'utf8'), {
      compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX },
      fileName: file,
    }).outputText
    vm.runInNewContext(
      source,
      {
        module,
        exports: module.exports,
        console,
        window: {
          addEventListener: (type, fn) => listeners.set(type, fn),
          removeEventListener: (type, listener) => {
            if (listeners.get(type) === listener) listeners.delete(type)
          },
        },
        require(name) {
          if (name.endsWith('.css')) return {}
          if (name.startsWith('../devices/') && name.endsWith('/railOverview')) return { railKeyGlyphText: () => null }
          if (name === './InputIcon') return { iconFor: () => null }
          if (name === './quickOverlayModel') return { buildQuickOverlayView, summarizeQuickTrigger }
          if (name.startsWith('../') || name.startsWith('@tauri-apps/')) return {}
          if (!name.startsWith('.')) return require(name)
          const path = resolve(dirname(file), name)
          return load(extname(path) ? path : existsSync(`${path}.tsx`) ? `${path}.tsx` : `${path}.ts`)
        },
      },
      { filename: file },
    )
    return module.exports
  }
  return load('src/components/QuickOverlay.tsx').QuickOverlayPresentation
}

function instanceWorkspace(kind = 'rc003') {
  let snapshot = {
    store: {
      version: 1,
      revision: 1,
      instances: [
        {
          id: 'inst-1',
          kind,
          name: '客厅遥控器',
          binding: 'physical-1',
          enabled: true,
          profiles: [{ id: 'default', name: '默认配置', behaviors: {} }],
          activeProfileId: 'default',
        },
      ],
    },
    discovered: [{ id: 'physical-1', connected: true }],
    runtime: { 'inst-1': { state: 'exclusive', error: null, reports: 0 } },
    error: null,
    scanError: null,
    scanning: false,
  }
  return {
    get snapshot() {
      return snapshot
    },
    command(method, params = {}) {
      return processInstanceCliRequest(method, params, {
        snapshot,
        platform: 'macos',
        update: async (id, change) => {
          snapshot = {
            ...snapshot,
            store: {
              ...snapshot.store,
              revision: snapshot.store.revision + 1,
              instances: snapshot.store.instances.map(item => (item.id === id ? change(item) : item)),
            },
          }
          return snapshot
        },
      })
    },
  }
}

function mouseWorkspace() {
  const defaults = createDefaultDeviceProfiles(sampleData().behaviors)
  let state = {
    ...defaults,
    behaviors: composeActiveProfileBehaviors(defaults.profiles, defaults.activeProfileIds),
    globalProfileId: defaults.activeProfileIds.mouse,
    autoSwitching: false,
  }
  return {
    get state() {
      return state
    },
    command(method, params = {}) {
      return processMouseCliRequest(method, params, state, 'windows', async next => {
        state = { ...next, behaviors: composeActiveProfileBehaviors(next.profiles, next.activeProfileIds) }
      })
    },
  }
}

test('clipboardOverlay model normalizes defaults, round-trips axonkey/2, enforces version precedence, and stays unshareable', () => {
  const defaultCreated = createBehavior({ type: 'clipboardOverlay', id: 'clip-default' })
  assert.deepEqual(defaultCreated, { id: 'clip-default', enabled: true, type: 'clipboardOverlay', action: 'paste' })

  const pasteNormalized = normalizeBehavior({ type: 'clipboardOverlay', id: 'c1' })
  assert.deepEqual(pasteNormalized, { id: 'c1', enabled: true, type: 'clipboardOverlay', action: 'paste' })
  assert.equal(normalizeBehavior({ type: 'clipboardOverlay', action: 'invalid-action', id: 'bad' }), null)

  const copyNormalized = normalizeBehavior({ type: 'clipboardOverlay', action: 'copyText', enabled: false, id: 'c2' })
  assert.deepEqual(copyNormalized, { id: 'c2', enabled: false, type: 'clipboardOverlay', action: 'copyText' })

  assert.equal(behaviorSummary(defaultCreated, 'macos'), '剪贴板交互窗')
  assert.equal(behaviorSummary(copyNormalized, 'macos'), '剪贴板交互窗 · 仅复制')

  const pasteSeq = serializeSequence([defaultCreated])
  assert.equal(pasteSeq, 'axonkey/2\nclipboard\nend')
  assert.deepEqual(
    parseSequenceImport(pasteSeq).map(({ id: _, ...rest }) => rest),
    [{ enabled: true, type: 'clipboardOverlay', action: 'paste' }],
  )

  const copySeq = serializeSequence([{ ...copyNormalized, enabled: true }])
  assert.equal(copySeq, 'axonkey/2\nclipboard copy\nend')
  assert.deepEqual(
    parseSequenceImport(copySeq).map(({ id: _, ...rest }) => rest),
    [{ enabled: true, type: 'clipboardOverlay', action: 'copyText' }],
  )

  assert.equal(clipboardOverlayMinAppVersion, '1.9.21')
  assert.equal(
    minAppVersionForBehaviors([
      createBehavior({ type: 'typeText', text: 'older' }),
      createBehavior({ type: 'quickOverlay', profileId: 'q1' }),
      createBehavior({ type: 'copyText', text: 'middle' }),
      defaultCreated,
    ]),
    '1.9.21',
  )

  const backupInput = sampleData()
  backupInput.behaviors.menu.click = [defaultCreated]
  backupInput.behaviors.up.click = [createBehavior({ type: 'copyText', text: '1.9.19' })]
  backupInput.profiles[0].behaviors.menu.click = [defaultCreated]
  const backup = createDataBackup(backupInput, '1.9.10')
  assert.equal(backup.minAppVersion, '1.9.21')
  const parsedBackup = parseDataBackup(JSON.stringify(backup))
  const parsedProfile = parsedBackup.profiles.find(p => p.id === backupInput.profiles[0].id)
  assert.equal(parsedProfile.behaviors.menu.click[0].action, 'paste')

  assert.equal(isCommunityShareableBehavior(defaultCreated), false)
  assert.equal(isCommunityShareableBehavior(copyNormalized), false)
})

test('CLI contract and instance/mouse CLIs support standalone clipboardOverlay and reject mixed sequences', async () => {
  assert.deepEqual(normalizeCliBehavior({ type: 'clipboardOverlay' }, 'macos'), {
    type: 'clipboardOverlay',
    action: 'paste',
    enabled: true,
  })
  assert.deepEqual(normalizeCliBehavior({ type: 'clipboardOverlay', action: 'copyText', enabled: false }, 'windows'), {
    type: 'clipboardOverlay',
    action: 'copyText',
    enabled: false,
  })
  assert.deepEqual(
    behaviorToCliBehavior(createBehavior({ type: 'clipboardOverlay', action: 'copyText', enabled: false }), 'macos'),
    { type: 'clipboardOverlay', action: 'copyText', enabled: false },
  )

  const instanceWork = instanceWorkspace('rc003')
  const setPaste = await instanceWork.command('mapping.set', {
    button: 'menu',
    sequence: [{ type: 'clipboardOverlay', action: 'paste' }],
  })
  assert.deepEqual(setPaste.after, [{ type: 'clipboardOverlay', action: 'paste', enabled: true }])

  const setCopy = await instanceWork.command('mapping.set', {
    button: 'menu',
    sequence: [{ type: 'clipboardOverlay', action: 'copyText' }],
  })
  assert.deepEqual(setCopy.after, [{ type: 'clipboardOverlay', action: 'copyText', enabled: true }])

  await assert.rejects(
    instanceWork.command('mapping.set', {
      button: 'menu',
      sequence: [
        { type: 'clipboardOverlay', action: 'paste' },
        { type: 'key', key: 'A' },
      ],
    }),
    error => error.code === 'invalid_behavior',
  )

  const mouseWork = mouseWorkspace()
  const mousePaste = await mouseWork.command('mapping.set', {
    button: 'mouse.global.buttonMiddle',
    sequence: [{ type: 'clipboardOverlay', action: 'paste' }],
  })
  assert.deepEqual(mousePaste.after, [{ type: 'clipboardOverlay', action: 'paste', enabled: true }])

  const mouseCopy = await mouseWork.command('mapping.set', {
    button: 'mouse.global.buttonMiddle',
    sequence: [{ type: 'clipboardOverlay', action: 'copyText' }],
  })
  assert.deepEqual(mouseCopy.after, [{ type: 'clipboardOverlay', action: 'copyText', enabled: true }])

  await assert.rejects(
    mouseWork.command('mapping.set', {
      button: 'mouse.global.buttonMiddle',
      sequence: [
        { type: 'clipboardOverlay', action: 'paste' },
        { type: 'key', key: 'A' },
      ],
    }),
    error => error.code === 'invalid_behavior',
  )
})

test('workflow toolbox, quick-overlay blocklist, bridge insertion, and step editing handle clipboardOverlay', () => {
  const regularPalettes = workflowToolboxPalettes('macos', false)
  const flowGroup = regularPalettes[0].groups.find(group => group.name === '流程控制')
  const paletteStep = flowGroup.steps.find(step => step.type === 'clipboardOverlay')
  assert.ok(paletteStep)
  assert.equal(paletteStep.properties.recommendedFallback, true)

  const quickPalettes = workflowToolboxPalettes('macos', true)
  const quickFlow = quickPalettes[0].groups.find(group => group.name === '流程控制')
  assert.equal(
    quickFlow.steps.some(step => step.type === 'clipboardOverlay'),
    false,
  )

  assert.equal(quickOverlayAllowsToolboxStep(paletteStep), false)
  assert.equal(
    quickOverlayAllowsToolboxStep({
      componentType: 'task',
      type: 'savedSequence',
      name: 'clipboard saved',
      properties: { sequence: 'axonkey/2\nclipboard\nend' },
    }),
    false,
  )

  const inserted = insertedWorkflowSteps(
    { id: 'clip-step-1', componentType: 'task', type: 'clipboardOverlay', name: '剪贴板交互窗', properties: {} },
    'macos',
    behavior => behaviorSummary(behavior, 'macos'),
  )
  assert.equal(inserted.length, 1)
  assert.equal(inserted[0].properties.draftGroup, undefined)
  assert.equal(inserted[0].properties.behaviorType, 'clipboardOverlay')
  assert.equal(inserted[0].properties.action, 'paste')
  assert.equal(inserted[0].properties.enabled, true)

  assert.deepEqual(workflowStepBehavior(inserted[0]), {
    id: 'clip-step-1',
    enabled: true,
    type: 'clipboardOverlay',
    action: 'paste',
  })

  const updatedProps = workflowBehaviorProperties(inserted[0], {
    id: 'clip-step-1',
    enabled: true,
    type: 'clipboardOverlay',
    action: 'copyText',
  })
  assert.equal(updatedProps.action, 'copyText')
  assert.equal(updatedProps.enabled, true)
  assert.deepEqual(workflowStepBehavior({ ...inserted[0], properties: updatedProps }), {
    id: 'clip-step-1',
    enabled: true,
    type: 'clipboardOverlay',
    action: 'copyText',
  })
  assert.deepEqual(workflowStepBehavior({ ...inserted[0], properties: { ...updatedProps, enabled: false } }), {
    id: 'clip-step-1',
    enabled: false,
    type: 'clipboardOverlay',
    action: 'copyText',
  })
})

test('buildQuickOverlayView and QuickOverlayPresentation render clipboard mode ranks, detail bar, clear action, and empty state', () => {
  const QuickOverlayPresentation = loadQuickOverlayPresentation()
  const multilineText = 'first line\n\tsecond   line'

  const pasteView = buildQuickOverlayView(
    {
      revision: 11,
      sourceId: 'rc-1',
      deviceKind: 'rc003',
      deviceName: '客厅遥控器',
      profileId: '__clipboard__',
      profileName: '剪贴板历史',
      triggerInput: 'menu',
      pressed: [],
      preview: false,
      clipboardMode: true,
      clipboardSlots: ['up', 'down'],
      behaviors: {
        up: { click: [{ id: 'c-0', enabled: true, type: 'paste', text: multilineText }] },
        down: { click: [{ id: 'c-1', enabled: true, type: 'paste', text: 'second entry' }] },
      },
    },
    'macos',
  )

  assert.equal(pasteView.clipboardMode, true)
  assert.equal(pasteView.promptMode, false)
  assert.equal(pasteView.clipboardAction, 'paste')
  assert.equal(pasteView.items.length, 2)
  assert.equal(pasteView.items[0].inputId, 'up')
  assert.equal(pasteView.items[0].triggers[0].kind, 'clipboard')
  assert.equal(pasteView.items[0].triggers[0].badge, '#1')
  assert.equal(pasteView.items[0].triggers[0].clipboardRank, 1)
  assert.equal(pasteView.items[0].triggers[0].displayText, 'first line second line')
  assert.equal(pasteView.items[0].triggers[0].text, multilineText)
  assert.equal(pasteView.items[1].triggers[0].badge, '#2')
  assert.equal(pasteView.items[1].triggers[0].clipboardRank, 2)

  let cleared = 0
  let renderer
  act(() => {
    renderer = Renderer.create(
      React.createElement(QuickOverlayPresentation, {
        view: pasteView,
        preview: false,
        onDismiss() {},
        onTrigger() {},
        onClearClipboard: () => {
          cleared += 1
        },
      }),
    )
  })
  try {
    const shell = renderer.root.findByProps({ role: 'dialog' })
    assert.match(shell.props.className, /is-clipboard-mode/)

    const pill = renderer.root.findByProps({ className: 'quick-overlay-mode-pill is-clipboard' })
    assert.equal(text(pill), '剪贴板')

    const countChip = renderer.root.findByProps({ className: 'quick-overlay-count-chip' })
    assert.equal(text(countChip), '2 条')

    const upButton = renderer.root.findAll(
      node =>
        node.type === 'button' &&
        node.props.className?.includes('kind-clipboard') &&
        text(node).includes('first line second line'),
    )[0]
    assert.ok(upButton)
    assert.match(text(upButton), /#1/)

    const detailBar = renderer.root.findByProps({ className: 'quick-surface-detail-bar' })
    assert.ok(text(detailBar).includes(multilineText))
    assert.ok(text(detailBar).includes(`${multilineText.length} 字符 · 按下直接粘贴`))

    const clearBtn = renderer.root.findByProps({ className: 'quick-overlay-clear' })
    act(() => clearBtn.props.onClick())
    assert.equal(cleared, 1)
  } finally {
    act(() => renderer.unmount())
  }

  const copyPreviewView = buildQuickOverlayView(
    {
      revision: 12,
      sourceId: 'rc-1',
      deviceKind: 'rc003',
      deviceName: '客厅遥控器',
      profileId: '__clipboard__',
      profileName: '剪贴板 · 仅复制',
      triggerInput: 'menu',
      pressed: [],
      preview: true,
      clipboardMode: true,
      clipboardSlots: ['up'],
      behaviors: {
        up: { click: [{ id: 'c-0', enabled: true, type: 'copyText', text: 'copied snippet' }] },
      },
    },
    'windows',
  )
  assert.equal(copyPreviewView.clipboardAction, 'copyText')
  act(() => {
    renderer = Renderer.create(
      React.createElement(QuickOverlayPresentation, {
        view: copyPreviewView,
        preview: true,
        onDismiss() {},
      }),
    )
  })
  try {
    assert.equal(text(renderer.root.findByProps({ className: 'quick-overlay-mode-pill is-clipboard' })), '剪贴板预览')
    assert.ok(
      text(renderer.root.findByProps({ className: 'quick-surface-detail-bar' })).includes('14 字符 · 按下仅写入剪贴板'),
    )
  } finally {
    act(() => renderer.unmount())
  }

  const emptyView = buildQuickOverlayView(
    {
      revision: 13,
      sourceId: 'rc-1',
      deviceKind: 'rc003',
      deviceName: '客厅遥控器',
      profileId: '__clipboard__',
      profileName: '剪贴板历史',
      triggerInput: 'menu',
      pressed: [],
      preview: false,
      clipboardMode: true,
      clipboardSlots: [],
      behaviors: {},
    },
    'macos',
  )
  act(() => {
    renderer = Renderer.create(
      React.createElement(QuickOverlayPresentation, {
        view: emptyView,
        preview: false,
        onDismiss() {},
        onClearClipboard() {},
      }),
    )
  })
  try {
    const emptyState = renderer.root.findByProps({ className: 'quick-overlay-empty' })
    assert.ok(text(emptyState).includes('剪贴板暂无文本记录'))
    assert.equal(renderer.root.findAllByProps({ className: 'quick-overlay-clear' }).length, 0)
  } finally {
    act(() => renderer.unmount())
  }
})
