import type { RemoteButton } from '../appTypes'

export type RemoteKeyRegion = {
  path: string
  anchor: { x: number; y: number }
}

export type RemoteView = {
  buttons: readonly RemoteButton[]
  viewBox: { width: number; height: number }
  keyRegions: Record<string, RemoteKeyRegion>
  artworkUrl: string
  ariaLabel: string
}
