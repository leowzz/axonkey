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
        : dependency === './MyDevicesPage' ? loadComponent('MyDevicesPage') : require(dependency),
  })
  return module.exports
}
export const { HomeDashboard } = loadComponent('HomeDashboard')
export const devices = [
  { id: 'rc003', name: '小米遥控器', model: 'RC003 · 蓝牙遥控器', description: '按键与语音控制', profileName: '遥控工作', profileCount: 3, status: { label: '未连接', tone: 'neutral' }, enabled: true },
  { id: 'mouse', name: '系统鼠标', model: '系统输入', description: '系统鼠标共用输入', profileName: '鼠标默认', profileCount: 1, status: { label: '已授权', tone: 'ready' }, enabled: true },
]
export const base = {
  platform: 'macos', nativeRuntime: true, systemProbeState: 'ready',
  permissions: { inputMonitoring: true, accessibility: true }, inputAuthorizationStale: false,
  devices, onSelectDevice() {}, onIntegrate() {}, onOpenPermissions() {}, onRefresh() {}, onOpenLogs() {},
}
export const text = node => typeof node === 'string' ? node : (node.children ?? []).map(text).join('')
export const permissionLabels = view => view.root.findAllByProps({ className: 'home-status-label' }).map(text)
