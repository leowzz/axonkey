import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import vm from 'node:vm'
import ts from 'typescript'

const require = createRequire(import.meta.url)
function loadComponent(name) {
  const module = { exports: {} }
  const source = ts.transpileModule(readFileSync(new URL(`../../src/components/${name}.tsx`, import.meta.url), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX, esModuleInterop: true },
  }).outputText
  vm.runInNewContext(source, {
    module, exports: module.exports,
    require: dependency => dependency.endsWith('.css') ? {}
      : dependency === '../openGitHub' ? { openGitHub() {} }
        : require(dependency),
  })
  return module.exports
}
export const { HomeDashboard } = loadComponent('HomeDashboard')
export const base = {
  nativeRuntime: true,
  deviceContent: null, hasUpdate: false,
  onOpenSettings() {}, onOpenPermissions() {}, onOpenLogs() {}, onOpenAbout() {},
}
export const text = node => typeof node === 'string' ? node : (node.children ?? []).map(text).join('')
