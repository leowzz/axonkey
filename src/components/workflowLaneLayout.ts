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

export type WorkflowFlowConnector = {
  x: number
  y: number
  wraps: boolean
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

export function workflowLaneLayout(width: number, height: number, laneCount = 3, maxLabelLength = 2) {
  const gap = 7
  const padding = 6
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

export function layoutWorkflowFlow(
  sizes: readonly WorkflowItemSize[],
  laneWidth: number,
  bodyHeight: number,
) {
  const safeLaneWidth = Math.max(24, laneWidth)
  const safeBodyHeight = Math.max(24, bodyHeight)
  const padLeft = 6
  const padRight = 7
  const padTop = 5
  const padBottom = 7
  const colGap = 7
  const rowGap = 5

  if (sizes.length === 0) {
    const emptyHeight = Math.min(38, Math.max(26, safeBodyHeight - 12))
    return {
      items: [] as WorkflowFlowItem[],
      connectors: [] as WorkflowFlowConnector[],
      slots: [
        {
          index: 0,
          hit: { x: 2, y: 2, width: Math.max(8, safeLaneWidth - 4), height: Math.max(8, safeBodyHeight - 4) },
          bar: { x: padLeft, y: padTop, width: Math.max(12, safeLaneWidth - padLeft - padRight), height: emptyHeight },
          empty: true,
        },
      ] as WorkflowDropSlot[],
      contentHeight: safeBodyHeight,
      overflow: 0,
    }
  }

  type Row = { start: number; end: number; y: number; height: number; bottom: number }
  const rows: Row[] = []
  const items: WorkflowFlowItem[] = new Array(sizes.length)
  const maxRight = Math.max(padLeft + 16, safeLaneWidth - padRight)

  let rowStart = 0
  let cursorX = padLeft
  let cursorY = padTop
  let rowHeight = 0

  for (let i = 0; i < sizes.length; i++) {
    const w = Math.max(16, sizes[i].width)
    const h = Math.max(18, sizes[i].height)
    if (i > rowStart && cursorX + colGap + w > maxRight + 0.5) {
      const rowIndex = rows.length
      rows.push({ start: rowStart, end: i - 1, y: cursorY, height: rowHeight, bottom: cursorY + rowHeight })
      for (let j = rowStart; j < i; j++) {
        items[j].y = cursorY + (rowHeight - items[j].height) / 2
        items[j].row = rowIndex
      }
      cursorY += rowHeight + rowGap
      cursorX = padLeft
      rowStart = i
      rowHeight = 0
    }
    const x = i === rowStart ? padLeft : cursorX + colGap
    items[i] = { index: i, x, y: cursorY, width: w, height: h, row: rows.length }
    cursorX = x + w
    rowHeight = Math.max(rowHeight, h)
  }

  const lastRowIndex = rows.length
  rows.push({ start: rowStart, end: sizes.length - 1, y: cursorY, height: rowHeight, bottom: cursorY + rowHeight })
  for (let j = rowStart; j < sizes.length; j++) {
    items[j].y = cursorY + (rowHeight - items[j].height) / 2
    items[j].row = lastRowIndex
  }

  const connectors: WorkflowFlowConnector[] = []
  for (let i = 0; i < items.length - 1; i++) {
    const current = items[i]
    const next = items[i + 1]
    const wraps = current.row !== next.row
    const x = wraps
      ? Math.min(safeLaneWidth - 5, current.x + current.width + colGap / 2)
      : current.x + current.width + colGap / 2
    if (!wraps || x >= current.x + current.width + 3) {
      connectors.push({ x, y: current.y + current.height / 2, wraps })
    }
  }

  const rawHeight = rows[rows.length - 1].bottom + padBottom
  const contentHeight = rawHeight <= safeBodyHeight + 0.5 ? safeBodyHeight : Math.ceil(rawHeight)
  const overflow = Math.max(0, contentHeight - safeBodyHeight)

  const slots: WorkflowDropSlot[] = []
  const barWidth = 2.5

  for (let r = 0; r < rows.length; r++) {
    const row = rows[r]
    const bandTop = r === 0 ? 0 : (rows[r - 1].bottom + row.y) / 2
    const bandBottom =
      r === rows.length - 1 ? Math.min(contentHeight, row.bottom + rowGap) : (row.bottom + rows[r + 1].y) / 2
    const bandHeight = Math.max(4, bandBottom - bandTop)

    const mids: number[] = []
    let prevMid = 0.5
    for (let i = row.start; i <= row.end; i++) {
      const visibleWidth = Math.max(4, Math.min(items[i].width, safeLaneWidth - items[i].x))
      const rawMid = items[i].x + visibleWidth / 2
      const mid = Math.min(safeLaneWidth - 0.5, Math.max(prevMid + 0.5, rawMid))
      mids.push(mid)
      prevMid = mid
    }

    const first = items[row.start]
    slots.push({
      index: row.start,
      hit: { x: 0, y: bandTop, width: mids[0], height: bandHeight },
      bar: {
        x: Math.max(1.5, first.x - (barWidth + 1.5)),
        y: first.y + 1,
        width: barWidth,
        height: Math.max(12, first.height - 2),
      },
    })

    for (let k = 1; k < mids.length; k++) {
      const prev = items[row.start + k - 1]
      const curr = items[row.start + k]
      slots.push({
        index: row.start + k,
        hit: { x: mids[k - 1], y: bandTop, width: Math.max(1, mids[k] - mids[k - 1]), height: bandHeight },
        bar: {
          x: prev.x + prev.width + (colGap - barWidth) / 2,
          y: curr.y + 1,
          width: barWidth,
          height: Math.max(12, curr.height - 2),
        },
      })
    }

    const last = items[row.end]
    const lastMid = mids[mids.length - 1]
    slots.push({
      index: row.end + 1,
      hit: { x: lastMid, y: bandTop, width: Math.max(1, safeLaneWidth - lastMid), height: bandHeight },
      bar: {
        x: Math.min(safeLaneWidth - barWidth - 3, last.x + last.width + (colGap - barWidth) / 2),
        y: last.y + 1,
        width: barWidth,
        height: Math.max(12, last.height - 2),
      },
    })
  }

  const lastRow = rows[rows.length - 1]
  const tailTop = Math.min(contentHeight, lastRow.bottom + rowGap)
  if (contentHeight - tailTop > 2) {
    const last = items[items.length - 1]
    slots.push({
      index: items.length,
      hit: { x: 0, y: tailTop, width: safeLaneWidth, height: contentHeight - tailTop },
      bar: {
        x: Math.min(safeLaneWidth - barWidth - 3, last.x + last.width + (colGap - barWidth) / 2),
        y: last.y + 1,
        width: barWidth,
        height: Math.max(12, last.height - 2),
      },
    })
  }

  return { items, connectors, slots, contentHeight, overflow }
}
