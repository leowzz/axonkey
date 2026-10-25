import { useEffect, useId, useMemo, useRef } from 'react'
import artwork from './xbox-controller-keymap.svg?raw'
import { xboxInputs } from '../integration/model'

export function ControllerDiagram({ selected, pressed, mapped, onSelect }: { selected: string; pressed: readonly string[]; mapped: readonly string[]; onSelect: (id: string) => void }) {
  const ref = useRef<HTMLDivElement>(null)
  const unique = useId().replace(/:/g, '')
  // Bundled, trusted SVG only; instance-scoped IDs avoid collisions in multiple workspaces.
  const svg = useMemo(() => artwork.replace(/xbox-keymap-/g, `${unique}-`).replace('role="img"', 'role="group"'), [unique])
  useEffect(() => {
    for (const key of ref.current?.querySelectorAll<SVGGElement>('[data-key]') ?? []) {
      const id = `xbox.${key.dataset.key}`
      const available = xboxInputs.some(input => input.id === id)
      key.setAttribute('role', 'button')
      key.setAttribute('tabindex', available ? '0' : '-1')
      key.setAttribute('aria-pressed', String(id === selected))
      key.classList.toggle('selected', id === selected)
      key.classList.toggle('pressed', pressed.includes(id))
      key.classList.toggle('mapped', mapped.includes(id))
    }
  }, [selected, pressed, mapped])
  function select(target: EventTarget | null) {
    const key = target instanceof Element ? target.closest<SVGGElement>('[data-key]') : null
    const id = `xbox.${key?.dataset.key}`
    if (xboxInputs.some(input => input.id === id)) onSelect(id)
  }
  return <div ref={ref} className="managed-controller-diagram" onClick={event => select(event.target)} onKeyDown={event => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); select(event.target) } }} dangerouslySetInnerHTML={{ __html: svg }} />
}
