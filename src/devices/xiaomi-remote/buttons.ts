import type { RemoteButton } from '../../appTypes'

export const xiaomiRemoteButtonIds = ['power', 'voice', 'up', 'left', 'confirm', 'right', 'down', 'back', 'volumeUp', 'home', 'volumeDown', 'menu', 'tv'] as const
export type XiaomiRemoteButtonId = typeof xiaomiRemoteButtonIds[number]

export const xiaomiRemoteButtons: RemoteButton[] = [
  { id: 'power', label: '电源键', short: '电源', side: 'left', x: 18.27, y: 12.06, icon: 'power' },
  { id: 'voice', label: '语音键', short: '语音', side: 'right', x: 66.19, y: 11.50, icon: 'mic' },
  { id: 'up', label: '方向上', short: '上', side: 'left', x: 40.61, y: 24.79, icon: 'up' },
  { id: 'left', label: '方向左', short: '左', side: 'left', x: 12.76, y: 37.30, icon: 'left' },
  { id: 'confirm', label: '确认键', short: '确认', side: 'right', x: 42.23, y: 37.07, icon: 'center' },
  { id: 'right', label: '方向右', short: '右', side: 'right', x: 71.70, y: 36.07, icon: 'right' },
  { id: 'down', label: '方向下', short: '下', side: 'right', x: 40.61, y: 49.02, icon: 'down' },
  { id: 'back', label: '返回键', short: '返回', side: 'left', x: 20.42, y: 61.09, icon: 'back' },
  { id: 'volumeUp', label: '音量加', short: '音量 +', side: 'right', x: 60.42, y: 61.09, icon: 'volumeUp' },
  { id: 'home', label: '主页键', short: '主页', side: 'left', x: 22.80, y: 75.72, icon: 'home' },
  { id: 'volumeDown', label: '音量减', short: '音量 -', side: 'right', x: 60.42, y: 76.85, icon: 'volumeDown' },
  { id: 'menu', label: '功能键', short: '功能', side: 'left', x: 21.18, y: 90.79, icon: 'menu' },
  { id: 'tv', label: '电视键', short: '电视', side: 'right', x: 60.69, y: 91.91, icon: 'tv' },
]
