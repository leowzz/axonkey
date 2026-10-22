import { useEffect, useRef } from 'react'
import { X } from 'lucide-react'
import type { MappingInput } from '../appTypes'
import type { TriggerType } from '../behaviorModel'
import { triggerLabels } from '../appConfig'

export function ProfileSwitchDeleteDialog({ button, targets, onCancel, onConfirm }: {
  button: MappingInput
  targets: { trigger: TriggerType; profiles: { id: string; name: string }[] }[]
  onCancel: () => void
  onConfirm: () => void
}) {
  const ref = useRef<HTMLElement>(null)
  useEffect(() => {
    const root = document.getElementById('root')
    const wasInert = root?.inert ?? false
    const previousFocus = document.activeElement
    const overflow = document.body.style.overflow
    if (root) root.inert = true
    document.body.style.overflow = 'hidden'
    ref.current?.querySelector<HTMLButtonElement>('[data-cancel]')?.focus()
    return () => {
      if (root) root.inert = wasInert
      document.body.style.overflow = overflow
      if ((previousFocus instanceof HTMLElement || previousFocus instanceof SVGElement) && previousFocus.isConnected) previousFocus.focus()
      else document.querySelector<HTMLElement>('.workflow-axonkey-canvas')?.focus()
    }
  }, [])

  return <div className="mapping-active">
    <div className="behavior-dialog-backdrop workflow-step-editor" role="presentation" onMouseDown={event => {
      if (event.target === event.currentTarget) onCancel()
    }} onKeyDown={event => {
      event.stopPropagation()
      if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); onCancel() }
      if (event.key !== 'Tab') return
      const buttons = ref.current?.querySelectorAll<HTMLButtonElement>('button')
      const first = buttons?.[0]
      const last = buttons?.[buttons.length - 1]
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus() }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus() }
    }}>
      <section ref={ref} className="behavior-dialog profile-switch-delete-dialog" role="dialog" aria-modal="true" aria-labelledby="profile-switch-delete-title" aria-describedby="profile-switch-delete-description">
        <header className="behavior-dialog-head">
          <h2 id="profile-switch-delete-title">删除切换配置文件行为</h2>
          <button type="button" className="dialog-close" aria-label="取消删除" onClick={onCancel}><X size={17} /></button>
        </header>
        <div className="behavior-dialog-body">
          <section className="profile-switch-overwrites">
            <p id="profile-switch-delete-description">确认删除所选行为？以下配置文件中对应位置的“切换配置文件”行为也会同步删除。</p>
            <ul>{targets.map(({ trigger, profiles }) => <li key={trigger}>
              <strong>{[button.label, button.contextLabel, button.triggerLabel ?? triggerLabels[trigger]].filter(Boolean).join(' · ')}</strong>
              <span>{profiles.map(profile => profile.name).join('、')}</span>
            </li>)}</ul>
          </section>
        </div>
        <footer className="behavior-dialog-actions">
          <div className="behavior-dialog-buttons">
            <button type="button" className="dialog-secondary" data-cancel onClick={onCancel}>取消</button>
            <button type="button" className="button primary" onClick={onConfirm}>确认删除</button>
          </div>
        </footer>
      </section>
    </div>
  </div>
}
