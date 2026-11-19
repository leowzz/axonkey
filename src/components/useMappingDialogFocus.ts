import { useEffect, useRef } from 'react'
import type { KeyboardEvent, RefObject } from 'react'

export function useMappingDialogFocus(ref: RefObject<HTMLElement>, enabled = true, fallbackSelector?: string) {
  // Capture before React commits autoFocus fields inside the dialog.
  const origin = useRef(document.activeElement)
  useEffect(() => {
    if (!enabled) return
    const root = document.getElementById('root')
    const wasInert = root?.inert ?? false
    const overflow = document.body.style.overflow
    const previousFocus = origin.current
    if (root) root.inert = true
    document.body.style.overflow = 'hidden'
    if (!ref.current?.contains(document.activeElement)) ref.current?.querySelector<HTMLElement>('button')?.focus()
    return () => {
      if (root) root.inert = wasInert
      document.body.style.overflow = overflow
      if ((previousFocus instanceof HTMLElement || previousFocus instanceof SVGElement) && previousFocus.isConnected)
        previousFocus.focus()
      else if (fallbackSelector) document.querySelector<HTMLElement>(fallbackSelector)?.focus()
    }
  }, [enabled, fallbackSelector, ref])

  return (event: KeyboardEvent<HTMLElement>) => {
    if (!enabled || event.key !== 'Tab') return
    const elements = Array.from(
      ref.current?.querySelectorAll<HTMLElement>(
        'button:not(:disabled), input:not(:disabled), textarea:not(:disabled), select:not(:disabled), summary, [tabindex="0"]',
      ) ?? [],
    ).filter(element => element.getClientRects().length > 0)
    const first = elements[0]
    const last = elements[elements.length - 1]
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault()
      last?.focus()
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault()
      first?.focus()
    }
  }
}
