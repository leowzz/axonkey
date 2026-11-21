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
  keywords?: string
  recommendedFallback?: boolean
}

export function workflowToolboxPalettes(platform: Platform, quickOverlay = false): WorkflowToolboxPalette[] {
  const mod = keyDisplayName(platform === 'macos' ? 'Win' : 'Ctrl', platform)
  const keyboardActions: WorkflowAction[] = [
    {
      preset: 'customKey',
      name: '按键 / 组合键',
      description: '录入任意单键或组合快捷键',
      keywords: 'key shortcut hotkey 按键 快捷键 组合键',
      recommendedFallback: true,
    },
    {
      preset: 'copy',
      name: '复制',
      description: `${mod} + C`,
      keywords: 'copy ctrl cmd c 复制',
      recommendedFallback: true,
    },
    {
      preset: 'pasteShortcut',
      name: '粘贴',
      description: `${mod} + V`,
      keywords: 'paste ctrl cmd v 粘贴',
      recommendedFallback: true,
    },
    {
      preset: 'undo',
      name: '撤销',
      description: `${mod} + Z`,
      keywords: 'undo ctrl cmd z 撤销',
    },
    {
      preset: 'selectAll',
      name: '全选',
      description: `${mod} + A`,
      keywords: 'select all ctrl cmd a 全选',
    },
    {
      preset: 'closeTab',
      name: '关闭标签页',
      description: `${mod} + W`,
      keywords: 'close tab window ctrl cmd w 关闭',
    },
    {
      preset: 'enter',
      name: '确认 / 回车',
      description: 'Enter',
      keywords: 'enter return ok confirm 回车 确认',
      recommendedFallback: true,
    },
    {
      preset: 'escape',
      name: '返回 / 关闭',
      description: 'Esc',
      keywords: 'esc escape back cancel 退出 返回',
      recommendedFallback: true,
    },
    {
      preset: 'space',
      name: '空格',
      description: 'Space',
      keywords: 'space pause 空格',
    },
    { preset: 'arrowUp', name: '方向上', description: '↑', keywords: 'up arrow direction 方向' },
    { preset: 'arrowDown', name: '方向下', description: '↓', keywords: 'down arrow direction 方向' },
    { preset: 'arrowLeft', name: '方向左', description: '←', keywords: 'left arrow direction 方向' },
    { preset: 'arrowRight', name: '方向右', description: '→', keywords: 'right arrow direction 方向' },
    { preset: 'pageUp', name: '向上翻页', description: 'Page Up', keywords: 'page up pgup scroll 翻页' },
    { preset: 'pageDown', name: '向下翻页', description: 'Page Down', keywords: 'page down pgdn scroll 翻页' },
    {
      preset: 'previousTab',
      name: '上一标签页',
      description: `${keyDisplayName('Ctrl', platform)} + Shift + Tab`,
      keywords: 'previous tab switch 切换标签页',
    },
    {
      preset: 'nextTab',
      name: '下一标签页',
      description: `${keyDisplayName('Ctrl', platform)} + Tab`,
      keywords: 'next tab switch 切换标签页',
    },
    { preset: 'tab', name: '切换焦点', description: 'Tab', keywords: 'tab focus next 焦点' },
    { preset: 'backspace', name: '向前删除', description: 'Backspace', keywords: 'backspace delete erase 退格' },
    { preset: 'delete', name: '向后删除', description: 'Delete', keywords: 'delete del remove 删除' },
    { preset: 'keyHome', name: '跳到开头', description: 'Home', keywords: 'home start 开头' },
    { preset: 'keyEnd', name: '跳到结尾', description: 'End', keywords: 'end bottom 结尾' },
    ...rightModifierChoices().map(({ preset, key }) => ({
      preset,
      name: keyDisplayName(key, platform),
      description: '单独修饰键（可配合语音按住输入）',
      keywords: `modifier ${key.toLowerCase()} rctrl ralt ropt rwin rcmd 修饰键`,
    })),
  ]

  const mouseActions: WorkflowAction[] =
    platform === 'windows' || platform === 'macos'
      ? [
          {
            preset: 'mouseButton',
            name: '鼠标按键',
            description: '左键、右键、后退或前进',
            keywords: 'mouse click left right back forward 鼠标 点击 后退 前进',
            recommendedFallback: true,
          },
          {
            preset: 'wheel',
            name: '鼠标滚动',
            description: '向上、向下、向左或向右滚轮',
            keywords: 'wheel scroll up down left right 鼠标 滚轮 滚动',
            recommendedFallback: true,
          },
          {
            preset: 'cursorMove',
            name: '光标移动',
            description: `移动鼠标指针，默认 ${defaultCursorDistance} 像素`,
            keywords: 'cursor pointer move mouse distance 指针 光标',
          },
        ]
      : []

  const mediaActions: WorkflowAction[] = [
    {
      preset: 'mediaPlayPause',
      name: '播放 / 暂停',
      description: '切换当前媒体播放状态',
      keywords: 'media play pause music video 播放 暂停',
      recommendedFallback: true,
    },
    {
      preset: 'volumeControl',
      name: '音量控制',
      description: '增大音量、减小音量或静音',
      keywords: 'volume up down mute audio sound 音量 静音',
      recommendedFallback: true,
    },
    {
      preset: 'mediaTrack',
      name: '曲目切换',
      description: '切换上一首或下一首',
      keywords: 'media previous next track song 切歌 上一首 下一首',
    },
    ...(platform === 'windows'
      ? [
          {
            preset: 'mediaStop' as const,
            name: '停止播放',
            description: '发送媒体停止键',
            keywords: 'media stop 停止',
          },
        ]
      : []),
  ]

  const textActions: WorkflowAction[] = [
    {
      preset: 'paste',
      name: '粘贴文本',
      description: '写入剪贴板并发送粘贴快捷键',
      keywords: 'paste text prompt snippet 粘贴 文本 提示词',
      recommendedFallback: true,
    },
    {
      preset: 'copyText',
      name: '写入剪贴板',
      description: '仅将文本写入剪贴板，不自动粘贴',
      keywords: 'copy text clipboard snippet 剪贴板 复制文本',
      recommendedFallback: true,
    },
    {
      preset: 'typeText',
      name: '模拟输入文字',
      description: '逐字直接输入，不覆盖剪贴板内容',
      keywords: 'type text input string 打字 输入',
    },
    {
      preset: 'textAndEnter',
      name: '输入文本并回车',
      description: '粘贴预设内容并在 30 毫秒后回车发送',
      keywords: 'text enter send chat ai prompt 发送 聊天',
    },
    {
      preset: 'deleteAllText',
      name: '删除全部文本',
      description: `${mod} + A，等待 30 毫秒后 ${mod} + X`,
      keywords: 'clear delete cut all text 清空文本',
    },
  ]

  const systemActions: WorkflowAction[] = [
    {
      preset: 'runCommand',
      name: '执行命令',
      description: platform === 'macos' ? '在后台通过 zsh 运行命令或脚本' : '在后台无窗口运行 PowerShell 命令或脚本',
      keywords: 'command shell bash zsh powershell cmd script cli agent terminal 终端 命令 脚本',
      recommendedFallback: true,
    },
    {
      preset: 'httpRequest',
      name: '发送 HTTP 请求',
      description: '后台异步请求 Webhook、REST API 或本地服务',
      keywords: 'http https webhook api curl rest json fetch post get agent 请求 接口',
      recommendedFallback: true,
    },
    {
      preset: 'openApp',
      name: '打开应用',
      description: '启动或切换到指定应用程序',
      keywords: 'app application launch program 启动 软件 应用',
      recommendedFallback: true,
    },
    {
      preset: 'openWebsite',
      name: '打开网站',
      description: '使用默认浏览器打开网页链接',
      keywords: 'url website link browser http https 网页 网址 链接',
      recommendedFallback: true,
    },
    {
      preset: 'openPath',
      name: '打开文件或文件夹',
      description: '使用系统默认方式打开指定路径',
      keywords: 'file folder directory explorer finder path 文件 文件夹 目录 路径',
    },
    ...macosShortcutPresets(platform).map(action => ({
      ...action,
      keywords: `macos ${action.name} ${action.description}`,
    })),
  ]

  const flowActions: WorkflowAction[] = [
    ...(!quickOverlay
      ? [
          {
            preset: 'quickOverlay' as const,
            name: '快捷交互窗',
            description: '唤起独立快捷面板并在按下一键执行后自动关闭',
            keywords: 'quick overlay menu panel popup 快捷 菜单 浮窗',
            recommendedFallback: true,
          },
          {
            preset: 'switchProfile' as const,
            name: '切换配置文件',
            description: '切到上一个或下一个配置方案，支持边缘循环',
            keywords: 'switch profile mode preset 切换 配置',
            recommendedFallback: true,
          },
        ]
      : []),
    {
      preset: 'delay',
      name: '等待',
      description: '暂停指定毫秒后再执行后续动作',
      keywords: 'wait delay sleep pause ms 延时 延迟',
    },
    {
      preset: 'disabled',
      name: '禁用此触发方式',
      description: '替换当前泳道序列，不发送任何输入（清空可恢复）',
      keywords: 'disable block none off 禁用 屏蔽',
    },
  ]

  const groups: { name: string; actions: WorkflowAction[] }[] = [
    { name: '键盘', actions: keyboardActions },
    { name: '鼠标', actions: mouseActions },
    { name: '媒体', actions: mediaActions },
    { name: '文本', actions: textActions },
    { name: '系统与命令', actions: systemActions },
    { name: '流程控制', actions: flowActions },
  ]

  const toGroup = (group: { name: string; actions: WorkflowAction[] }): ToolboxGroupConfiguration => ({
    name: group.name,
    steps: group.actions.map(({ preset, name, description, keywords, recommendedFallback }) => ({
      componentType: 'task',
      type: preset,
      name,
      properties: {
        preset,
        description: description ?? '',
        ...(keywords ? { keywords } : {}),
        ...(recommendedFallback ? { recommendedFallback: true } : {}),
        ...(preset === 'delay' ? { ms: defaultWorkflowDelayMs } : {}),
      },
    })),
  })

  return [{ name: '内置', groups: groups.map(toGroup) }]
}
