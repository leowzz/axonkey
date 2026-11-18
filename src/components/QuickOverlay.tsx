import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import { invoke } from '@tauri-apps/api/core'
import { listen } from '@tauri-apps/api/event'
import { CornerDownLeft, MousePointerClick, Sparkles, X } from 'lucide-react'
import type { Platform } from '../appTypes'
import type { InputId } from '../behaviorModel'
import {
  activateCatalogDeviceDescriptors,
  applyLocalCustomDevices,
  hydratePreviewLocalCustomDevices,
  readCachedDeviceModelCatalog,
  type LocalCustomDeviceEntry,
} from '../cloud/deviceModelCatalog'
import { getSupportPackages, subscribeSupportPackages } from '../devices/integration/model'
import { railKeyGlyphText } from '../devices/integration/railOverview'
import { RemoteControl } from '../devices/shared/RemoteControl'
import { logError } from '../runtimeLogging'
import { iconFor } from './InputIcon'
import { MouseInputModel } from './MouseMapping'
import {
  buildQuickOverlayView,
  type QuickOverlayCalloutItem,
  type QuickOverlayKeypadSlot,
  type QuickOverlaySessionPayload,
} from './quickOverlayModel'
import './QuickOverlay.css'

type CalloutWire = {
  id: string
  path: string
  x2: number
  y2: number
  isExit: boolean
}

function detectFallbackPlatform(): Platform {
  if (typeof navigator !== 'undefined' && /mac/i.test(navigator.userAgent)) return 'macos'
  return 'windows'
}

function conciseKeyName(item: Pick<QuickOverlayCalloutItem, 'short' | 'label'>): string {
  const raw = (item.short?.trim() || item.label.trim())
    .replace(/（.*?）|\(.*?\)/g, '')
    .replace(/^鼠标/, '')
    .replace(/键$/, '')
    .trim()
  return raw || item.label
}

function renderKeyGlyph(item: Pick<QuickOverlayCalloutItem, 'inputId' | 'label' | 'short' | 'icon'>) {
  const glyph = railKeyGlyphText({ id: item.inputId, label: item.label, icon: item.icon }, item.short)
  if (glyph) return <span>{glyph}</span>
  if (item.inputId.startsWith('mouse.') && item.icon === 'center') {
    return <MousePointerClick size={12} strokeWidth={2} />
  }
  return iconFor(item.icon, 13)
}

export function QuickOverlay() {
  useSyncExternalStore(subscribeSupportPackages, getSupportPackages, getSupportPackages)
  const [platform, setPlatform] = useState<Platform>(detectFallbackPlatform)
  const [session, setSession] = useState<QuickOverlaySessionPayload | null>(null)
  const [hoveredInputId, setHoveredInputId] = useState<string>('')
  const [wires, setWires] = useState<CalloutWire[]>([])

  const stageRef = useRef<HTMLDivElement>(null)
  const diagramWrapRef = useRef<HTMLDivElement>(null)
  const leftColRef = useRef<HTMLDivElement>(null)
  const rightColRef = useRef<HTMLDivElement>(null)
  const cardRefs = useRef<Record<string, HTMLButtonElement | null>>({})

  useEffect(() => {
    try {
      const cached = readCachedDeviceModelCatalog(window.localStorage)
      if (cached?.items?.length) activateCatalogDeviceDescriptors(cached.items)
      hydratePreviewLocalCustomDevices(window.localStorage)
    } catch {
      /* Storage access in overlay is best-effort. */
    }
    void invoke<Platform>('get_platform')
      .then(next => {
        if (next === 'macos' || next === 'windows' || next === 'unsupported') setPlatform(next)
      })
      .catch(() => {})
    void invoke<LocalCustomDeviceEntry[]>('list_local_custom_devices')
      .then(entries => {
        if (Array.isArray(entries) && entries.length > 0) applyLocalCustomDevices(entries)
      })
      .catch(() => {})
  }, [])

  useEffect(() => {
    let active = true
    let unlisten: (() => void) | undefined

    const receive = (next: QuickOverlaySessionPayload | null) => {
      if (!active) return
      if (!next) {
        setSession(null)
        return
      }
      setSession(current => (!current || next.revision >= current.revision ? next : current))
    }

    void listen<QuickOverlaySessionPayload | null>('axonkey-quick-overlay', event => receive(event.payload))
      .then(async cleanup => {
        if (!active) {
          cleanup()
          return
        }
        unlisten = cleanup
        receive(await invoke<QuickOverlaySessionPayload | null>('get_quick_overlay'))
      })
      .catch(error => logError('Failed to subscribe to quick overlay state', error))

    return () => {
      active = false
      unlisten?.()
    }
  }, [])

  const revision = session?.revision ?? 0
  useEffect(() => {
    if (!revision) return
    setHoveredInputId('')
    void invoke('reveal_quick_overlay', { revision }).catch(error => logError('Failed to reveal quick overlay', error))
  }, [revision])

  useEffect(() => {
    if (!revision) return
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault()
        void invoke('dismiss_quick_overlay', { revision }).catch(() => {})
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [revision])

  const view = useMemo(() => (session ? buildQuickOverlayView(session, platform) : null), [session, platform])
  const activeInputId = hoveredInputId || view?.pressedIds[0] || ''

  useEffect(() => {
    const root = diagramWrapRef.current
    if (!root || !view) return
    for (const node of root.querySelectorAll('.quick-trigger-key, .quick-mapped-key, .quick-active-key')) {
      node.classList.remove('quick-trigger-key', 'quick-mapped-key', 'quick-active-key')
    }
    if (view.isMouse) {
      for (const item of [...view.leftCallouts, ...view.rightCallouts]) {
        if (item.target.kind !== 'mouse') continue
        const part = root.querySelector<HTMLElement>(`[data-mouse-control="${item.target.controlId}"]`)
        if (!part) continue
        if (item.isExitTrigger) part.classList.add('quick-trigger-key')
        else part.classList.add('quick-mapped-key')
        if (activeInputId && activeInputId === item.inputId) part.classList.add('quick-active-key')
      }
    } else if (view.triggerInputId) {
      const target = Array.from(root.querySelectorAll<HTMLElement | SVGElement>('[data-remote-key]')).find(
        el => el.getAttribute('data-remote-key') === view.triggerInputId,
      )
      target?.classList.add('quick-trigger-key')
    }
  }, [activeInputId, view])

  const measureWires = useCallback(() => {
    const stage = stageRef.current
    const diagram = diagramWrapRef.current
    if (!stage || !diagram || !view || view.layoutMode !== 'callout') {
      setWires([])
      return
    }
    const stageRect = stage.getBoundingClientRect()
    if (!stageRect.width || !stageRect.height) return

    const allCallouts = [...view.leftCallouts, ...view.rightCallouts]
    const svgEl = diagram.querySelector<SVGSVGElement>('.remote-control')
    const svgRect = svgEl?.getBoundingClientRect()
    const diagramRect = diagram.getBoundingClientRect()

    const nextWires: CalloutWire[] = []
    for (const item of allCallouts) {
      const cardEl = cardRefs.current[item.inputId]
      if (!cardEl) continue
      const cardRect = cardEl.getBoundingClientRect()
      if (cardRect.bottom < stageRect.top + 6 || cardRect.top > stageRect.bottom - 6) continue

      const x1 = (item.side === 'left' ? cardRect.right : cardRect.left) - stageRect.left
      const y1 = cardRect.top + cardRect.height / 2 - stageRect.top

      let x2: number | null = null
      let y2: number | null = null

      if (item.target.kind === 'mouse') {
        const partEl = diagram.querySelector<HTMLElement>(`[data-mouse-control="${item.target.controlId}"]`)
        const partRect = partEl?.getBoundingClientRect()
        if (partRect && partRect.width > 0) {
          x2 =
            (item.side === 'left' ? partRect.left + partRect.width * 0.25 : partRect.right - partRect.width * 0.25) -
            stageRect.left
          y2 = partRect.top + partRect.height / 2 - stageRect.top
        }
      } else if (
        item.target.kind === 'remote' &&
        svgRect &&
        svgRect.width > 0 &&
        svgRect.height > 0 &&
        view.remoteView
      ) {
        const targetId = item.target.id
        const anchor = view.remoteView.keyRegions[targetId]?.anchor
        const { width: vbW, height: vbH } = view.remoteView.viewBox
        const keyEl = Array.from(diagram.querySelectorAll<SVGGraphicsElement>('[data-remote-key]')).find(
          el => el.getAttribute('data-remote-key') === targetId,
        )
        const keyRect = keyEl?.getBoundingClientRect()
        if (anchor && vbW > 0 && vbH > 0) {
          const cx = svgRect.left - stageRect.left + (anchor.x / vbW) * svgRect.width
          const cy = svgRect.top - stageRect.top + (anchor.y / vbH) * svgRect.height
          const pull = keyRect ? Math.min(keyRect.width * 0.3, 10) : 0
          x2 = cx + (item.side === 'left' ? -pull : pull)
          y2 = cy
        } else if (keyRect && keyRect.width > 0) {
          x2 = keyRect.left + keyRect.width / 2 - stageRect.left
          y2 = keyRect.top + keyRect.height / 2 - stageRect.top
        }
      }

      if (x2 === null || y2 === null) continue

      const deviceEdgeX = item.side === 'left' ? diagramRect.left - stageRect.left : diagramRect.right - stageRect.left
      const gap = item.side === 'left' ? deviceEdgeX - x1 : x1 - deviceEdgeX
      const elbowOffset = Math.max(8, Math.min(20, gap * 0.55))
      const elbow = item.side === 'left' ? x1 + elbowOffset : x1 - elbowOffset

      nextWires.push({
        id: item.inputId,
        path: `M ${x1.toFixed(1)} ${y1.toFixed(1)} H ${elbow.toFixed(1)} L ${x2.toFixed(1)} ${y2.toFixed(1)}`,
        x2,
        y2,
        isExit: item.isExitTrigger,
      })
    }

    setWires(nextWires)
  }, [view])

  useLayoutEffect(() => {
    measureWires()
    if (typeof ResizeObserver === 'undefined') return
    const stage = stageRef.current
    const diagram = diagramWrapRef.current
    if (!stage || !diagram) return
    const observer = new ResizeObserver(() => measureWires())
    observer.observe(stage)
    observer.observe(diagram)
    const svgEl = diagram.querySelector('.remote-control')
    if (svgEl) observer.observe(svgEl)
    const leftCol = leftColRef.current
    const rightCol = rightColRef.current
    leftCol?.addEventListener('scroll', measureWires, { passive: true })
    rightCol?.addEventListener('scroll', measureWires, { passive: true })
    return () => {
      observer.disconnect()
      leftCol?.removeEventListener('scroll', measureWires)
      rightCol?.removeEventListener('scroll', measureWires)
    }
  }, [measureWires])

  if (!session || !view) return null

  const dismiss = () => {
    void invoke('dismiss_quick_overlay', { revision: session.revision }).catch(error =>
      logError('Failed to dismiss quick overlay', error),
    )
  }

  const triggerCard = (inputId: string) => {
    void invoke('trigger_quick_overlay_input', {
      revision: session.revision,
      inputId,
    }).catch(error => logError('Failed to trigger quick overlay input', error))
  }

  const handleDiagramSelect = (inputId: string) => {
    if (inputId === view.triggerInputId) {
      dismiss()
      return
    }
    setHoveredInputId(inputId)
    const card = cardRefs.current[inputId]
    if (card) {
      card.scrollIntoView({ block: 'nearest', behavior: 'smooth' })
      card.focus({ preventScroll: true })
    }
  }

  const renderCalloutCard = (item: QuickOverlayCalloutItem) => {
    const isActive = activeInputId === item.inputId
    const isPressed = view.pressedIds.includes(item.inputId)
    const single = item.triggers.length === 1 ? item.triggers[0] : null
    const shortName = conciseKeyName(item)
    const fullTitle = item.contextLabel ? `${item.contextLabel} · ${item.label}` : item.label

    const keyBadge = (
      <span className={`quick-callout-key-pill${item.isExitTrigger ? ' is-exit' : ''}`} title={fullTitle}>
        <span className="quick-callout-key-icon" aria-hidden="true">
          {renderKeyGlyph(item)}
        </span>
        <span className="quick-callout-key-label">{shortName}</span>
      </span>
    )

    if (item.isExitTrigger) {
      return (
        <button
          key={`exit-${item.inputId}`}
          ref={node => {
            cardRefs.current[item.inputId] = node
          }}
          type="button"
          role="listitem"
          className={`quick-callout-card side-${item.side} is-exit-card${isActive ? ' is-active' : ''}`}
          aria-label={`${fullTitle}：再按退出快捷交互`}
          onMouseEnter={() => setHoveredInputId(item.inputId)}
          onMouseLeave={() => setHoveredInputId('')}
          onFocus={() => setHoveredInputId(item.inputId)}
          onBlur={() => setHoveredInputId('')}
          onClick={dismiss}
        >
          <div className="quick-callout-content">
            <span className="quick-callout-exit-text">
              <CornerDownLeft size={13} aria-hidden="true" />
              再按退出
            </span>
          </div>
          {keyBadge}
        </button>
      )
    }

    return (
      <button
        key={item.inputId}
        ref={node => {
          cardRefs.current[item.inputId] = node
        }}
        type="button"
        role="listitem"
        title={single?.kind === 'prompt' ? single.text : undefined}
        className={`quick-callout-card side-${item.side}${isActive ? ' is-active' : ''}${isPressed ? ' is-pressed' : ''}`}
        aria-label={`${fullTitle}：${item.triggers.map(t => `${t.triggerLabel} ${t.text}`).join('；')}`}
        onMouseEnter={() => setHoveredInputId(item.inputId)}
        onMouseLeave={() => setHoveredInputId('')}
        onFocus={() => setHoveredInputId(item.inputId)}
        onBlur={() => setHoveredInputId('')}
        onClick={() => triggerCard(item.inputId)}
      >
        <div className="quick-callout-content">
          {single ? (
            <div className={`quick-callout-single is-${single.kind}`}>
              {(item.contextLabel || single.showTriggerTag || single.badge) && (
                <div className="quick-callout-meta-row">
                  {item.contextLabel && (
                    <span className="quick-callout-scope-tag">
                      {single.showTriggerTag ? `${item.contextLabel} · ${single.triggerLabel}` : item.contextLabel}
                    </span>
                  )}
                  {!item.contextLabel && single.showTriggerTag && (
                    <span className="quick-overlay-trigger-tag">{single.triggerLabel}</span>
                  )}
                  {single.badge && <span className="quick-overlay-kind-tag">{single.badge}</span>}
                </div>
              )}
              <strong className="quick-callout-primary-text">{single.text}</strong>
              {single.stepsSummary && <span className="quick-overlay-steps-chain">{single.stepsSummary}</span>}
            </div>
          ) : (
            <div className="quick-overlay-multi-triggers">
              {item.contextLabel && <span className="quick-callout-scope-tag">{item.contextLabel}</span>}
              {item.triggers.map(entry => (
                <div key={entry.trigger} className={`quick-overlay-trigger-row is-${entry.kind}`}>
                  <span className="quick-overlay-trigger-tag">{entry.triggerLabel}</span>
                  <strong className="quick-callout-primary-text">
                    {entry.badge && entry.kind === 'prompt' ? `${entry.badge} · ` : ''}
                    {entry.text}
                  </strong>
                </div>
              ))}
            </div>
          )}
        </div>
        {keyBadge}
      </button>
    )
  }

  const renderKeypadSlot = (slot: QuickOverlayKeypadSlot) => {
    const isPressed = view.pressedIds.includes(slot.inputId)
    const isActive = activeInputId === slot.inputId
    const single = slot.triggers.length === 1 ? slot.triggers[0] : null

    if (slot.status === 'idle') {
      return (
        <div
          key={slot.inputId}
          className="quick-keypad-cap is-idle"
          style={{ gridColumn: slot.col, gridRow: slot.row }}
          aria-hidden="true"
        >
          <span className="quick-keypad-code">{slot.short}</span>
        </div>
      )
    }

    if (slot.status === 'trigger') {
      return (
        <button
          key={slot.inputId}
          type="button"
          className={`quick-keypad-cap is-trigger${isActive ? ' is-active' : ''}`}
          style={{ gridColumn: slot.col, gridRow: slot.row }}
          aria-label={`${slot.label}：再按退出`}
          onClick={dismiss}
        >
          <div className="quick-keypad-top">
            <span className="quick-keypad-code">{slot.short}</span>
            <span className="quick-keypad-exit-pill">退出键</span>
          </div>
          <strong className="quick-keypad-action">再按退出</strong>
        </button>
      )
    }

    return (
      <button
        key={slot.inputId}
        type="button"
        title={single?.kind === 'prompt' ? single.text : undefined}
        className={`quick-keypad-cap is-configured${isActive ? ' is-active' : ''}${isPressed ? ' is-pressed' : ''}`}
        style={{ gridColumn: slot.col, gridRow: slot.row }}
        aria-label={`${slot.label}：${slot.triggers.map(t => `${t.triggerLabel} ${t.text}`).join('；')}`}
        onMouseEnter={() => setHoveredInputId(slot.inputId)}
        onMouseLeave={() => setHoveredInputId('')}
        onFocus={() => setHoveredInputId(slot.inputId)}
        onBlur={() => setHoveredInputId('')}
        onClick={() => triggerCard(slot.inputId)}
      >
        <div className="quick-keypad-top">
          <span className="quick-keypad-code">{slot.short}</span>
          {single?.badge && <span className="quick-overlay-kind-tag">{single.badge}</span>}
          {single?.showTriggerTag && <span className="quick-overlay-trigger-tag">{single.triggerLabel}</span>}
        </div>
        {single ? (
          <strong className={`quick-keypad-action is-${single.kind}`}>{single.text}</strong>
        ) : (
          <div className="quick-keypad-multi">
            {slot.triggers.map(entry => (
              <div key={entry.trigger} className="quick-keypad-multi-row">
                <span>{entry.triggerLabel}</span>
                <strong>{entry.text}</strong>
              </div>
            ))}
          </div>
        )}
      </button>
    )
  }

  return (
    <aside className="quick-overlay-shell" role="dialog" aria-label={`快捷交互窗 · ${view.profileName}`}>
      <header className="quick-overlay-header">
        <div className="quick-overlay-identity">
          <span className={`quick-overlay-mode-pill${session.preview ? ' is-preview' : ''}`}>
            <Sparkles size={13} aria-hidden="true" />
            <span>{session.preview ? '预览' : '快捷交互'}</span>
          </span>
          <strong className="quick-overlay-profile-name">{view.profileName}</strong>
          <span className="quick-overlay-device-name">{view.deviceName}</span>
        </div>
        <div className="quick-overlay-actions">
          {view.triggerLabel ? (
            <span className="quick-overlay-exit-hint">
              再按 <kbd>{view.triggerLabel}</kbd> 退出
            </span>
          ) : (
            <span className="quick-overlay-exit-hint">按配置键执行后退出</span>
          )}
          <button type="button" className="quick-overlay-close" aria-label="关闭快捷交互窗" onClick={dismiss}>
            <X size={15} aria-hidden="true" />
          </button>
        </div>
      </header>

      {view.items.length === 0 ? (
        <div className="quick-overlay-empty">
          <p>此快捷配置暂未添加按键功能</p>
          <span>在主窗口选择「{view.profileName}」即可为按键配置提示词或快捷行为</span>
        </div>
      ) : view.layoutMode === 'keypad' ? (
        <div className="quick-keypad-deck" role="group" aria-label="小键盘物理键位映射">
          <div className="quick-keypad-oled" aria-hidden="true">
            <span className="quick-keypad-oled-eyebrow">{view.deviceName}</span>
            <strong>{view.profileName}</strong>
            <span>{view.items.length} 个按键已就绪 · 按一次即执行</span>
          </div>
          {view.keypadSlots.map(renderKeypadSlot)}
        </div>
      ) : (
        <div ref={stageRef} className={`quick-overlay-callout-stage${view.isWideDiagram ? ' is-wide-device' : ''}`}>
          <svg className="quick-overlay-wires" aria-hidden="true">
            {wires.map(wire => {
              const highlighted = activeInputId === wire.id || view.pressedIds.includes(wire.id)
              const pressed = view.pressedIds.includes(wire.id)
              return (
                <g
                  key={wire.id}
                  className={`quick-overlay-wire${wire.isExit ? ' is-exit' : ''}${highlighted ? ' is-active' : ''}${pressed ? ' is-pressed' : ''}`}
                >
                  <path d={wire.path} />
                  <circle cx={wire.x2} cy={wire.y2} r={highlighted ? 3.8 : 2.8} />
                </g>
              )
            })}
          </svg>

          <div ref={leftColRef} className="quick-callout-column side-left" role="list" aria-label="左侧按键功能标注">
            {view.leftCallouts.map(renderCalloutCard)}
          </div>

          <div ref={diagramWrapRef} className="quick-overlay-center-device" aria-label="设备按键位置">
            {view.isMouse ? (
              <div className="quick-overlay-mouse-wrap">
                <MouseInputModel
                  activeId={(activeInputId || view.items[0]?.inputId || 'mouse.global.buttonMiddle') as InputId}
                  onSelect={id => handleDiagramSelect(id)}
                />
              </div>
            ) : (
              <div className="quick-overlay-remote-wrap">
                <RemoteControl
                  activeId={activeInputId}
                  pressedIds={view.pressedIds}
                  mappedIds={view.mappedIds}
                  onSelect={handleDiagramSelect}
                  remoteView={view.remoteView}
                  screenRegion={view.screenRegion}
                />
              </div>
            )}
          </div>

          <div ref={rightColRef} className="quick-callout-column side-right" role="list" aria-label="右侧按键功能标注">
            {view.rightCallouts.map(renderCalloutCard)}
          </div>
        </div>
      )}
    </aside>
  )
}
