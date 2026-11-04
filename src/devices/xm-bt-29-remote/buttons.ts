import type { RemoteButton } from '../../appTypes'
import { cmiotA15RemoteButtonIds, cmiotA15RemoteButtons } from '../cmiot-a15-remote/buttons.ts'
import { xmBt29RemoteKeyRegions, xmBt29RemoteViewBox } from './geometry.ts'

export const xmBt29AdditionalButtonIds = [
  'xmBt29.digit0',
  'xmBt29.digit1',
  'xmBt29.digit2',
  'xmBt29.digit3',
  'xmBt29.digit4',
  'xmBt29.digit5',
  'xmBt29.digit6',
  'xmBt29.digit7',
  'xmBt29.digit8',
  'xmBt29.digit9',
  'xmBt29.delete',
] as const
// Shared keys retain their saved mapping IDs from the original A15-based adapter.
export const xmBt29RemoteButtonIds = [...cmiotA15RemoteButtonIds, ...xmBt29AdditionalButtonIds] as const
export type XmBt29RemoteButtonId = (typeof xmBt29RemoteButtonIds)[number]

export const xmBt29RemoteButtons: RemoteButton[] = [
  ...cmiotA15RemoteButtons.map(button =>
    button.id === 'cmiotA15.menu' ? { ...button, label: '菜单键', short: '菜单' } : button,
  ),
  ...xmBt29AdditionalButtonIds.map((id): RemoteButton => {
    const digit = id.slice(-1)
    const isDelete = id === 'xmBt29.delete'
    return {
      id,
      label: isDelete ? '删除键' : `数字 ${digit}`,
      short: isDelete ? '删除' : digit,
      side: 'right',
      x: 0,
      y: 0,
      icon: isDelete ? 'delete' : 'number',
    }
  }),
].map(button => {
  const { x, y } = xmBt29RemoteKeyRegions[button.id as XmBt29RemoteButtonId].anchor
  return {
    ...button,
    side: x < xmBt29RemoteViewBox.width / 2 ? 'left' : 'right',
    x: (x / xmBt29RemoteViewBox.width) * 100,
    y: (y / xmBt29RemoteViewBox.height) * 100,
  }
})
