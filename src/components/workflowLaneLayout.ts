export function workflowLaneLayout(width: number, height: number, laneCount = 3) {
  const gap = 12
  const padding = 12
  const laneWidth = Math.max(1, (width - padding * 2 - gap * (laneCount - 1)) / laneCount)
  const laneHeight = Math.max(160, height - 88)
  const headerHeight = laneWidth < 154 ? 114 : 80
  return { gap, padding, laneWidth, laneHeight, headerHeight, bodyHeight: Math.max(24, laneHeight - headerHeight - 4) }
}

export function clampLaneScroll(top: number, contentHeight: number, viewportHeight: number) {
  return Math.max(0, Math.min(Math.max(0, contentHeight - viewportHeight), top))
}
