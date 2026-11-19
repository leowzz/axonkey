export type WorkflowItemSize = {
  width: number
  height: number
}

export type WorkflowFlowItem = {
  index: number
  x: number
  y: number
  width: number
  height: number
  row: number
}

export type WorkflowDropRect = {
  x: number
  y: number
  width: number
  height: number
}

export type WorkflowDropSlot = {
  index: number
  hit: WorkflowDropRect
  bar: WorkflowDropRect
  empty?: boolean
}

export function workflowUsesTriggerTabs(width: number, laneCount = 3) {
  return laneCount > 1 && width < laneCount * 220 + (laneCount - 1) * 6 + 8
}

export function workflowLaneLayout(width: number, height: number, laneCount = 3, maxLabelLength = 2) {
  const gap = 6
  const padding = 4
  const laneWidth = Math.max(1, (width - padding * 2 - gap * (laneCount - 1)) / laneCount)
  const laneHeight = Math.max(160, height - padding * 2)
  const titleSpan = 18 + Math.max(1, maxLabelLength) * 13.5
  const compactHeader = titleSpan + 6 + 104 <= laneWidth
  const headerHeight = compactHeader ? 36 : laneWidth < 112 ? 86 : 58
  return {
    gap,
    padding,
    laneWidth,
    laneHeight,
    headerHeight,
    compactHeader,
    bodyHeight: Math.max(24, laneHeight - headerHeight - 4),
  }
}

export function clampLaneScroll(top: number, contentHeight: number, viewportHeight: number) {
  return Math.max(0, Math.min(Math.max(0, contentHeight - viewportHeight), top))
}

export function layoutWorkflowFlow(sizes: readonly WorkflowItemSize[], laneWidth: number, bodyHeight: number) {
  const safeLaneWidth = Math.max(24, laneWidth)
  const safeBodyHeight = Math.max(24, bodyHeight)
  const sideMargin = 12
  const padTop = 10
  const padBottom = 10
  const rowGap = 8
  const maxItemWidth = Math.max(16, safeLaneWidth - sideMargin * 2)

  if (sizes.length === 0) {
    const emptyWidth = Math.min(180, maxItemWidth)
    const emptyHeight = Math.min(32, Math.max(24, safeBodyHeight - padTop - padBottom))
    return {
      items: [] as WorkflowFlowItem[],
      slots: [
        {
          index: 0,
          hit: { x: 2, y: 2, width: Math.max(8, safeLaneWidth - 4), height: Math.max(8, safeBodyHeight - 4) },
          bar: { x: (safeLaneWidth - emptyWidth) / 2, y: padTop, width: emptyWidth, height: emptyHeight },
          empty: true,
        },
      ] as WorkflowDropSlot[],
      contentHeight: safeBodyHeight,
      overflow: 0,
    }
  }

  const items: WorkflowFlowItem[] = new Array(sizes.length)
  let cursorY = padTop

  for (let i = 0; i < sizes.length; i++) {
    const w = Math.min(maxItemWidth, Math.max(16, sizes[i].width))
    const h = Math.max(18, sizes[i].height)
    const x = (safeLaneWidth - w) / 2
    items[i] = { index: i, x, y: cursorY, width: w, height: h, row: i }
    cursorY += h + (i < sizes.length - 1 ? rowGap : 0)
  }

  const rawHeight = cursorY + padBottom
  const contentHeight = rawHeight <= safeBodyHeight + 0.5 ? safeBodyHeight : Math.ceil(rawHeight)
  const overflow = Math.max(0, contentHeight - safeBodyHeight)

  const slots: WorkflowDropSlot[] = new Array(items.length + 1)
  const barHeight = 3
  const midY = (index: number) => items[index].y + items[index].height / 2

  for (let index = 0; index <= items.length; index++) {
    const bandTop = index === 0 ? 0 : midY(index - 1)
    const bandBottom = index === items.length ? contentHeight : midY(index)
    const refWidth =
      index === 0
        ? items[0].width
        : index === items.length
          ? items[items.length - 1].width
          : Math.max(items[index - 1].width, items[index].width)
    const barWidth = Math.min(maxItemWidth, Math.max(64, refWidth))
    const barX = (safeLaneWidth - barWidth) / 2
    const barY =
      index === 0
        ? Math.max(2, items[0].y + 0.5 - rowGap / 2 - barHeight / 2)
        : index === items.length
          ? Math.min(
              contentHeight - barHeight - 2,
              items[items.length - 1].y + items[items.length - 1].height + 0.5 + rowGap / 2 - barHeight / 2,
            )
          : (items[index - 1].y + items[index - 1].height + items[index].y) / 2 + 0.5 - barHeight / 2

    slots[index] = {
      index,
      hit: {
        x: 0,
        y: bandTop,
        width: safeLaneWidth,
        height: Math.max(4, bandBottom - bandTop),
      },
      bar: {
        x: barX,
        y: barY,
        width: barWidth,
        height: barHeight,
      },
    }
  }

  return { items, slots, contentHeight, overflow }
}
