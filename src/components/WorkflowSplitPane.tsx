import { useLayoutEffect, useRef, useState } from 'react'
import type { CSSProperties, ReactNode } from 'react'
import { defaultWorkflowSplitRatio, workflowSplitLayout } from './workflowSplitLayout'

export function WorkflowSplitPane({
  header,
  canvas,
  editor,
  ratio,
  onRatioChange,
}: {
  header?: ReactNode
  canvas: ReactNode
  editor: ReactNode
  ratio: number
  onRatioChange: (ratio: number) => void
}) {
  const layoutRef = useRef<HTMLDivElement>(null)
  const upperRef = useRef<HTMLDivElement>(null)
  const dragRef = useRef<{ y: number; height: number } | null>(null)
  const [size, setSize] = useState({ height: 0, footer: 0 })
  const [resizing, setResizing] = useState(false)
  const layout = workflowSplitLayout(size.height, size.footer, ratio)

  useLayoutEffect(() => {
    const pane = layoutRef.current!
    const footer = upperRef.current!.querySelector<HTMLElement>('.workflow-canvas-footer')!
    const measure = () => setSize({ height: pane.clientHeight, footer: footer.offsetHeight })
    const observer = new ResizeObserver(measure)
    observer.observe(pane)
    observer.observe(footer)
    measure()
    return () => observer.disconnect()
  }, [])

  const resize = (height: number) =>
    onRatioChange(Math.max(layout.minUpper, Math.min(layout.maxUpper, height)) / layout.available)
  const endDrag = () => {
    dragRef.current = null
    setResizing(false)
  }

  return (
    <div className="workflow-editor-column">
      {header}
      <div className="workflow-split-scroll">
        <div
          ref={layoutRef}
          className="workflow-split-layout"
          data-resizing={resizing || undefined}
          style={
            {
              '--workflow-upper-height': `${layout.upper}px`,
              minHeight: layout.minHeight,
            } as CSSProperties
          }
        >
          <div ref={upperRef} className="workflow-canvas-panel">
            {canvas}
          </div>
          <div
            className="workflow-editor-splitter"
            role="separator"
            tabIndex={0}
            aria-label="调整泳道与行为编辑区高度"
            aria-orientation="horizontal"
            aria-valuemin={layout.minUpper}
            aria-valuemax={Math.round(layout.maxUpper)}
            aria-valuenow={layout.upper}
            title="拖动调整高度，双击恢复默认"
            onPointerDown={event => {
              if (event.button !== 0) return
              event.preventDefault()
              event.currentTarget.focus()
              event.currentTarget.setPointerCapture(event.pointerId)
              dragRef.current = { y: event.clientY, height: layout.upper }
              setResizing(true)
            }}
            onPointerMove={event => {
              const drag = dragRef.current
              if (drag) resize(drag.height + event.clientY - drag.y)
            }}
            onPointerUp={endDrag}
            onPointerCancel={endDrag}
            onLostPointerCapture={endDrag}
            onDoubleClick={() => onRatioChange(defaultWorkflowSplitRatio)}
            onKeyDown={event => {
              const step = event.shiftKey ? 32 : 12
              switch (event.key) {
                case 'ArrowUp':
                  resize(layout.upper - step)
                  break
                case 'ArrowDown':
                  resize(layout.upper + step)
                  break
                case 'Home':
                  resize(layout.minUpper)
                  break
                case 'End':
                  resize(layout.maxUpper)
                  break
                case 'Enter':
                  onRatioChange(defaultWorkflowSplitRatio)
                  break
                default:
                  return
              }
              event.preventDefault()
              event.stopPropagation()
            }}
          >
            <span />
          </div>
          <section className="workflow-behavior-panel" aria-label="行为编辑">
            {editor}
          </section>
        </div>
      </div>
    </div>
  )
}
