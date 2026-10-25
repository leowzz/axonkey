import type { RemoteButton } from '../../appTypes'

export const cmiotA15AdditionalButtonIds = ['cmiotA15.mute', 'cmiotA15.settings', 'cmiotA15.channelUp', 'cmiotA15.channelDown', 'cmiotA15.m'] as const
export const cmiotA15RemoteButtonIds = ['cmiotA15.power', 'cmiotA15.voice', 'cmiotA15.up', 'cmiotA15.left', 'cmiotA15.confirm', 'cmiotA15.right', 'cmiotA15.down', 'cmiotA15.back', 'cmiotA15.volumeUp', 'cmiotA15.home', 'cmiotA15.volumeDown', 'cmiotA15.menu', 'cmiotA15.tv', ...cmiotA15AdditionalButtonIds] as const
export type CmiotA15RemoteButtonId = typeof cmiotA15RemoteButtonIds[number]

// Input IDs are device-scoped; hardware protocol support is implemented separately.
export const cmiotA15RemoteButtons: RemoteButton[] = [
  { id: 'cmiotA15.power', label: '电源键', short: '电源', side: 'left', x: 18.27, y: 12.06, icon: 'power' },
  { id: 'cmiotA15.voice', label: '语音键', short: '语音', side: 'right', x: 66.19, y: 11.50, icon: 'mic' },
  { id: 'cmiotA15.up', label: '方向上', short: '上', side: 'left', x: 40.61, y: 24.79, icon: 'up' },
  { id: 'cmiotA15.left', label: '方向左', short: '左', side: 'left', x: 12.76, y: 37.30, icon: 'left' },
  { id: 'cmiotA15.confirm', label: '确认键', short: '确认', side: 'right', x: 42.23, y: 37.07, icon: 'center' },
  { id: 'cmiotA15.right', label: '方向右', short: '右', side: 'right', x: 71.70, y: 36.07, icon: 'right' },
  { id: 'cmiotA15.down', label: '方向下', short: '下', side: 'right', x: 40.61, y: 49.02, icon: 'down' },
  { id: 'cmiotA15.back', label: '返回键', short: '返回', side: 'left', x: 20.42, y: 61.09, icon: 'back' },
  { id: 'cmiotA15.volumeUp', label: '音量加', short: '音量 +', side: 'right', x: 60.42, y: 61.09, icon: 'volumeUp' },
  { id: 'cmiotA15.home', label: '主页键', short: '主页', side: 'left', x: 22.80, y: 75.72, icon: 'home' },
  { id: 'cmiotA15.volumeDown', label: '音量减', short: '音量 -', side: 'right', x: 60.42, y: 76.85, icon: 'volumeDown' },
  { id: 'cmiotA15.menu', label: '功能键', short: '功能', side: 'left', x: 21.18, y: 90.79, icon: 'menu' },
  { id: 'cmiotA15.tv', label: '电视键', short: '电视', side: 'right', x: 60.69, y: 91.91, icon: 'tv' },
  { id: 'cmiotA15.mute', label: '静音键', short: '静音', side: 'left', x: 20.95, y: 16.21, icon: 'mute' },
  { id: 'cmiotA15.settings', label: '设置键', short: '设置', side: 'right', x: 79.05, y: 16.21, icon: 'settings' },
  { id: 'cmiotA15.channelUp', label: '频道加', short: '频道 +', side: 'right', x: 79.05, y: 62.42, icon: 'up' },
  { id: 'cmiotA15.channelDown', label: '频道减', short: '频道 -', side: 'right', x: 79.05, y: 72.95, icon: 'down' },
  { id: 'cmiotA15.m', label: 'M 键', short: 'M', side: 'left', x: 50, y: 53.11, icon: 'm' },
]
