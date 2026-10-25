import { useEffect, useId, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { Bluetooth, Check, ChevronDown, Clock3, Usb } from 'lucide-react'
import type { DiscoveredDevice } from './model'
import './IntegrationControls.css'

type BindingOption = { value: string; name: string; detail: string; status?: string; unavailable?: boolean; offline?: boolean; bluetooth?: boolean }

export function DeviceBindingPicker({ labelledBy, value, devices, onChange }: {
  labelledBy: string; value: string; devices: readonly DiscoveredDevice[]; onChange: (value: string) => void
}) {
  const id = useId()
  const trigger = useRef<HTMLButtonElement>(null)
  const menu = useRef<HTMLDivElement>(null)
  const [open, setOpen] = useState(false)
  const [active, setActive] = useState(value)
  const [position, setPosition] = useState({ left: 0, top: 0, width: 0, maxHeight: 240 })
  const options: BindingOption[] = devices.map(device => ({
    value: device.id, name: device.name,
    detail: `${device.transport === 'Bluetooth' ? '蓝牙' : device.transport} · ${device.id.slice(-6)}`,
    bluetooth: device.transport === 'Bluetooth',
    status: device.identityQuality === 'ambiguous' ? '标识冲突' : device.connected ? '已连接' : '未连接',
    unavailable: device.identityQuality === 'ambiguous',
    offline: !device.connected,
  }))
  if (value && !options.some(option => option.value === value)) {
    options.unshift({ value, name: '原绑定设备', detail: value.slice(-6), status: '未连接', unavailable: true, offline: true })
  }
  options.push({ value: '', name: '稍后绑定', detail: '' })
  const selected = options.find(option => option.value === value)!
  const activeIndex = Math.max(0, options.findIndex(option => option.value === active))

  useLayoutEffect(() => {
    if (!open || !trigger.current) return
    const rect = trigger.current.getBoundingClientRect()
    const below = window.innerHeight - rect.bottom - 14
    const above = rect.top - 14
    const height = Math.min(260, options.length * 62 + 12)
    const upward = below < height && above > below
    const maxHeight = Math.min(height, upward ? above : below)
    setPosition({ left: rect.left, top: upward ? rect.top - maxHeight - 6 : rect.bottom + 6, width: rect.width, maxHeight })
  }, [open, options.length])

  useEffect(() => {
    if (!open) return
    const outside = (event: Event) => {
      const target = event.target as Node
      if (!trigger.current?.contains(target) && !menu.current?.contains(target)) setOpen(false)
    }
    const scroll = (event: Event) => { if (!menu.current?.contains(event.target as Node)) setOpen(false) }
    const resize = () => setOpen(false)
    document.addEventListener('pointerdown', outside)
    document.addEventListener('focusin', outside)
    window.addEventListener('scroll', scroll, true)
    window.addEventListener('resize', resize)
    return () => {
      document.removeEventListener('pointerdown', outside)
      document.removeEventListener('focusin', outside)
      window.removeEventListener('scroll', scroll, true)
      window.removeEventListener('resize', resize)
    }
  }, [open])

  useEffect(() => {
    if (open) menu.current?.children[activeIndex]?.scrollIntoView({ block: 'nearest' })
  }, [open, activeIndex])

  const choose = (option: BindingOption) => {
    if (option.unavailable) return
    onChange(option.value)
    setOpen(false)
  }
  const icon = (option: BindingOption) => !option.value ? <Clock3 size={17} /> : option.bluetooth ? <Bluetooth size={17} /> : <Usb size={17} />
  return <>
    <button ref={trigger} type="button" className="device-binding-trigger" role="combobox" aria-labelledby={labelledBy}
      aria-expanded={open} aria-haspopup="listbox" aria-controls={open ? id : undefined}
      aria-activedescendant={open ? `${id}-${activeIndex}` : undefined}
      onClick={() => { setActive(value); setOpen(!open) }}
      onKeyDown={event => {
        if (event.key === 'Escape' && open) { event.preventDefault(); event.stopPropagation(); setOpen(false); return }
        if (event.key === 'Tab') { setOpen(false); return }
        if (event.key === 'ArrowDown' || event.key === 'ArrowUp' || event.key === 'Home' || event.key === 'End') {
          event.preventDefault()
          const index = event.key === 'Home' ? 0 : event.key === 'End' ? options.length - 1 : !open ? Math.max(0, options.findIndex(option => option.value === value)) : (activeIndex + (event.key === 'ArrowDown' ? 1 : -1) + options.length) % options.length
          setActive(options[index].value); setOpen(true)
        } else if ((event.key === 'Enter' || event.key === ' ') && open) {
          event.preventDefault(); choose(options[activeIndex])
        }
      }}>
      <span className="device-binding-icon">{icon(selected)}</span>
      <span className="device-binding-copy"><strong>{selected.name}</strong>{selected.detail && <small>{selected.detail}</small>}</span>
      {selected.status && <span className={`device-binding-status${selected.unavailable ? ' is-unavailable' : selected.offline ? ' is-offline' : ''}`}><i />{selected.status}</span>}
      <ChevronDown size={15} className={open ? 'is-open' : ''} />
    </button>
    {open && createPortal(<div ref={menu} id={id} role="listbox" aria-labelledby={labelledBy} className="device-binding-menu" style={position}>
      {options.map((option, index) => <div key={option.value} id={`${id}-${index}`} role="option" aria-selected={value === option.value} aria-disabled={option.unavailable || undefined}
        className={`device-binding-option${index === activeIndex ? ' is-active' : ''}${!option.value ? ' is-later' : ''}`}
        onMouseDown={event => event.preventDefault()} onMouseMove={() => setActive(option.value)} onClick={() => choose(option)}>
        <span className="device-binding-icon">{icon(option)}</span>
        <span className="device-binding-copy"><strong>{option.name}</strong>{option.detail && <small>{option.detail}</small>}</span>
        {(option.unavailable || option.offline) && <small className="device-binding-unavailable">{option.status}</small>}
        {option.value === value && <Check size={15} className="device-binding-check" />}
      </div>)}
    </div>, document.body)}
  </>
}

export function InputModePicker({ labelledBy, value, exclusive, onChange }: {
  labelledBy: string; value: 'shared' | 'exclusive'; exclusive: boolean; onChange: (value: 'shared' | 'exclusive') => void
}) {
  const name = useId()
  const modes = [{ value: 'shared' as const, label: '共享监听', detail: '保留原始输入' }, ...(exclusive ? [{ value: 'exclusive' as const, label: '独占拦截', detail: '拦截整个设备' }] : [])]
  return <fieldset className="integration-mode-picker" aria-labelledby={labelledBy}>
    {modes.map(mode => <label key={mode.value} className="integration-mode-option">
      <input type="radio" name={name} value={mode.value} checked={value === mode.value} onChange={() => onChange(mode.value)} />
      <span className="integration-mode-copy"><span><strong>{mode.label}</strong><Check size={14} aria-hidden="true" /></span><small>{mode.detail}</small></span>
    </label>)}
  </fieldset>
}
