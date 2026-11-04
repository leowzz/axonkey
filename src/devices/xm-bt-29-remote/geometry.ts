import type { RemoteKeyRegion } from '../types.ts'
import type { XmBt29RemoteButtonId } from './buttons.ts'

export const xmBt29RemoteViewBox = { width: 420, height: 1560 }

function circle(x: number, y: number, radius: number): RemoteKeyRegion {
  return {
    path: `M ${x - radius} ${y} a ${radius} ${radius} 0 1 0 ${radius * 2} 0 a ${radius} ${radius} 0 1 0 ${-radius * 2} 0`,
    anchor: { x, y },
  }
}

function pill(x: number, y: number): RemoteKeyRegion {
  return {
    path: `M ${x - 18.5} ${y - 31} H ${x + 18.5} a 31 31 0 0 1 0 62 H ${x - 18.5} a 31 31 0 0 1 0 -62 Z`,
    anchor: { x, y },
  }
}

function directionSector(angle: number): RemoteKeyRegion {
  const point = (degrees: number, radius: number) => {
    const radians = (degrees * Math.PI) / 180
    return `${210 + radius * Math.cos(radians)} ${370 + radius * Math.sin(radians)}`
  }
  return {
    path: `M ${point(angle - 45, 145.8)} A 145.8 145.8 0 0 1 ${point(angle + 45, 145.8)} L ${point(angle + 45, 64)} A 64 64 0 0 0 ${point(angle - 45, 64)} Z`,
    anchor: { x: 210 + 110 * Math.cos((angle * Math.PI) / 180), y: 370 + 110 * Math.sin((angle * Math.PI) / 180) },
  }
}

function rockerHalf(x: number, down: boolean): RemoteKeyRegion {
  return {
    path: down
      ? `M ${x - 33.5} 748 H ${x + 33.5} V 813.5 a 33.5 33.5 0 0 1 -67 0 Z`
      : `M ${x - 33.5} 748 V 682.5 a 33.5 33.5 0 0 1 67 0 V 748 Z`,
    anchor: { x, y: down ? 811 : 687 },
  }
}

export const xmBt29RemoteKeyRegions: Record<XmBt29RemoteButtonId, RemoteKeyRegion> = {
  'cmiotA15.power': circle(332, 84, 40.8),
  'cmiotA15.voice': circle(210, 748, 64),
  'cmiotA15.up': directionSector(-90),
  'cmiotA15.left': directionSector(180),
  'cmiotA15.confirm': circle(210, 370, 64),
  'cmiotA15.right': directionSector(0),
  'cmiotA15.down': directionSector(90),
  'cmiotA15.back': pill(332, 584),
  'cmiotA15.volumeUp': rockerHalf(88, false),
  'cmiotA15.home': pill(88, 584),
  'cmiotA15.volumeDown': rockerHalf(88, true),
  'cmiotA15.menu': pill(88, 186),
  'cmiotA15.mute': pill(88, 1194),
  'cmiotA15.settings': pill(332, 186),
  'cmiotA15.m': pill(210, 584),
  'cmiotA15.channelUp': rockerHalf(332, false),
  'cmiotA15.channelDown': rockerHalf(332, true),
  'xmBt29.digit1': pill(88, 918),
  'xmBt29.digit2': pill(210, 918),
  'xmBt29.digit3': pill(332, 918),
  'xmBt29.digit4': pill(88, 1010),
  'xmBt29.digit5': pill(210, 1010),
  'xmBt29.digit6': pill(332, 1010),
  'xmBt29.digit7': pill(88, 1102),
  'xmBt29.digit8': pill(210, 1102),
  'xmBt29.digit9': pill(332, 1102),
  'xmBt29.digit0': pill(210, 1194),
  'xmBt29.delete': pill(332, 1194),
}
