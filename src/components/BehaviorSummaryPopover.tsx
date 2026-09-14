import { cloneElement, useEffect, useId, useLayoutEffect, useRef, useState } from 'react'
import type { HTMLAttributes, ReactElement } from 'react'
import { createPortal } from 'react-dom'
import { behaviorSummary } from '../appConfig'
import type { Behavior } from '../behaviorModel'
import type { Platform } from '../appTypes'

type Props = {
  label: string
  groups: { label: string; behaviors: Behavior[] }[]
  platform: Platform
  openDelay?: number
  children: ReactElement<HTMLAttributes<HTMLElement>>
}

/** Portal keeps the sequence readable outside the workbench scroll containers. */
export function BehaviorSummaryPopover({ label, groups, platform, children, openDelay = 0 }: Props) {
  const id = useId()
  const [anchor, setAnchor] = useState<HTMLElement | null>(null)
  const [position, setPosition] = useState({ left: 0, top: 0 })
  const panelRef = useRef<HTMLDivElement>(null)
  const timerRef = useRef<ReturnType<typeof setTimeout>>()
  const openTimerRef = useRef<ReturnType<typeof setTimeout>>()
  const available = groups.some((group) => group.behaviors.length > 0)
  const cancelClose = () => clearTimeout(timerRef.current)
  const cancelOpen = () => clearTimeout(openTimerRef.current)
  const close = () => { cancelOpen(); cancelClose(); setAnchor(null) }
  const scheduleClose = () => { cancelOpen(); cancelClose(); timerRef.current = setTimeout(() => setAnchor(null), 120) }
  const open = (element: HTMLElement) => {
    cancelOpen()
    cancelClose()
    if (!available) return
    if (openDelay === 0) setAnchor(element)
    else openTimerRef.current = setTimeout(() => setAnchor(element), openDelay)
  }

  useEffect(() => () => {
    clearTimeout(timerRef.current)
    clearTimeout(openTimerRef.current)
  }, [])
  useEffect(() => {
    const dismiss = (event: Event) => {
      if (event.type === 'scroll' && event.target instanceof Node && panelRef.current?.contains(event.target)) return
      clearTimeout(openTimerRef.current)
      clearTimeout(timerRef.current)
      setAnchor(null)
    }
    const keydown = (event: KeyboardEvent) => { if (event.key === 'Escape') dismiss(event) }
    window.addEventListener('resize', dismiss)
    window.addEventListener('scroll', dismiss, true)
    window.addEventListener('keydown', keydown)
    return () => {
      window.removeEventListener('resize', dismiss)
      window.removeEventListener('scroll', dismiss, true)
      window.removeEventListener('keydown', keydown)
    }
  }, [])

  useLayoutEffect(() => {
    if (!anchor || !panelRef.current) return
    const rect = anchor.getBoundingClientRect()
    const panel = panelRef.current.getBoundingClientRect()
    setPosition({
      left: Math.max(8, Math.min(rect.left, window.innerWidth - panel.width - 8)),
      top: rect.bottom + 8 + panel.height <= window.innerHeight - 8
        ? rect.bottom + 8 : Math.max(8, rect.top - panel.height - 8),
    })
  }, [anchor, groups])

  return <>{cloneElement(children, {
    'aria-describedby': anchor ? [children.props['aria-describedby'], id].filter(Boolean).join(' ') : children.props['aria-describedby'],
    onMouseEnter: (event) => { children.props.onMouseEnter?.(event); open(event.currentTarget) },
    onMouseLeave: (event) => { children.props.onMouseLeave?.(event); scheduleClose() },
    onFocus: (event) => { children.props.onFocus?.(event); open(event.currentTarget) },
    onBlur: (event) => { children.props.onBlur?.(event); scheduleClose() },
    onClick: (event) => { close(); children.props.onClick?.(event) },
  })}{anchor && available && createPortal(<div ref={panelRef} id={id} role="tooltip" className="behavior-summary-popover" style={position} onMouseEnter={cancelClose} onMouseLeave={scheduleClose}>
    <strong className="behavior-summary-heading">{label}</strong>
    {groups.filter((group) => group.behaviors.length > 0).map((group) => <section key={group.label}>
      <h4>{group.label}</h4>
      <ol>{group.behaviors.map((behavior) => <li key={behavior.id} className={behavior.enabled ? '' : 'paused'}><span>{behavior.type === 'paste' ? `粘贴：${behavior.text || '（空文本）'}` : behaviorSummary(behavior, platform)}{!behavior.enabled && <small>（已停用）</small>}</span></li>)}</ol>
    </section>)}
  </div>, document.body)}</>
}
