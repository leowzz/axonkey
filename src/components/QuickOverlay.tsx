import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import { invoke } from '@tauri-apps/api/core'
import { listen } from '@tauri-apps/api/event'
import { Sparkles, X } from 'lucide-react'
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
import { buildQuickOverlayView, type QuickOverlaySessionPayload } from './quickOverlayModel'
import './QuickOverlay.css'

function detectFallbackPlatform(): Platform {
  if (typeof navigator !== 'undefined' && /mac/i.test(navigator.userAgent)) return 'macos'
  return 'windows'
}

export function QuickOverlay() {
  useSyncExternalStore(subscribeSupportPackages, getSupportPackages, getSupportPackages)
  const [platform, setPlatform] = useState<Platform>(detectFallbackPlatform)
  const [session, setSession] = useState<QuickOverlaySessionPayload | null>(null)
  const [hoveredInputId, setHoveredInputId] = useState<string>('')
  const diagramWrapRef = useRef<HTMLDivElement>(null)
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
    void invoke('reveal_quick_overlay', { revision }).catch(error =>
      logError('Failed to reveal quick overlay', error),
    )
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

  useEffect(() => {
    const root = diagramWrapRef.current
    if (!root || !view) return
    for (const node of root.querySelectorAll('.quick-trigger-key')) {
      node.classList.remove('quick-trigger-key')
    }
    if (view.triggerInputId) {
      const target = Array.from(root.querySelectorAll<HTMLElement | SVGElement>('[data-remote-key]')).find(
        el => el.getAttribute('data-remote-key') === view.triggerInputId,
      )
      target?.classList.add('quick-trigger-key')
    }
  }, [view])

  if (!session || !view) return null

  const activeInputId = hoveredInputId || view.pressedIds[0] || view.items[0]?.inputId || view.triggerInputId

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
          <button
            type="button"
            className="quick-overlay-close"
            aria-label="关闭快捷交互窗"
            onClick={dismiss}
          >
            <X size={15} aria-hidden="true" />
          </button>
        </div>
      </header>

      <div className="quick-overlay-body">
        <div ref={diagramWrapRef} className="quick-overlay-diagram" aria-label="设备按键位置">
          {view.isMouse ? (
            <div className="quick-overlay-mouse-wrap">
              <MouseInputModel
                activeId={(activeInputId || 'mouse.global.buttonMiddle') as InputId}
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

        <div className="quick-overlay-cards" role="list" aria-label="此快捷配置下的按键功能">
          {view.items.length === 0 ? (
            <div className="quick-overlay-empty">
              <p>此快捷配置暂未添加按键功能</p>
              <span>在主窗口选择「{view.profileName}」即可为其他按键配置提示词或快捷行为</span>
            </div>
          ) : (
            view.items.map(item => {
              const glyph = railKeyGlyphText(
                { id: item.inputId, label: item.label, icon: item.icon },
                item.short,
              )
              const isActive = activeInputId === item.inputId
              const isPressed = view.pressedIds.includes(item.inputId)
              const single = item.triggers.length === 1 ? item.triggers[0] : null
              const displayTitle = item.contextLabel ? `${item.contextLabel} · ${item.label}` : item.label

              return (
                <button
                  key={item.inputId}
                  ref={node => {
                    cardRefs.current[item.inputId] = node
                  }}
                  type="button"
                  role="listitem"
                  className={`quick-overlay-card${isActive ? ' is-active' : ''}${isPressed ? ' is-pressed' : ''}`}
                  aria-label={`${displayTitle}：${item.triggers.map(t => `${t.triggerLabel} ${t.text}`).join('；')}`}
                  onMouseEnter={() => setHoveredInputId(item.inputId)}
                  onFocus={() => setHoveredInputId(item.inputId)}
                  onClick={() => triggerCard(item.inputId)}
                >
                  <div className="quick-overlay-card-head">
                    <span className="quick-overlay-keycap" aria-hidden="true">
                      {glyph ? <span>{glyph}</span> : iconFor(item.icon, 14)}
                    </span>
                    <strong className="quick-overlay-key-name">{displayTitle}</strong>
                    {single && (
                      <div className="quick-overlay-card-tags">
                        {single.badge && <span className="quick-overlay-kind-tag">{single.badge}</span>}
                        <span className="quick-overlay-trigger-tag">{single.triggerLabel}</span>
                      </div>
                    )}
                  </div>

                  {single ? (
                    <div className={`quick-overlay-card-detail is-${single.kind}`}>
                      <p className="quick-overlay-detail-text">{single.text}</p>
                      {single.stepsSummary && (
                        <span className="quick-overlay-steps-chain">{single.stepsSummary}</span>
                      )}
                    </div>
                  ) : (
                    <div className="quick-overlay-multi-triggers">
                      {item.triggers.map(entry => (
                        <div key={entry.trigger} className={`quick-overlay-trigger-row is-${entry.kind}`}>
                          <span className="quick-overlay-trigger-tag">{entry.triggerLabel}</span>
                          <div className="quick-overlay-trigger-body">
                            <p className="quick-overlay-detail-text">
                              {entry.badge && entry.kind === 'prompt' ? `[${entry.badge}] ` : ''}
                              {entry.text}
                            </p>
                          </div>
                        </div>
                      ))}
                    </div>
                  )}
                </button>
              )
            })
          )}
        </div>
      </div>
    </aside>
  )
}
