export function workflowLaneLayout(width: number, height: number) {
  const gap = 12
  const padding = 12
  const laneWidth = Math.max(1, (width - padding * 2 - gap * 2) / 3)
  const laneHeight = Math.max(160, height - 88)
  return { gap, padding, laneWidth, laneHeight, bodyHeight: laneHeight - 84 }
}

export function clampLaneScroll(top: number, contentHeight: number, viewportHeight: number) {
  return Math.max(0, Math.min(Math.max(0, contentHeight - viewportHeight), top))
}
