import type { CSSProperties, ReactNode } from 'react'
import { MousePointerClick } from 'lucide-react'
import { railKeyGlyphText } from '../devices/integration/railOverview'
import { iconFor } from './InputIcon'
import type { QuickOverlayKeySlot, QuickOverlaySurfaceBlock, QuickOverlayViewModel } from './quickOverlayModel'
import './QuickOverlay.css'

export function renderKeyGlyph(slot: Pick<QuickOverlayKeySlot, 'inputId' | 'label' | 'short' | 'icon'>) {
  const glyph = railKeyGlyphText({ id: slot.inputId, label: slot.label, icon: slot.icon }, slot.short)
  if (glyph) {
    // Skip duplicate badge text when it matches short verbatim (e.g. K01, Y, X, A, B, 侧上).
    if (glyph === slot.short) return null
    return <span className="ceramic-key-glyph-text">{glyph}</span>
  }
  if (slot.inputId.startsWith('mouse.') && slot.icon === 'center') {
    return <MousePointerClick size={12} strokeWidth={2.1} />
  }
  return iconFor(slot.icon, 12)
}

export function conciseSlotShort(slot: Pick<QuickOverlayKeySlot, 'short' | 'label'>): string {
  const raw = (slot.short?.trim() || slot.label.trim()).replace(/（.*?）|\(.*?\)/g, '').trim()
  const dpadDir: Record<string, string> = { UP: '上', DOWN: '下', LEFT: '左', RIGHT: '右' }
  const dpadMatch = raw.match(/^DPAD\.(UP|DOWN|LEFT|RIGHT)$/i)
  if (dpadMatch) return `十字${dpadDir[dpadMatch[1].toUpperCase()]}`
  const stickMatch = raw.match(/^(LS|RS)\.(UP|DOWN|LEFT|RIGHT)$/i)
  if (stickMatch) return `${stickMatch[1].toUpperCase()}${dpadDir[stickMatch[2].toUpperCase()]}`
  const mouseTrimmed = raw.replace(/^鼠标/, '').trim()
  if (/^(左键|右键|中键|侧键)$/.test(mouseTrimmed)) return mouseTrimmed
  return mouseTrimmed.replace(/键$/, '').trim() || slot.short || slot.label
}

export function slotKindClass(kind?: 'prompt' | 'action' | 'sequence'): string {
  if (!kind) return ''
  return ` kind-${kind}`
}

export function QuickOverlaySurface({
  view,
  renderKeySlot,
}: {
  view: QuickOverlayViewModel
  renderKeySlot: (slot: QuickOverlayKeySlot, extraClass?: string, style?: CSSProperties) => ReactNode
}) {
  const renderCrossWell = (well: Extract<QuickOverlaySurfaceBlock, { kind: 'cross' }>, idx: number) => (
    <div key={`cross-${idx}`} className="ceramic-cross-well">
      {well.up && renderKeySlot(well.up, 'cross-slot is-up')}
      {well.left && renderKeySlot(well.left, 'cross-slot is-left')}
      {well.center && renderKeySlot(well.center, 'cross-slot is-center')}
      {well.right && renderKeySlot(well.right, 'cross-slot is-right')}
      {well.down && renderKeySlot(well.down, 'cross-slot is-down')}
    </div>
  )

  const renderBlocks = (blocks: readonly QuickOverlaySurfaceBlock[]) =>
    blocks.map((block, idx) => {
      if (block.kind === 'cross') return renderCrossWell(block, idx)
      if (block.kind === 'bridge') {
        return (
          <div key={`bridge-${idx}`} className="ceramic-bridge-block">
            <div className="ceramic-bridge-stack">
              {renderKeySlot(block.leftStack[0])}
              {renderKeySlot(block.leftStack[1])}
            </div>
            {renderKeySlot(block.center, 'ceramic-bridge-center')}
            <div className="ceramic-bridge-stack">
              {renderKeySlot(block.rightStack[0])}
              {renderKeySlot(block.rightStack[1])}
            </div>
          </div>
        )
      }
      if (block.columns === 1 && block.align) {
        const colPos = block.align === 'left' ? 1 : block.align === 'right' ? 3 : 2
        return (
          <div key={`row-${idx}`} className="ceramic-row cols-3">
            {renderKeySlot(block.slots[0], '', { gridColumn: colPos })}
          </div>
        )
      }
      return (
        <div key={`row-${idx}`} className={`ceramic-row cols-${block.columns}`}>
          {block.slots.map(slot => renderKeySlot(slot))}
        </div>
      )
    })

  const { surface } = view

  const renderSideRail = (rail: { slots: QuickOverlayKeySlot[] }) => (
    <div className="ceramic-side-rail" aria-label="侧面按键区">
      {rail.slots.map(slot => renderKeySlot(slot, 'is-side-key'))}
    </div>
  )

  if (surface.variant === 'matrix') {
    const matrix = (
      <div
        className="ceramic-chassis is-matrix"
        style={{
          gridTemplateColumns: `repeat(${surface.cols}, minmax(0, 1fr))`,
          gridTemplateRows: `repeat(${surface.rows}, minmax(74px, 1fr))`,
        }}
      >
        {surface.oledSpan && (
          <div
            className="ceramic-matrix-oled"
            style={{
              gridRow: surface.oledSpan.row,
              gridColumn: `${surface.oledSpan.colStart} / span ${surface.oledSpan.colSpan}`,
            }}
            aria-hidden="true"
          >
            <span className="ceramic-oled-eyebrow">{view.deviceName}</span>
            <strong>{view.profileName}</strong>
            <span>{view.items.length} 键已就绪</span>
          </div>
        )}
        {surface.cells.map(cell =>
          renderKeySlot(cell, '', {
            gridColumn: cell.colSpan ? `${cell.col} / span ${cell.colSpan}` : cell.col,
            gridRow: cell.rowSpan ? `${cell.row} / span ${cell.rowSpan}` : cell.row,
          }),
        )}
      </div>
    )
    if (!surface.sideRail) return matrix
    const rail = renderSideRail(surface.sideRail)
    return (
      <div className={`ceramic-matrix-with-rail side-${surface.sideRail.side}`}>
        {surface.sideRail.side === 'left' ? (
          <>
            {rail}
            {matrix}
          </>
        ) : (
          <>
            {matrix}
            {rail}
          </>
        )}
      </div>
    )
  }

  if (surface.variant === 'mouse') {
    return (
      <div className="ceramic-chassis is-mouse">
        <div className="ceramic-mouse-thumb">{surface.thumbStack.map(slot => renderKeySlot(slot))}</div>
        <div className="ceramic-mouse-body">
          <div className="ceramic-mouse-primary">
            {surface.primaryPair.map(slot => renderKeySlot(slot, 'is-primary-click'))}
          </div>
          {renderCrossWell(surface.wheelWell, 0)}
        </div>
      </div>
    )
  }

  if (surface.variant === 'controller') {
    return (
      <div className="ceramic-chassis is-controller">
        <div className="ceramic-controller-shoulders">
          <div className="ceramic-shoulder-pair">{surface.leftShoulders.map(slot => renderKeySlot(slot))}</div>
          <div className="ceramic-shoulder-pair">{surface.rightShoulders.map(slot => renderKeySlot(slot))}</div>
        </div>
        {surface.centerRow.length > 0 && (
          <div className="ceramic-controller-center">{surface.centerRow.map(slot => renderKeySlot(slot))}</div>
        )}
        <div className="ceramic-controller-pods">
          <div className="ceramic-pod">{renderBlocks(surface.leftPod)}</div>
          <div className="ceramic-pod">{renderBlocks(surface.rightPod)}</div>
        </div>
      </div>
    )
  }

  const mainColumn = (
    <div className={`ceramic-panel-main density-${surface.density}`}>{renderBlocks(surface.blocks)}</div>
  )
  if (!surface.sideRail) {
    return <div className={`ceramic-chassis is-panel density-${surface.density}`}>{mainColumn}</div>
  }
  const sideRailEl = renderSideRail(surface.sideRail)
  return (
    <div className={`ceramic-chassis is-panel has-side-rail side-${surface.sideRail.side} density-${surface.density}`}>
      {surface.sideRail.side === 'left' ? (
        <>
          {sideRailEl}
          {mainColumn}
        </>
      ) : (
        <>
          {mainColumn}
          {sideRailEl}
        </>
      )}
    </div>
  )
}
