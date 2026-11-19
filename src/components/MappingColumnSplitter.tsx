import { useLayoutEffect, useRef, useState } from 'react'

export function MappingColumnSplitter({
  panel,
  onResize,
}: {
  panel: 'diagram' | 'library'
  onResize: (width: number | undefined) => void
}) {
  const ref = useRef<HTMLDivElement>(null)
  const dragRef = useRef<{ x: number; width: number } | null>(null)
  const [size, setSize] = useState({ width: 0, max: 0 })
  const [resizing, setResizing] = useState(false)
  const minimum = panel === 'diagram' ? 190 : 224
  const reserve = panel === 'diagram' ? 560 : 300

  useLayoutEffect(() => {
    const splitter = ref.current!
    const container = splitter.parentElement!
    const target = panel === 'diagram' ? splitter.previousElementSibling! : splitter.nextElementSibling!
    const measure = () => {
      const style = getComputedStyle(container)
      const available = container.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight)
      const targetStyle = getComputedStyle(target)
      const width =
        target.getBoundingClientRect().width + parseFloat(targetStyle.marginLeft) + parseFloat(targetStyle.marginRight)
      setSize({ width, max: Math.max(minimum, available - reserve) })
    }
    const observer = new ResizeObserver(measure)
    observer.observe(container)
    observer.observe(target)
    measure()
    return () => observer.disconnect()
  }, [panel, minimum, reserve])

  const resize = (width: number) => onResize(Math.round(Math.max(minimum, Math.min(size.max, width))))
  const endDrag = () => {
    dragRef.current = null
    setResizing(false)
  }

  return (
    <div
      ref={ref}
      className="mapping-column-splitter"
      data-resizing={resizing || undefined}
      role="separator"
      tabIndex={0}
      aria-label={panel === 'diagram' ? '调整设备示意图区域宽度' : '调整行为库宽度'}
      aria-orientation="vertical"
      aria-valuemin={minimum}
      aria-valuemax={Math.round(size.max)}
      aria-valuenow={Math.round(size.width)}
      title="拖动调整宽度，双击恢复自动"
      onPointerDown={event => {
        if (event.button !== 0) return
        event.preventDefault()
        event.currentTarget.focus()
        event.currentTarget.setPointerCapture(event.pointerId)
        dragRef.current = { x: event.clientX, width: size.width }
        setResizing(true)
      }}
      onPointerMove={event => {
        const drag = dragRef.current
        if (drag) resize(drag.width + (event.clientX - drag.x) * (panel === 'diagram' ? 1 : -1))
      }}
      onPointerUp={endDrag}
      onPointerCancel={endDrag}
      onLostPointerCapture={endDrag}
      onDoubleClick={() => onResize(undefined)}
      onKeyDown={event => {
        const step = (event.shiftKey ? 32 : 12) * (panel === 'diagram' ? 1 : -1)
        switch (event.key) {
          case 'ArrowLeft':
            resize(size.width - step)
            break
          case 'ArrowRight':
            resize(size.width + step)
            break
          case 'Home':
            resize(minimum)
            break
          case 'End':
            resize(size.max)
            break
          case 'Enter':
            onResize(undefined)
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
  )
}
