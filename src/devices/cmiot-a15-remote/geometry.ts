import type { RemoteKeyRegion } from '../remoteTypes.ts'
import type { CmiotA15RemoteButtonId } from './buttons.ts'

export const cmiotA15RemoteViewBox = { width: 420, height: 1320 }

function circle(x: number, y: number, radius: number): RemoteKeyRegion {
  return { path: `M ${x - radius} ${y} a ${radius} ${radius} 0 1 0 ${radius * 2} 0 a ${radius} ${radius} 0 1 0 ${-radius * 2} 0`, anchor: { x, y } }
}
function directionSector(angle: number): RemoteKeyRegion {
  const point = (degrees: number, rx: number, ry: number) => {
    const radians = degrees * Math.PI / 180
    return `${210 + rx * Math.cos(radians)} ${448 + ry * Math.sin(radians)}`
  }
  return { path: `M ${point(angle - 45, 166.8, 166.8)} A 166.8 166.8 0 0 1 ${point(angle + 45, 166.8, 166.8)} L ${point(angle + 45, 72, 72)} A 72 72 0 0 0 ${point(angle - 45, 72, 72)} Z`, anchor: { x: 210 + 120 * Math.cos(angle * Math.PI / 180), y: 448 + 120 * Math.sin(angle * Math.PI / 180) } }
}
export const cmiotA15RemoteKeyRegions: Record<CmiotA15RemoteButtonId, RemoteKeyRegion> = {
  'cmiotA15.power': circle(88, 101, 40.8), 'cmiotA15.voice': circle(210, 889, 48), 'cmiotA15.up': directionSector(-90),
  'cmiotA15.left': directionSector(180), 'cmiotA15.confirm': circle(210, 448, 72), 'cmiotA15.right': directionSector(0), 'cmiotA15.down': directionSector(90),
  'cmiotA15.back': circle(332, 701, 40.8), 'cmiotA15.volumeUp': { path: 'M 46.7 889 V 819.3 A 41.3 41.3 0 0 1 129.3 819.3 V 889 Z', anchor: { x: 88, y: 824 } },
  'cmiotA15.home': circle(88, 701, 40.8), 'cmiotA15.volumeDown': { path: 'M 46.7 889 H 129.3 V 958.7 A 41.3 41.3 0 0 1 46.7 958.7 Z', anchor: { x: 88, y: 963 } },
  'cmiotA15.menu': circle(210, 213, 40.8),
  'cmiotA15.mute': circle(88, 214, 40.8),
  'cmiotA15.settings': circle(332, 214, 40.8),
  'cmiotA15.m': circle(210, 701, 40.8),
  'cmiotA15.channelUp': { path: 'M 290.7 889 V 819.3 A 41.3 41.3 0 0 1 373.3 819.3 V 889 Z', anchor: { x: 332, y: 824 } },
  'cmiotA15.channelDown': { path: 'M 290.7 889 H 373.3 V 958.7 A 41.3 41.3 0 0 1 290.7 958.7 Z', anchor: { x: 332, y: 963 } },
}
