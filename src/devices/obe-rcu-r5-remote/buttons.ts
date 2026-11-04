import type { RemoteButton } from '../../appTypes'
import { obeRcuR5RemoteKeyRegions, obeRcuR5RemoteViewBox } from './geometry.ts'

export const obeRcuR5RemoteButtonIds = [
  'obeRcuR5.power',
  'obeRcuR5.locate',
  'obeRcuR5.up',
  'obeRcuR5.left',
  'obeRcuR5.confirm',
  'obeRcuR5.right',
  'obeRcuR5.down',
  'obeRcuR5.home',
  'obeRcuR5.back',
  'obeRcuR5.voice',
  'obeRcuR5.volumeDown',
  'obeRcuR5.volumeUp',
] as const
export type ObeRcuR5RemoteButtonId = (typeof obeRcuR5RemoteButtonIds)[number]

export const obeRcuR5RemoteButtons: RemoteButton[] = (
  [
    { id: 'obeRcuR5.power', label: '电源键', short: '电源', icon: 'power' },
    { id: 'obeRcuR5.locate', label: '定位键', short: '定位', icon: 'locate' },
    { id: 'obeRcuR5.up', label: '方向上', short: '上', icon: 'up' },
    { id: 'obeRcuR5.left', label: '方向左', short: '左', icon: 'left' },
    { id: 'obeRcuR5.confirm', label: '确认键', short: '确认', icon: 'center' },
    { id: 'obeRcuR5.right', label: '方向右', short: '右', icon: 'right' },
    { id: 'obeRcuR5.down', label: '方向下', short: '下', icon: 'down' },
    { id: 'obeRcuR5.home', label: '主页键', short: '主页', icon: 'home' },
    { id: 'obeRcuR5.back', label: '返回键', short: '返回', icon: 'back' },
    { id: 'obeRcuR5.voice', label: '语音键（菜单按钮）', short: '语音', icon: 'mic' },
    { id: 'obeRcuR5.volumeDown', label: '音量减', short: '音量 -', icon: 'volumeDown' },
    { id: 'obeRcuR5.volumeUp', label: '音量加', short: '音量 +', icon: 'volumeUp' },
  ] satisfies Pick<RemoteButton, 'id' | 'label' | 'short' | 'icon'>[]
).map((button): RemoteButton => {
  const { x, y } = obeRcuR5RemoteKeyRegions[button.id].anchor
  return {
    ...button,
    side: x < obeRcuR5RemoteViewBox.width / 2 ? 'left' : 'right',
    x: (x / obeRcuR5RemoteViewBox.width) * 100,
    y: (y / obeRcuR5RemoteViewBox.height) * 100,
  }
})
