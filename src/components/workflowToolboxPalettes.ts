import type { ToolboxGroupConfiguration } from 'sequential-workflow-designer'
import { keyDisplayName, rightModifierChoices } from '../appConfig'
import type { AdvancedBehaviorType, CommonBehaviorPreset, Platform } from '../appTypes.ts'
import { defaultCursorDistance } from '../behaviorModel.ts'
import { macosShortcutPresets } from '../macosShortcutPresets.ts'
import type { WorkflowToolboxPalette } from './WorkflowToolbox'
import type { WorkflowActionChoicePreset } from './workflowActionChoices.ts'
import { defaultWorkflowDelayMs } from './workflowStepEditing.ts'

type WorkflowAction = {
  preset:
    | CommonBehaviorPreset
    | AdvancedBehaviorType
    | 'wheel'
    | 'cursorMove'
    | 'switchProfile'
    | 'quickOverlay'
    | WorkflowActionChoicePreset
  name: string
  description?: string
}

export function workflowToolboxPalettes(platform: Platform, quickOverlay = false): WorkflowToolboxPalette[] {
  const commonActions: WorkflowAction[] = [
    { preset: 'escape', name: '返回 / 关闭', description: 'Esc' },
    { preset: 'enter', name: '确认 / 回车', description: 'Enter' },
    { preset: 'space', name: '空格', description: 'Space' },
    ...rightModifierChoices().map(({ preset, key }) => ({ preset, name: keyDisplayName(key, platform) })),
    { preset: 'previousTab', name: '上一标签页', description: `${keyDisplayName('Ctrl', platform)} + Shift + Tab` },
    { preset: 'nextTab', name: '下一标签页', description: `${keyDisplayName('Ctrl', platform)} + Tab` },
    { preset: 'arrowUp', name: '方向上' },
    { preset: 'arrowDown', name: '方向下' },
    { preset: 'arrowLeft', name: '方向左' },
    { preset: 'arrowRight', name: '方向右' },
    { preset: 'tab', name: '切换焦点', description: 'Tab' },
    { preset: 'backspace', name: '向前删除', description: 'Backspace' },
    { preset: 'delete', name: '向后删除', description: 'Delete' },
    { preset: 'keyHome', name: '跳到开头', description: 'Home' },
    { preset: 'keyEnd', name: '跳到结尾', description: 'End' },
    { preset: 'pageUp', name: '向上翻页', description: 'Page Up' },
    { preset: 'pageDown', name: '向下翻页', description: 'Page Down' },
  ]
  const compositeActions: WorkflowAction[] = [
    { preset: 'textAndEnter', name: '输入文本并回车', description: '等待 30 毫秒后回车' },
    {
      preset: 'deleteAllText',
      name: '删除全部文本',
      description: `${keyDisplayName(platform === 'macos' ? 'Win' : 'Ctrl', platform)} + A，等待 30 毫秒后 ${keyDisplayName(platform === 'macos' ? 'Win' : 'Ctrl', platform)} + X`,
    },
  ]
  const controlActions: WorkflowAction[] = [
    ...(!quickOverlay
      ? [
          {
            preset: 'quickOverlay' as const,
            name: '快捷交互窗',
            description: '唤起独立快捷配置并展示按键功能预览，按其他键执行后退出，再按触发键直接退出',
          },
          {
            preset: 'switchProfile' as const,
            name: '切换配置文件',
            description: '上一个或下一个配置文件，可设置到边缘自动循环',
          },
        ]
      : []),
    {
      preset: 'disabled',
      name: '禁用此触发方式',
      description: '替换当前泳道的序列，不发送任何输入；清空泳道可取消禁用',
    },
    { preset: 'delay', name: '等待' },
    { preset: 'paste', name: '粘贴文本' },
    { preset: 'typeText', name: '模拟输入文字' },
    { preset: 'openPath', name: '打开文件或文件夹' },
    { preset: 'openApp', name: '打开应用' },
    { preset: 'openWebsite', name: '打开网站' },
  ]
  const keyboardActions: WorkflowAction[] = [
    { preset: 'customKey', name: '按键/组合键', description: '录入按键或组合键' },
  ]
  const mouseActions: WorkflowAction[] = []
  if (platform === 'windows' || platform === 'macos') {
    mouseActions.push(
      { preset: 'wheel', name: '鼠标滚动', description: '选择向上、向下、向左或向右滚动' },
      { preset: 'mouseButton', name: '鼠标按键', description: '选择左键或右键' },
      { preset: 'cursorMove', name: '光标移动', description: `选择移动方向，默认 ${defaultCursorDistance} 像素` },
    )
  }
  const mediaActions: WorkflowAction[] = [
    { preset: 'mediaPlayPause', name: '播放 / 暂停' },
    { preset: 'mediaTrack', name: '曲目切换', description: '选择上一首或下一首' },
  ]
  if (platform === 'windows') mediaActions.push({ preset: 'mediaStop', name: '停止播放' })
  mediaActions.push({ preset: 'volumeControl', name: '音量控制', description: '选择增大音量、减小音量或静音' })
  const macosActions = [...macosShortcutPresets(platform)]
  const actionGroups = [
    { name: '控制', actions: controlActions },
    ...(macosActions.length ? [{ name: 'macOS', actions: macosActions }] : []),
    { name: '键盘', actions: keyboardActions },
    { name: '鼠标', actions: mouseActions },
    { name: '媒体控制', actions: mediaActions },
  ]
  const toGroup = (group: { name: string; actions: WorkflowAction[] }): ToolboxGroupConfiguration => ({
    name: group.name,
    steps: group.actions.map(({ preset, name, description }) => ({
      componentType: 'task',
      type: preset,
      name,
      properties: {
        preset,
        description: description ?? '',
        ...(preset === 'delay' ? { ms: defaultWorkflowDelayMs } : {}),
      },
    })),
  })
  return [
    { name: '基础', groups: actionGroups.map(toGroup) },
    { name: '常用行为', groups: [toGroup({ name: '常用行为', actions: commonActions })] },
    { name: '组合行为', groups: [toGroup({ name: '组合行为', actions: compositeActions })] },
  ]
}
