import type { Platform } from './appTypes.ts'

const shortcuts = [
  { preset: 'focusDock', name: '聚焦 Dock', keys: ['Ctrl', 'F3'], hint: '按左右方向键选择，回车打开' },
  { preset: 'openControlCenter', name: '打开控制中心', keys: ['Fn', 'C'] },
  { preset: 'switchToPreviousApp', name: '切换到上一个 App', keys: ['Win', 'Tab'] },
  { preset: 'openMissionControl', name: '打开调度中心', keys: ['Ctrl', 'Up'] },
] as const

const presets = shortcuts.map(action => {
  const keyLabels: Partial<Record<string, string>> = { Win: 'Cmd', Up: '↑' }
  const chord = action.keys.map(key => keyLabels[key] ?? key).join(' + ')
  return { ...action, description: 'hint' in action ? `${chord} · ${action.hint}` : chord }
})

export type MacosShortcutPreset = (typeof shortcuts)[number]['preset']

export function macosShortcutPresets(platform: Platform): readonly (typeof presets)[number][] {
  return platform === 'macos' ? presets : []
}
