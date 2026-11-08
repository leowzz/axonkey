import type { SelectHTMLAttributes } from 'react'
import { ChevronDown } from 'lucide-react'

export function SelectControl({
  containerClassName = '',
  children,
  ...props
}: SelectHTMLAttributes<HTMLSelectElement> & { containerClassName?: string }) {
  return (
    <span className={`manual-key-select select-control ${containerClassName}`}>
      <select {...props}>{children}</select>
      <span className="manual-key-select-icon" aria-hidden="true">
        <ChevronDown size={14} />
      </span>
    </span>
  )
}
