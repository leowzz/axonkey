import type { Behavior, TriggerType } from './behaviorModel.ts'
import type { ManualKeyOption, Platform } from './appTypes.ts'
import { macosShortcutPresets } from './macosShortcutPresets.ts'

export const triggerLabels: Record<TriggerType, string> = {
  click: '单击',
  doubleClick: '双击',
  longPress: '长按',
}

export const manualKeyGroups: { label: string; options: ManualKeyOption[] }[] = [
  {
    label: '常用按键',
    options: [
      { value: 'Esc', label: '退出（Esc）' },
      { value: 'Enter', label: '回车' },
      { value: 'Space', label: '空格' },
      { value: 'Tab', label: '切换焦点（Tab）' },
      { value: 'Backspace', label: '向前删除' },
      { value: 'Delete', label: '向后删除' },
      { value: 'Insert', label: '插入' },
      { value: 'Home', label: '跳到开头' },
      { value: 'End', label: '跳到结尾' },
      { value: 'PageUp', label: '向上翻页' },
      { value: 'PageDown', label: '向下翻页' },
      { value: 'Up', label: '方向上' },
      { value: 'Down', label: '方向下' },
      { value: 'Left', label: '方向左' },
      { value: 'Right', label: '方向右' },
    ],
  },
  {
    label: '单独修饰键',
    options: [
      { value: 'Ctrl', label: 'Ctrl' },
      { value: 'RCtrl', label: '右 Ctrl' },
      { value: 'Shift', label: 'Shift' },
      { value: 'RShift', label: '右 Shift' },
      { value: 'Alt', label: 'Alt' },
      { value: 'LAlt', label: '左 Alt' },
      { value: 'RAlt', label: '右 Alt' },
      { value: 'Win', label: 'Win' },
      { value: 'RWin', label: '右 Win' },
    ],
  },
  {
    label: '标点符号',
    options: [
      { value: '[', label: '[  左方括号' },
      { value: ']', label: ']  右方括号' },
      { value: '\\', label: '\\  反斜杠' },
      { value: ';', label: ';  分号' },
      { value: "'", label: "'  单引号" },
      { value: ',', label: ',  逗号' },
      { value: '.', label: '.  句点' },
      { value: '/', label: '/  斜杠' },
      { value: '-', label: '-  减号' },
      { value: '=', label: '=  等号' },
      { value: '`', label: '`  反引号' },
    ],
  },
  {
    label: '媒体按键',
    options: [
      { value: 'VolumeUp', label: '增大音量' },
      { value: 'VolumeDown', label: '减小音量' },
      { value: 'VolumeMute', label: '静音' },
      { value: 'MediaPlayPause', label: '播放 / 暂停' },
      { value: 'MediaPrevious', label: '上一首' },
      { value: 'MediaNext', label: '下一首' },
      { value: 'MediaStop', label: '停止播放' },
    ],
  },
  {
    label: '字母与数字',
    options: [
      ...[...'ABCDEFGHIJKLMNOPQRSTUVWXYZ'].map(value => ({ value, label: value })),
      ...[...'0123456789'].map(value => ({ value, label: value })),
    ],
  },
  {
    label: '功能键',
    options: Array.from({ length: 24 }, (_, index) => ({ value: `F${index + 1}`, label: `F${index + 1}` })),
  },
]

const keyLabels = new Map(
  manualKeyGroups.flatMap(group => group.options.map(({ value, label }) => [value, label] as const)),
)

export function keyDisplayName(key: string, platform: Platform) {
  if (platform === 'macos') {
    const labels: Record<string, string> = {
      Ctrl: 'Ctrl',
      RCtrl: '右 Ctrl',
      Alt: 'Opt',
      LAlt: '左 Opt',
      RAlt: '右 Opt',
      Win: 'Cmd',
      RWin: '右 Cmd',
    }
    if (labels[key]) return labels[key]
  }
  return keyLabels.get(key) ?? key
}

export function keyGroupsForPlatform(platform: Platform) {
  if (platform !== 'macos') return manualKeyGroups
  return manualKeyGroups.map(group => {
    if (group.label === '媒体按键') {
      return { ...group, options: group.options.filter(option => option.value !== 'MediaStop') }
    }
    if (group.label !== '单独修饰键') return group
    return {
      ...group,
      options: [
        ...group.options.map(option => ({ ...option, label: keyDisplayName(option.value, platform) })),
        { value: 'Fn', label: 'Fn' },
      ],
    }
  })
}

export function behaviorSummary(
  behavior: Behavior,
  platform: Platform,
  profileNames?: ReadonlyMap<string, string> | Record<string, string>,
) {
  switch (behavior.type) {
    case 'wheel':
      return { up: '滚轮向上', down: '滚轮向下', left: '水平滚轮向左', right: '水平滚轮向右' }[behavior.direction]
    case 'mouse':
      return { left: '鼠标左键', right: '鼠标右键', back: '鼠标后退键', forward: '鼠标前进键' }[behavior.button]
    case 'cursorMove':
      return (
        { up: '光标上移', down: '光标下移', left: '光标左移', right: '光标右移' }[behavior.direction] +
        ` ${behavior.distance} 像素`
      )
    case 'key':
      return behavior.key ? keyDisplayName(behavior.key, platform) : '未录入'
    case 'shortcut': {
      const preset = macosShortcutPresets(platform).find(
        ({ keys }) => keys.length === behavior.keys.length && keys.every((key, index) => key === behavior.keys[index]),
      )
      return preset?.name ?? (behavior.keys.map(key => keyDisplayName(key, platform)).join(' + ') || '未录入')
    }
    case 'typeText':
      return behavior.title
        ? `输入：${behavior.title}`
        : behavior.text
          ? `输入：${behavior.text.slice(0, 12)}`
          : '模拟输入文字'
    case 'copyText':
      return behavior.title
        ? `复制：${behavior.title}`
        : behavior.text
          ? `复制：${behavior.text.slice(0, 12)}`
          : '写入剪贴板'
    case 'openPath':
      return `打开：${behavior.path || '文件或文件夹'}`
    case 'paste':
      return behavior.title
        ? `粘贴：${behavior.title}`
        : behavior.text
          ? `粘贴：${behavior.text.slice(0, 12)}`
          : '粘贴文本'
    case 'delay':
      return `等待 ${behavior.ms} 毫秒`
    case 'openApp':
      return behavior.path.split(/[\\/]/).pop() || '打开应用'
    case 'openWebsite':
      return behavior.url || '打开网站'
    case 'runCommand':
      return behavior.title
        ? `命令：${behavior.title}`
        : behavior.command
          ? `命令：${behavior.command.slice(0, 20)}`
          : '执行命令'
    case 'httpRequest':
      return behavior.title
        ? `${behavior.method} ${behavior.title}`
        : behavior.url
          ? `${behavior.method} ${behavior.url.slice(0, 24)}`
          : '发送 HTTP 请求'
    case 'switchProfile':
      return `${behavior.direction === 'previous' ? '上一个' : '下一个'}配置文件${behavior.wrap ? ' · 循环' : ''}`
    case 'quickOverlay': {
      const name = profileNames
        ? typeof (profileNames as ReadonlyMap<string, string>).get === 'function'
          ? (profileNames as ReadonlyMap<string, string>).get(behavior.profileId)
          : (profileNames as Record<string, string>)[behavior.profileId]
        : undefined
      return name ? `快捷交互窗 · ${name}` : '快捷交互窗'
    }
    case 'clipboardOverlay':
      return behavior.action === 'copyText' ? '剪贴板浮窗 · 仅复制' : '剪贴板浮窗'
    case 'disabled':
      return '不发送任何按键'
  }
}

export function textAndEnterValue(list: Behavior[]) {
  if (list.length !== 3) return null
  const [paste, delay, enter] = list
  if (
    paste.type !== 'paste' ||
    delay.type !== 'delay' ||
    delay.ms !== 30 ||
    enter.type !== 'key' ||
    enter.key !== 'Enter'
  )
    return null
  return paste.text
}

export function triggerSummary(list: Behavior[], trigger: TriggerType, platform: Platform) {
  if (list.length === 0) return trigger === 'click' ? '保留原按键' : '未设置'
  const summary = behaviorSummary(list[0], platform)
  return list.length > 1 ? `${summary} +${list.length - 1}` : summary
}
