export const defaultWorkflowSplitRatio = 0.54
export const workflowSplitterHeight = 18

export function workflowSplitLayout(height: number, footerHeight: number, ratio: number) {
  // Narrow lanes wrap their toolbar to two rows; keep the first action visible below it.
  const minUpper = 260 + footerHeight
  const minLower = 190
  const minHeight = minUpper + workflowSplitterHeight + minLower
  const available = Math.max(height, minHeight) - workflowSplitterHeight
  const maxUpper = available - minLower
  const upper = Math.round(Math.max(minUpper, Math.min(maxUpper, available * ratio)))
  return { minHeight, available, minUpper, maxUpper, upper }
}
