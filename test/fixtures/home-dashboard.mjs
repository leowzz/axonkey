import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import vm from 'node:vm'
import ts from 'typescript'

const require = createRequire(import.meta.url)
function loadComponent(name) {
  const module = { exports: {} }
  const source = ts.transpileModule(readFileSync(new URL(`../../src/components/${name}.tsx`, import.meta.url), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX },
  }).outputText
  vm.runInNewContext(source, {
    module, exports: module.exports,
    require: dependency => dependency.endsWith('.css') ? {}
      : dependency === '../openGitHub' ? { openGitHub() {} }
        : dependency === './MyDevicesPage' ? loadComponent('MyDevicesPage')
          : dependency === './BatteryIndicator' ? loadComponent('BatteryIndicator') : require(dependency),
  })
  return module.exports
}
export const { HomeDashboard } = loadComponent('HomeDashboard')
export const devices = [
  { id: 'rc003', name: '小米遥控器', profileName: '遥控工作', profileCount: 3, status: { label: '未连接', tone: 'neutral' }, power: { kind: 'battery', level: null }, enabled: true },
  { id: 'mouse', name: '系统鼠标', profileName: '鼠标默认', profileCount: 1, status: { label: '可用', tone: 'ready' }, power: { kind: 'unavailable' }, enabled: true },
]
export const base = {
  nativeRuntime: true,
  devices, onSelectDevice() {}, onIntegrate() {}, onOpenPermissions() {}, onOpenLogs() {},
}
export const text = node => typeof node === 'string' ? node : (node.children ?? []).map(text).join('')
