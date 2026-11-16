import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import vm from 'node:vm'
import ts from 'typescript'
import React from 'react'
import Renderer, { act } from 'react-test-renderer'

const aboutUrl = new URL('../src/components/AboutPage.tsx', import.meta.url).href
const require = createRequire(aboutUrl)
const source = ts.transpileModule(
  readFileSync('src/components/AboutPage.tsx', 'utf8').replaceAll('import.meta.url', JSON.stringify(aboutUrl)),
  {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2020,
      jsx: ts.JsxEmit.ReactJSX,
      esModuleInterop: true,
    },
  },
).outputText

const text = (node) => (typeof node === 'string' ? node : (node?.children ?? []).map(text).join(''))

async function mount({ nativeRuntime = true, invokeCliPath = async () => 'E:\\Tools\\Axonkey\\axonkey-cli.exe', writeClipboard } = {}) {
  const invokes = []
  const copied = []
  const module = { exports: {} }
  const windowObject = nativeRuntime ? { __TAURI_INTERNALS__: {} } : {}
  const customRequire = (specifier) => {
    if (specifier === '@tauri-apps/api/core') {
      return {
        invoke: async (command, args) => {
          invokes.push({ command, args })
          if (command === 'cli_executable_path') return invokeCliPath()
          throw new Error(`Unexpected command: ${command}`)
        },
      }
    }
    if (specifier === '../clipboard') {
      return {
        writeClipboardText: async (value) => {
          if (writeClipboard) return writeClipboard(value)
          copied.push(value)
        },
      }
    }
    if (specifier === './WechatGroupCard') {
      return { WechatGroupCard: () => null }
    }
    if (specifier === '../openGitHub') {
      return { openGitHub() {}, openReleases() {} }
    }
    if (specifier === '../releaseUpdate') {
      return { releasesUrl: 'https://github.com/leowzz/axonkey/releases' }
    }
    return require(specifier)
  }

  vm.runInNewContext(source, {
    module,
    exports: module.exports,
    require: customRequire,
    window: windowObject,
    URL,
  })

  let view
  await act(async () => {
    view = Renderer.create(React.createElement(module.exports.AgentConfigurationCard))
  })

  return {
    view,
    invokes,
    copied,
    buildAgentCliPrompt: module.exports.buildAgentCliPrompt,
    snippetText: () => text(view.root.findByType('code')),
    copy: async () => {
      await act(async () => {
        view.root.findByProps({ 'aria-label': '复制提示词' }).props.onClick()
      })
    },
    close: async () => {
      await act(async () => {
        view.unmount()
      })
    },
  }
}

test('native runtime embeds the absolute CLI path in the displayed and copied Agent prompt', async () => {
  const cliPath = 'E:\\Custom Dir\\Axonkey\\axonkey-cli.exe'
  const app = await mount({
    nativeRuntime: true,
    invokeCliPath: async () => `  ${cliPath}  `,
  })
  try {
    assert.deepEqual(app.invokes, [{ command: 'cli_executable_path', args: undefined }])
    const expected = `请先了解 axonkey-cli（${cliPath}），再按我的需求查看和调整设备按键设置。`
    assert.equal(app.snippetText(), expected)
    await app.copy()
    assert.deepEqual(app.copied, [expected])
    assert.match(text(app.view.toJSON()), /已复制/)
  } finally {
    await app.close()
  }
})

test('clicking copy while CLI path resolution is still pending awaits and copies the resolved absolute path', async () => {
  let resolvePath
  const cliPath = '/Applications/Axonkey.app/Contents/MacOS/axonkey-cli'
  const app = await mount({
    nativeRuntime: true,
    invokeCliPath: () =>
      new Promise((resolve) => {
        resolvePath = resolve
      }),
  })
  try {
    assert.equal(app.snippetText(), '请先了解 axonkey-cli，再按我的需求查看和调整设备按键设置。')
    const copyPromise = act(async () => {
      app.view.root.findByProps({ 'aria-label': '复制提示词' }).props.onClick()
      resolvePath(cliPath)
    })
    await copyPromise
    const expected = `请先了解 axonkey-cli（${cliPath}），再按我的需求查看和调整设备按键设置。`
    assert.equal(app.snippetText(), expected)
    assert.deepEqual(app.copied, [expected])
  } finally {
    await app.close()
  }
})

test('browser preview and failed CLI path lookups fall back cleanly without blocking copy', async () => {
  const browserApp = await mount({ nativeRuntime: false })
  try {
    assert.equal(browserApp.invokes.length, 0)
    const fallback = '请先了解 axonkey-cli，再按我的需求查看和调整设备按键设置。'
    assert.equal(browserApp.snippetText(), fallback)
    await browserApp.copy()
    assert.deepEqual(browserApp.copied, [fallback])
  } finally {
    await browserApp.close()
  }

  const failedLookupApp = await mount({
    nativeRuntime: true,
    invokeCliPath: async () => {
      throw new Error('unavailable')
    },
  })
  try {
    const fallback = '请先了解 axonkey-cli，再按我的需求查看和调整设备按键设置。'
    assert.equal(failedLookupApp.snippetText(), fallback)
    await failedLookupApp.copy()
    assert.deepEqual(failedLookupApp.copied, [fallback])
  } finally {
    await failedLookupApp.close()
  }
})
