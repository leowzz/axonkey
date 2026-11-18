import { useEffect, useMemo, useState, useSyncExternalStore } from 'react'
import { invoke } from '@tauri-apps/api/core'
import { listen } from '@tauri-apps/api/event'
import { CornerDownLeft, MousePointerClick, Sparkles, X } from 'lucide-react'
import type { Platform } from '../appTypes'
import {
  activateCatalogDeviceDescriptors,
  applyLocalCustomDevices,
  clearDeviceModelCatalogCache,
  hydratePreviewLocalCustomDevices,
  readCachedDeviceModelCatalog,
  type LocalCustomDeviceEntry,
} from '../cloud/deviceModelCatalog'
import { getSupportPackages, subscribeSupportPackages } from '../devices/integration/model'
import { railKeyGlyphText } from '../devices/integration/railOverview'
import { logError } from '../runtimeLogging'
import { iconFor } from './InputIcon'
import {
  buildQuickOverlayView,
  type QuickOverlayKeySlot,
  type QuickOverlayScopedEntry,
  type QuickOverlaySessionPayload,
  type QuickOverlaySurfaceBlock,
  type QuickOverlayTriggerPreview,
} from './quickOverlayModel'
import './QuickOverlay.css'

function detectFallbackPlatform(): Platform {
  if (typeof navigator !== 'undefined' && /mac/i.test(navigator.userAgent)) return 'macos'
  return 'windows'
}

function renderKeyGlyph(slot: Pick<QuickOverlayKeySlot, 'inputId' | 'label' | 'short' | 'icon'>) {
  const glyph = railKeyGlyphText({ id: slot.inputId, label: slot.label, icon: slot.icon }, slot.short)
  if (glyph) {
    // Skip duplicate badge text when it matches short verbatim (e.g. K01, Y, X, A, B, 侧上).
    if (glyph === slot.short) return null
    return <span className="ceramic-key-glyph-text">{glyph}</span>
  }
  if (slot.inputId.startsWith('mouse.') && slot.icon === 'center') {
    return <MousePointerClick size={12} strokeWidth={2.1} />
  }
  return iconFor(slot.icon, 12)
}

function conciseSlotShort(slot: Pick<QuickOverlayKeySlot, 'short' | 'label'>): string {
  const raw = (slot.short?.trim() || slot.label.trim()).replace(/（.*?）|\(.*?\)/g, '').trim()
  const dpadDir: Record<string, string> = { UP: '上', DOWN: '下', LEFT: '左', RIGHT: '右' }
  const dpadMatch = raw.match(/^DPAD\.(UP|DOWN|LEFT|RIGHT)$/i)
  if (dpadMatch) return `十字${dpadDir[dpadMatch[1].toUpperCase()]}`
  const stickMatch = raw.match(/^(LS|RS)\.(UP|DOWN|LEFT|RIGHT)$/i)
  if (stickMatch) return `${stickMatch[1].toUpperCase()}${dpadDir[stickMatch[2].toUpperCase()]}`
  const mouseTrimmed = raw.replace(/^鼠标/, '').trim()
  if (/^(左键|右键|中键|侧键)$/.test(mouseTrimmed)) return mouseTrimmed
  return mouseTrimmed.replace(/键$/, '').trim() || slot.short || slot.label
}

function slotKindClass(kind?: 'prompt' | 'action' | 'sequence'): string {
  if (!kind) return ''
  return ` kind-${kind}`
}

function formatScopedMetaLabel(entry: QuickOverlayScopedEntry): string {
  const scopePrefix = entry.contextLabel ? `${entry.contextLabel} · ` : ''
  if (entry.isExitTrigger) return `${scopePrefix}退出键`
  const primary = entry.triggers[0]
  return `${scopePrefix}${primary?.badge || primary?.triggerLabel || '动作'}`
}

function slotDetailCandidate(slot: QuickOverlayKeySlot): {
  title: string
  badge: string
  body: string
  steps?: string
} | null {
  if (slot.status !== 'configured') return null
  if (slot.scopedEntries && slot.scopedEntries.length > 1) {
    return {
      title: slot.label,
      badge: `${slot.scopedEntries.length} 个作用域`,
      body: slot.scopedEntries
        .map(entry => {
          const scope = entry.contextLabel ?? '全局'
          if (entry.isExitTrigger) return `${scope}：再按退出`
          return `${scope}：${entry.triggers.map(t => t.text).join(' / ')}`
        })
        .join('  ·  '),
    }
  }
  if (slot.triggers.length > 1) {
    return {
      title: slot.contextLabel ? `${slot.contextLabel} · ${slot.label}` : slot.label,
      badge: `${slot.triggers.length} 组触发`,
      body: slot.triggers.map(t => `${t.triggerLabel}：${t.text}`).join('  |  '),
    }
  }
  const single = slot.triggers[0]
  if (!single) return null
  if (single.kind === 'prompt' || single.stepsSummary || single.text.length > 16) {
    return {
      title: slot.contextLabel ? `${slot.contextLabel} · ${slot.label}` : slot.label,
      badge: single.badge || single.triggerLabel,
      body: single.text,
      steps: single.stepsSummary,
    }
  }
  return null
}

function collectAllSlots(surface: ReturnType<typeof buildQuickOverlayView>['surface']): QuickOverlayKeySlot[] {
  if (surface.variant === 'matrix') return surface.cells
  if (surface.variant === 'mouse') {
    const out: QuickOverlayKeySlot[] = [...surface.thumbStack, ...surface.primaryPair]
    for (const key of ['up', 'left', 'center', 'right', 'down'] as const) {
      const slot = surface.wheelWell[key]
      if (slot) out.push(slot)
    }
    return out
  }
  const flattenBlocks = (blocks: readonly QuickOverlaySurfaceBlock[]): QuickOverlayKeySlot[] => {
    const res: QuickOverlayKeySlot[] = []
    for (const block of blocks) {
      if (block.kind === 'row') {
        res.push(...block.slots)
      } else if (block.kind === 'cross') {
        for (const key of ['up', 'left', 'center', 'right', 'down'] as const) {
          if (block[key]) res.push(block[key]!)
        }
      } else {
        res.push(...block.leftStack, block.center, ...block.rightStack)
      }
    }
    return res
  }
  if (surface.variant === 'controller') {
    return [
      ...surface.leftShoulders,
      ...surface.rightShoulders,
      ...surface.centerRow,
      ...flattenBlocks(surface.leftPod),
      ...flattenBlocks(surface.rightPod),
    ]
  }
  return [...flattenBlocks(surface.blocks), ...(surface.sideRail?.slots ?? [])]
}

export function QuickOverlay() {
  useSyncExternalStore(subscribeSupportPackages, getSupportPackages, getSupportPackages)
  const [platform, setPlatform] = useState<Platform>(detectFallbackPlatform)
  const [session, setSession] = useState<QuickOverlaySessionPayload | null>(null)
  const [hoveredSlotId, setHoveredSlotId] = useState<string>('')

  useEffect(() => {
    const hydrateCatalog = () => {
      try {
        const cached = readCachedDeviceModelCatalog(window.localStorage)
        if (cached?.items?.length) activateCatalogDeviceDescriptors(cached.items)
        hydratePreviewLocalCustomDevices(window.localStorage)
      } catch {
        /* Storage access in overlay is best-effort. */
      }
    }
    hydrateCatalog()

    const onStorage = (event: StorageEvent) => {
      if (!event.key || event.key.startsWith('axonkey.device-model-catalog')) {
        clearDeviceModelCatalogCache()
        hydrateCatalog()
      }
    }
    window.addEventListener('storage', onStorage)

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

    return () => {
      window.removeEventListener('storage', onStorage)
    }
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
    setHoveredSlotId('')
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

  const { defaultDetailSlot, slotLookup } = useMemo(() => {
    if (!view) {
      return {
        defaultDetailSlot: null as QuickOverlayKeySlot | null,
        slotLookup: new Map<string, QuickOverlayKeySlot>(),
      }
    }
    const allSlots = collectAllSlots(view.surface)
    const map = new Map<string, QuickOverlayKeySlot>()
    let firstDetail: QuickOverlayKeySlot | null = null
    for (const slot of allSlots) {
      map.set(slot.slotId, slot)
      if (!firstDetail && slotDetailCandidate(slot)) firstDetail = slot
    }
    return { defaultDetailSlot: firstDetail, slotLookup: map }
  }, [view])

  if (!session || !view) return null

  const dismiss = () => {
    void invoke('dismiss_quick_overlay', { revision: session.revision }).catch(error =>
      logError('Failed to dismiss quick overlay', error),
    )
  }

  const triggerInput = (inputId: string) => {
    void invoke('trigger_quick_overlay_input', {
      revision: session.revision,
      inputId,
    }).catch(error => logError('Failed to trigger quick overlay input', error))
  }

  const hoveredSlot = hoveredSlotId ? slotLookup.get(hoveredSlotId) : undefined
  const activeDetail =
    (hoveredSlot && slotDetailCandidate(hoveredSlot)) ||
    (defaultDetailSlot && slotDetailCandidate(defaultDetailSlot)) ||
    null

  const renderSingleTriggerBody = (single: QuickOverlayTriggerPreview, contextLabel?: string) => (
    <div className="ceramic-key-single">
      {contextLabel && <span className="ceramic-key-scope-line">{contextLabel}</span>}
      <strong className={`ceramic-key-label is-${single.kind}`}>{single.text}</strong>
      {single.stepsSummary && <span className="ceramic-key-steps">{single.stepsSummary}</span>}
    </div>
  )

  const renderKeySlot = (slot: QuickOverlayKeySlot, extraClass = '', inlineStyle?: React.CSSProperties) => {
    const isPressed =
      view.pressedIds.includes(slot.inputId) ||
      Boolean(slot.scopedEntries?.some(entry => view.pressedIds.includes(entry.inputId)))
    const isActive = hoveredSlotId === slot.slotId
    const shortText = conciseSlotShort(slot)
    const glyphEl = renderKeyGlyph(slot)

    if (slot.status === 'idle') {
      return (
        <div
          key={slot.slotId}
          className={`ceramic-key is-idle${extraClass ? ` ${extraClass}` : ''}`}
          style={inlineStyle}
          aria-hidden="true"
        >
          {glyphEl && <span className="ceramic-key-idle-glyph">{glyphEl}</span>}
          <span className="ceramic-key-idle-code">{shortText}</span>
        </div>
      )
    }

    if (slot.status === 'trigger' && !slot.scopedEntries) {
      return (
        <button
          key={slot.slotId}
          type="button"
          className={`ceramic-key is-trigger${isActive ? ' is-active' : ''}${extraClass ? ` ${extraClass}` : ''}`}
          style={inlineStyle}
          aria-label={`${slot.label}：再按退出快捷交互`}
          onMouseEnter={() => setHoveredSlotId(slot.slotId)}
          onMouseLeave={() => setHoveredSlotId('')}
          onFocus={() => setHoveredSlotId(slot.slotId)}
          onBlur={() => setHoveredSlotId('')}
          onClick={dismiss}
        >
          <div className="ceramic-key-top">
            <span className="ceramic-key-code">
              {glyphEl}
              <span>{shortText}</span>
            </span>
            <span className="ceramic-key-tag is-exit">退出键</span>
          </div>
          <span className="ceramic-key-exit-text">
            <CornerDownLeft size={12} aria-hidden="true" />
            再按退出
          </span>
        </button>
      )
    }

    if (slot.scopedEntries && slot.scopedEntries.length > 1) {
      return (
        <div
          key={slot.slotId}
          className={`ceramic-key is-scoped-group${isActive ? ' is-active' : ''}${isPressed ? ' is-pressed' : ''}${extraClass ? ` ${extraClass}` : ''}`}
          style={inlineStyle}
          onMouseEnter={() => setHoveredSlotId(slot.slotId)}
          onMouseLeave={() => setHoveredSlotId('')}
        >
          <div className="ceramic-key-top">
            <span className="ceramic-key-code">
              {glyphEl}
              <span>{shortText}</span>
            </span>
            <span className="ceramic-key-tag">{slot.scopedEntries.length} 项</span>
          </div>
          <div className="ceramic-scoped-list">
            {slot.scopedEntries.map(entry => {
              const primary = entry.triggers[0]
              const entryPressed = view.pressedIds.includes(entry.inputId)
              return (
                <button
                  key={entry.inputId}
                  type="button"
                  className={`ceramic-scoped-btn${entry.isExitTrigger ? ' is-exit' : ''}${entryPressed ? ' is-pressed' : ''}`}
                  aria-label={`${slot.label} ${formatScopedMetaLabel(entry)}`}
                  onFocus={() => setHoveredSlotId(slot.slotId)}
                  onBlur={() => setHoveredSlotId('')}
                  onClick={() => (entry.isExitTrigger ? dismiss() : triggerInput(entry.inputId))}
                >
                  <span className="ceramic-scoped-badge">{entry.contextLabel ?? '全局'}</span>
                  <strong className="ceramic-scoped-text">
                    {entry.isExitTrigger ? '再按退出' : (primary?.text ?? '')}
                  </strong>
                </button>
              )
            })}
          </div>
        </div>
      )
    }

    const single = slot.triggers.length === 1 ? slot.triggers[0] : null
    const topTag = single?.badge || (single?.showTriggerTag ? single.triggerLabel : undefined)
    const fullTitle = slot.contextLabel ? `${slot.contextLabel} · ${slot.label}` : slot.label

    return (
      <button
        key={slot.slotId}
        type="button"
        title={single?.kind === 'prompt' ? single.text : undefined}
        className={`ceramic-key is-configured${slotKindClass(slot.primaryKind)}${isActive ? ' is-active' : ''}${isPressed ? ' is-pressed' : ''}${extraClass ? ` ${extraClass}` : ''}`}
        style={inlineStyle}
        aria-label={`${fullTitle}：${slot.triggers.map(t => `${t.triggerLabel} ${t.text}`).join('；')}`}
        onMouseEnter={() => setHoveredSlotId(slot.slotId)}
        onMouseLeave={() => setHoveredSlotId('')}
        onFocus={() => setHoveredSlotId(slot.slotId)}
        onBlur={() => setHoveredSlotId('')}
        onClick={() => triggerInput(slot.inputId)}
      >
        <div className="ceramic-key-top">
          <span className="ceramic-key-code">
            {glyphEl}
            <span>{shortText}</span>
          </span>
          {topTag && <span className={`ceramic-key-tag${slotKindClass(single?.kind)}`}>{topTag}</span>}
        </div>
        {single ? (
          renderSingleTriggerBody(single, slot.contextLabel)
        ) : (
          <div className="ceramic-key-multi">
            {slot.contextLabel && <span className="ceramic-key-scope-line">{slot.contextLabel}</span>}
            {slot.triggers.slice(0, 2).map(entry => (
              <div key={entry.trigger} className={`ceramic-key-multi-row is-${entry.kind}`}>
                <span>{entry.triggerLabel}</span>
                <strong>{entry.text}</strong>
              </div>
            ))}
          </div>
        )}
      </button>
    )
  }

  const renderCrossWell = (well: Extract<QuickOverlaySurfaceBlock, { kind: 'cross' }>, idx: number) => (
    <div key={`cross-${idx}`} className="ceramic-cross-well">
      {well.up && renderKeySlot(well.up, 'cross-slot is-up')}
      {well.left && renderKeySlot(well.left, 'cross-slot is-left')}
      {well.center && renderKeySlot(well.center, 'cross-slot is-center')}
      {well.right && renderKeySlot(well.right, 'cross-slot is-right')}
      {well.down && renderKeySlot(well.down, 'cross-slot is-down')}
    </div>
  )

  const renderBlocks = (blocks: readonly QuickOverlaySurfaceBlock[]) =>
    blocks.map((block, idx) => {
      if (block.kind === 'cross') return renderCrossWell(block, idx)
      if (block.kind === 'bridge') {
        return (
          <div key={`bridge-${idx}`} className="ceramic-bridge-block">
            <div className="ceramic-bridge-stack">
              {renderKeySlot(block.leftStack[0])}
              {renderKeySlot(block.leftStack[1])}
            </div>
            {renderKeySlot(block.center, 'ceramic-bridge-center')}
            <div className="ceramic-bridge-stack">
              {renderKeySlot(block.rightStack[0])}
              {renderKeySlot(block.rightStack[1])}
            </div>
          </div>
        )
      }
      if (block.columns === 1 && block.align) {
        const colPos = block.align === 'left' ? 1 : block.align === 'right' ? 3 : 2
        return (
          <div key={`row-${idx}`} className="ceramic-row cols-3">
            {renderKeySlot(block.slots[0], '', { gridColumn: colPos })}
          </div>
        )
      }
      return (
        <div key={`row-${idx}`} className={`ceramic-row cols-${block.columns}`}>
          {block.slots.map(slot => renderKeySlot(slot))}
        </div>
      )
    })

  const renderSurfaceChassis = () => {
    const { surface } = view

    if (surface.variant === 'matrix') {
      return (
        <div
          className="ceramic-chassis is-matrix"
          style={{
            gridTemplateColumns: `repeat(${surface.cols}, minmax(0, 1fr))`,
            gridTemplateRows: `repeat(${surface.rows}, minmax(74px, 1fr))`,
          }}
        >
          {surface.oledSpan && (
            <div
              className="ceramic-matrix-oled"
              style={{
                gridRow: surface.oledSpan.row,
                gridColumn: `${surface.oledSpan.colStart} / span ${surface.oledSpan.colSpan}`,
              }}
              aria-hidden="true"
            >
              <span className="ceramic-oled-eyebrow">{view.deviceName}</span>
              <strong>{view.profileName}</strong>
              <span>{view.items.length} 键已就绪</span>
            </div>
          )}
          {surface.cells.map(cell => renderKeySlot(cell, '', { gridColumn: cell.col, gridRow: cell.row }))}
        </div>
      )
    }

    if (surface.variant === 'mouse') {
      return (
        <div className="ceramic-chassis is-mouse">
          <div className="ceramic-mouse-thumb">{surface.thumbStack.map(slot => renderKeySlot(slot))}</div>
          <div className="ceramic-mouse-body">
            <div className="ceramic-mouse-primary">
              {surface.primaryPair.map(slot => renderKeySlot(slot, 'is-primary-click'))}
            </div>
            {renderCrossWell(surface.wheelWell, 0)}
          </div>
        </div>
      )
    }

    if (surface.variant === 'controller') {
      return (
        <div className="ceramic-chassis is-controller">
          <div className="ceramic-controller-shoulders">
            <div className="ceramic-shoulder-pair">{surface.leftShoulders.map(slot => renderKeySlot(slot))}</div>
            <div className="ceramic-shoulder-pair">{surface.rightShoulders.map(slot => renderKeySlot(slot))}</div>
          </div>
          {surface.centerRow.length > 0 && (
            <div className="ceramic-controller-center">{surface.centerRow.map(slot => renderKeySlot(slot))}</div>
          )}
          <div className="ceramic-controller-pods">
            <div className="ceramic-pod">{renderBlocks(surface.leftPod)}</div>
            <div className="ceramic-pod">{renderBlocks(surface.rightPod)}</div>
          </div>
        </div>
      )
    }

    const mainColumn = (
      <div className={`ceramic-panel-main density-${surface.density}`}>{renderBlocks(surface.blocks)}</div>
    )
    if (!surface.sideRail) {
      return <div className={`ceramic-chassis is-panel density-${surface.density}`}>{mainColumn}</div>
    }
    const sideRailEl = (
      <div className="ceramic-side-rail" aria-label="侧面按键区">
        {surface.sideRail.slots.map(slot => renderKeySlot(slot, 'is-side-key'))}
      </div>
    )
    return (
      <div
        className={`ceramic-chassis is-panel has-side-rail side-${surface.sideRail.side} density-${surface.density}`}
      >
        {surface.sideRail.side === 'left' ? (
          <>
            {sideRailEl}
            {mainColumn}
          </>
        ) : (
          <>
            {mainColumn}
            {sideRailEl}
          </>
        )}
      </div>
    )
  }

  const shellVariantClass =
    view.surface.variant === 'panel' && view.surface.sideRail ? 'variant-panel-rail' : `variant-${view.surface.variant}`

  return (
    <div
      className="quick-overlay-backdrop"
      onClick={event => {
        if (event.target === event.currentTarget) dismiss()
      }}
    >
      <aside
        className={`quick-overlay-shell ${shellVariantClass}`}
        role="dialog"
        aria-label={`快捷交互窗 · ${view.profileName}`}
      >
        <header className="quick-overlay-header">
          <div className="quick-overlay-identity">
            <span className={`quick-overlay-mode-pill${session.preview ? ' is-preview' : ''}`}>
              <Sparkles size={12} aria-hidden="true" />
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
        ) : (
          <div className="quick-surface-scroll">{renderSurfaceChassis()}</div>
        )}

        {activeDetail && (
          <div className="quick-surface-detail-bar" aria-live="polite">
            <span className="quick-detail-title">
              <strong>{activeDetail.title}</strong>
              <span className="quick-detail-badge">{activeDetail.badge}</span>
            </span>
            <p className="quick-detail-body">{activeDetail.body}</p>
            {activeDetail.steps && <span className="quick-detail-steps">{activeDetail.steps}</span>}
          </div>
        )}
      </aside>
    </div>
  )
}
