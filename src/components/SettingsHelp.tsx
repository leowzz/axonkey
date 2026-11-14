import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { CircleHelp } from 'lucide-react'
import type { ReactNode } from 'react'

export function SettingsHelp({ id, label, children }: { id: string; label: string; children: ReactNode }) {
  const [open, setOpen] = useState(false)
  const [position, setPosition] = useState({ left: 0, top: 0 })
  const button = useRef<HTMLButtonElement>(null)
  const panel = useRef<HTMLDivElement>(null)
  const timer = useRef<ReturnType<typeof setTimeout>>()
  const cancel = () => clearTimeout(timer.current)
  const close = () => { cancel(); setOpen(false) }
  const leave = () => { cancel(); timer.current = setTimeout(() => setOpen(false), 140) }
  useEffect(() => cancel, [])
  useEffect(() => {
    if (!open) return
    const dismiss = (event: Event) => {
      const target = event.target as Node | null
      if ((event.type === 'pointerdown' || event.type === 'focusin') && (button.current?.contains(target) || panel.current?.contains(target))) return
      if (event.type === 'scroll' && target && panel.current?.contains(target)) return
      close()
    }
    const key = (event: KeyboardEvent) => { if (event.key === 'Escape') { event.preventDefault(); close() } }
    window.addEventListener('pointerdown', dismiss)
    window.addEventListener('focusin', dismiss)
    window.addEventListener('scroll', dismiss, true)
    window.addEventListener('resize', dismiss)
    window.addEventListener('keydown', key)
    return () => {
      window.removeEventListener('pointerdown', dismiss)
      window.removeEventListener('focusin', dismiss)
      window.removeEventListener('scroll', dismiss, true)
      window.removeEventListener('resize', dismiss)
      window.removeEventListener('keydown', key)
    }
  }, [open])
  useLayoutEffect(() => {
    if (!open || !button.current || !panel.current) return
    const a = button.current.getBoundingClientRect(), p = panel.current.getBoundingClientRect()
    setPosition({ left: Math.max(8, Math.min(a.left, window.innerWidth - p.width - 8)), top: a.bottom + p.height + 8 < window.innerHeight ? a.bottom + 6 : Math.max(8, a.top - p.height - 6) })
  }, [open])
  return <>
    <button ref={button} type="button" className="settings-help" aria-label={`${label}说明`} aria-expanded={open} aria-describedby={open ? id : undefined}
      onMouseEnter={() => { cancel(); setOpen(true) }} onMouseLeave={leave}
      onFocus={() => { cancel(); setOpen(true) }} onBlur={event => {
        if (event.relatedTarget && panel.current?.contains(event.relatedTarget as Node)) return
        leave()
      }}
      onClick={() => { cancel(); setOpen(true) }}><CircleHelp size={15} /></button>
    {open && createPortal(<div ref={panel} id={id} role="tooltip" className="settings-help-popover" style={position}
      onPointerDown={cancel} onMouseEnter={cancel} onMouseLeave={leave}>{children}</div>, button.current?.closest('dialog') ?? document.body)}
  </>
}
