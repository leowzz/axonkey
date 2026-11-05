import type { RemoteKeyRegion } from '../types.ts'
import type { ObeRcuR5RemoteButtonId } from './buttons.ts'

export const obeRcuR5RemoteViewBox = { width: 420, height: 1320 }

function circle(x: number, y: number, radius: number): RemoteKeyRegion {
  return {
    path: `M ${x - radius} ${y} a ${radius} ${radius} 0 1 0 ${radius * 2} 0 a ${radius} ${radius} 0 1 0 ${-radius * 2} 0`,
    anchor: { x, y },
  }
}
function directionSector(angle: number): RemoteKeyRegion {
  const point = (degrees: number, rx: number, ry: number) => {
    const radians = (degrees * Math.PI) / 180
    return `${210 + rx * Math.cos(radians)} ${354 + ry * Math.sin(radians)}`
  }
  return {
    path: `M ${point(angle - 45, 145.8, 145.8)} A 145.8 145.8 0 0 1 ${point(angle + 45, 145.8, 145.8)} L ${point(angle + 45, 66, 66)} A 66 66 0 0 0 ${point(angle - 45, 66, 66)} Z`,
    anchor: { x: 210 + 108 * Math.cos((angle * Math.PI) / 180), y: 354 + 108 * Math.sin((angle * Math.PI) / 180) },
  }
}
export const obeRcuR5RemoteKeyRegions: Record<ObeRcuR5RemoteButtonId, RemoteKeyRegion> = {
  'obeRcuR5.power': circle(88, 93, 40.8),
  'obeRcuR5.locate': circle(332, 93, 40.8),
  'obeRcuR5.up': directionSector(-90),
  'obeRcuR5.left': directionSector(180),
  'obeRcuR5.confirm': circle(210, 354, 66),
  'obeRcuR5.right': directionSector(0),
  'obeRcuR5.down': directionSector(90),
  'obeRcuR5.home': circle(88, 584, 40.8),
  'obeRcuR5.back': circle(210, 584, 40.8),
  'obeRcuR5.voice': circle(332, 584, 40.8),
  'obeRcuR5.volumeDown': circle(88, 748, 40.8),
  'obeRcuR5.volumeUp': circle(332, 748, 40.8),
}
