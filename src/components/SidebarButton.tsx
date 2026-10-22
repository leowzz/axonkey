import { useEffect, useRef, useState } from 'react'
import type { ComponentProps } from 'react'
import { createPortal } from 'react-dom'

export function SidebarButton({ collapsed, title, ...props }: ComponentProps<'button'> & { collapsed: boolean }) {
  const button = useRef<HTMLButtonElement>(null)
  const timer = useRef<ReturnType<typeof setTimeout>>()
  const [position, setPosition] = useState<{ left: number; top: number } | null>(null)
  const close = () => { clearTimeout(timer.current); setPosition(null) }
  const show = () => {
    const rect = button.current?.getBoundingClientRect()
    if (rect) setPosition({ left: rect.right + 8, top: Math.max(32, Math.min(rect.top + rect.height / 2, window.innerHeight - 32)) })
  }
  useEffect(() => {
    close()
    return () => clearTimeout(timer.current)
  }, [collapsed, title])
  useEffect(() => {
    if (!collapsed) return
    const key = (event: KeyboardEvent) => { if (event.key === 'Escape') close() }
    window.addEventListener('scroll', close, true)
    window.addEventListener('resize', close)
    window.addEventListener('blur', close)
    window.addEventListener('keydown', key)
    return () => {
      window.removeEventListener('scroll', close, true)
      window.removeEventListener('resize', close)
      window.removeEventListener('blur', close)
      window.removeEventListener('keydown', key)
    }
  }, [collapsed])
  return <>
    <button {...props} ref={button} title={collapsed ? undefined : title}
      onMouseEnter={(event) => {
        props.onMouseEnter?.(event)
        if (collapsed && title) { clearTimeout(timer.current); timer.current = setTimeout(show, 500) }
      }}
      onMouseLeave={(event) => { props.onMouseLeave?.(event); close() }}
      onFocus={(event) => { props.onFocus?.(event); if (collapsed && title && event.currentTarget.matches(':focus-visible')) show() }}
      onBlur={(event) => { props.onBlur?.(event); close() }}
      onPointerDown={(event) => { props.onPointerDown?.(event); close() }}
      onClick={(event) => { props.onClick?.(event); close() }}
    />
    {collapsed && position && createPortal(<div role="tooltip" className="sidebar-tooltip" style={position}>{title}</div>, document.body)}
  </>
}
