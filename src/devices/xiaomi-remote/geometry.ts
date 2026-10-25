import type { XiaomiRemoteButtonId } from './buttons.ts'
import type { RemoteKeyRegion } from '../remoteTypes.ts'

export const xiaomiRemoteViewBox = { width: 516, height: 1255 }

function circle(x: number, y: number, radius: number): RemoteKeyRegion {
  return {
    path: `M ${x - radius} ${y} a ${radius} ${radius} 0 1 0 ${radius * 2} 0 a ${radius} ${radius} 0 1 0 ${-radius * 2} 0`,
    anchor: { x, y },
  }
}

function directionSector(angle: number): RemoteKeyRegion {
  const point = (degrees: number, rx: number, ry: number) => {
    const radians = degrees * Math.PI / 180
    return `${255 + rx * Math.cos(radians)} ${454 + ry * Math.sin(radians)}`
  }
  return {
    path: `M ${point(angle - 45, 197.5, 192)} A 197.5 192 0 0 1 ${point(angle + 45, 197.5, 192)} L ${point(angle + 45, 105.5, 105.5)} A 105.5 105.5 0 0 0 ${point(angle - 45, 105.5, 105.5)} Z`,
    anchor: { x: 255 + 155 * Math.cos(angle * Math.PI / 180), y: 454 + 150 * Math.sin(angle * Math.PI / 180) },
  }
}

export const xiaomiRemoteKeyRegions: Record<XiaomiRemoteButtonId, RemoteKeyRegion> = {
  power: circle(132, 162, 53.5), voice: circle(378, 162, 53.5), up: directionSector(-90),
  left: directionSector(180), confirm: circle(255, 455, 105.2), right: directionSector(0), down: directionSector(90),
  back: circle(154, 747, 79.7), volumeUp: { path: 'M 273.5 837 V 750 A 80.5 80.5 0 0 1 434.5 750 V 837 Z', anchor: { x: 354, y: 747 } },
  home: circle(154, 926, 79.7), volumeDown: { path: 'M 273.5 837 H 434.5 V 924 A 80.5 80.5 0 0 1 273.5 924 Z', anchor: { x: 354, y: 927 } },
  menu: circle(154, 1104, 79.7), tv: circle(354, 1105, 79.7),
}
