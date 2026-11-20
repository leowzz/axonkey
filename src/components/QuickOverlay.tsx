import { useEffect, useMemo, useState, useSyncExternalStore } from 'react'
import { invoke } from '@tauri-apps/api/core'
import { listen } from '@tauri-apps/api/event'
import { CornerDownLeft, Sparkles, X } from 'lucide-react'
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
import { logError } from '../runtimeLogging'
import { conciseSlotShort, QuickOverlaySurface, renderKeyGlyph, slotKindClass } from './QuickOverlaySurface'
import {
  buildQuickOverlayView,
  type QuickOverlayKeySlot,
  type QuickOverlayScopedEntry,
  type QuickOverlaySessionPayload,
  type QuickOverlaySurfaceBlock,
  type QuickOverlayTriggerPreview,
  type QuickOverlayViewModel,
} from './quickOverlayModel'

function detectFallbackPlatform(): Platform {
  if (typeof navigator !== 'undefined' && /mac/i.test(navigator.userAgent)) return 'macos'
  return 'windows'
}

function formatScopedMetaLabel(entry: QuickOverlayScopedEntry): string {
  const scopePrefix = entry.contextLabel ? `${entry.contextLabel} · ` : ''
  if (entry.isExitTrigger) return `${scopePrefix}退出键`
  const primary = entry.triggers[0]
  return `${scopePrefix}${primary?.badge || primary?.triggerLabel || '动作'}`
}

function slotDetailCandidate(
  slot: QuickOverlayKeySlot,
  promptMode = false,
): {
  keyLabel: string
  title?: string
  badge: string
  body: string
  steps?: string
} | null {
  if (slot.status !== 'configured') return null
  if (slot.scopedEntries && slot.scopedEntries.length > 1) {
    return {
      keyLabel: slot.label,
      badge: `${slot.scopedEntries.length} 个作用域`,
      body: slot.scopedEntries
        .map(entry => {
          const scope = entry.contextLabel ?? '全局'
          if (entry.isExitTrigger) return `${scope}：再按退出`
          return `${scope}：${entry.triggers.map(t => (t.title ? `${t.title}（${t.text}）` : t.text)).join(' / ')}`
        })
        .join('  ·  '),
    }
  }
  if (slot.triggers.length > 1) {
    return {
      keyLabel: slot.contextLabel ? `${slot.contextLabel} · ${slot.label}` : slot.label,
      badge: `${slot.triggers.length} 组触发`,
      body: slot.triggers.map(t => `${t.triggerLabel}：${t.title ? `${t.title}（${t.text}）` : t.text}`).join('  |  '),
    }
  }
  const single = slot.triggers[0]
  if (!single) return null
  if (
    (single.kind === 'prompt' && (promptMode || Boolean(single.title) || single.text.length > 16)) ||
    single.stepsSummary ||
    single.text.length > 16
  ) {
    return {
      keyLabel: slot.contextLabel ? `${slot.contextLabel} · ${slot.label}` : slot.label,
      ...(single.title ? { title: single.title } : {}),
      badge: single.badge || single.triggerLabel,
      body: single.text,
      steps: single.stepsSummary,
    }
  }
  return null
}

function collectAllSlots(surface: ReturnType<typeof buildQuickOverlayView>['surface']): QuickOverlayKeySlot[] {
  if (surface.variant === 'matrix') return [...surface.cells, ...(surface.sideRail?.slots ?? [])]
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
    void invoke('reveal_quick_overlay', { revision }).catch(error => logError('Failed to reveal quick overlay', error))
  }, [revision])

  const view = useMemo(() => (session ? buildQuickOverlayView(session, platform) : null), [session, platform])

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

  return (
    <QuickOverlayPresentation
      key={session.revision}
      view={view}
      preview={session.preview}
      onDismiss={dismiss}
      onTrigger={triggerInput}
    />
  )
}

export function QuickOverlayPresentation({
  view,
  preview,
  onDismiss,
  onTrigger,
}: {
  view: QuickOverlayViewModel
  preview: boolean
  onDismiss: () => void
  onTrigger?: (inputId: string) => void
}) {
  const [hoveredSlotId, setHoveredSlotId] = useState('')
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return
      event.preventDefault()
      onDismiss()
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [onDismiss])
  const { defaultDetailSlot, slotLookup } = useMemo(() => {
    const allSlots = collectAllSlots(view.surface)
    const map = new Map<string, QuickOverlayKeySlot>()
    let firstDetail: QuickOverlayKeySlot | null = null
    for (const slot of allSlots) {
      map.set(slot.slotId, slot)
      if (!firstDetail && slotDetailCandidate(slot, view.promptMode)) firstDetail = slot
    }
    return { defaultDetailSlot: firstDetail, slotLookup: map }
  }, [view])

  const hoveredSlot = hoveredSlotId ? slotLookup.get(hoveredSlotId) : undefined
  const activeDetail =
    (hoveredSlot && slotDetailCandidate(hoveredSlot, view.promptMode)) ||
    (defaultDetailSlot && slotDetailCandidate(defaultDetailSlot, view.promptMode)) ||
    null

  const renderSingleTriggerBody = (single: QuickOverlayTriggerPreview, contextLabel?: string) => (
    <div className="ceramic-key-single">
      {contextLabel && <span className="ceramic-key-scope-line">{contextLabel}</span>}
      {single.title ? (
        <>
          <strong className={`ceramic-key-label is-titled is-${single.kind}`}>{single.title}</strong>
          {single.text && single.text !== '（空文本）' && <span className="ceramic-key-excerpt">{single.text}</span>}
        </>
      ) : (
        <strong className={`ceramic-key-label is-${single.kind}`}>{single.text}</strong>
      )}
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
          onClick={onDismiss}
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
                  aria-disabled={!entry.isExitTrigger && !onTrigger ? true : undefined}
                  onFocus={() => setHoveredSlotId(slot.slotId)}
                  onBlur={() => setHoveredSlotId('')}
                  onClick={() => (entry.isExitTrigger ? onDismiss() : onTrigger?.(entry.inputId))}
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
    const topTag =
      view.promptMode && single?.kind === 'prompt'
        ? single.autoEnter
          ? '↵ 发送'
          : single.inputMethod === 'typeText'
            ? '输入'
            : undefined
        : single?.badge || (single?.showTriggerTag ? single.triggerLabel : undefined)
    const fullTitle = slot.contextLabel ? `${slot.contextLabel} · ${slot.label}` : slot.label

    return (
      <button
        key={slot.slotId}
        type="button"
        title={single?.kind === 'prompt' ? (single.title ? `${single.title}\n${single.text}` : single.text) : undefined}
        className={`ceramic-key is-configured${slotKindClass(slot.primaryKind)}${isActive ? ' is-active' : ''}${isPressed ? ' is-pressed' : ''}${extraClass ? ` ${extraClass}` : ''}`}
        style={inlineStyle}
        aria-label={`${fullTitle}：${slot.triggers.map(t => `${t.triggerLabel} ${t.title ? `${t.title} ${t.text}` : t.text}`).join('；')}`}
        aria-disabled={!onTrigger ? true : undefined}
        onMouseEnter={() => setHoveredSlotId(slot.slotId)}
        onMouseLeave={() => setHoveredSlotId('')}
        onFocus={() => setHoveredSlotId(slot.slotId)}
        onBlur={() => setHoveredSlotId('')}
        onClick={() => onTrigger?.(slot.inputId)}
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

  const shellVariantClass =
    view.surface.variant === 'panel' && view.surface.sideRail ? 'variant-panel-rail' : `variant-${view.surface.variant}`

  return (
    <div
      className="quick-overlay-backdrop"
      onClick={event => {
        if (event.target === event.currentTarget) onDismiss()
      }}
    >
      <aside
        className={`quick-overlay-shell ${shellVariantClass}${view.promptMode ? ' is-prompt-mode' : ''}`}
        role="dialog"
        aria-label={`快捷交互窗 · ${view.profileName}`}
      >
        <header className="quick-overlay-header">
          <div className="quick-overlay-identity">
            <span className={`quick-overlay-mode-pill${preview ? ' is-preview' : view.promptMode ? ' is-prompt' : ''}`}>
              <Sparkles size={12} aria-hidden="true" />
              <span>{preview ? '预览' : view.promptMode ? '纯 Prompt' : '快捷交互'}</span>
            </span>
            <strong className="quick-overlay-profile-name">{view.profileName}</strong>
            <span className="quick-overlay-meta-sep" aria-hidden="true">
              ·
            </span>
            <span className="quick-overlay-device-name">{view.deviceName}</span>
            {view.items.length > 0 && <span className="quick-overlay-count-chip">{view.items.length} 键</span>}
          </div>
          <div className="quick-overlay-actions">
            {view.triggerLabel ? (
              <span className="quick-overlay-exit-hint">
                {onTrigger ? '再按' : '唤起与退出键'} <kbd>{view.triggerLabel}</kbd>
                {onTrigger && ' 退出'}
              </span>
            ) : onTrigger ? (
              <span className="quick-overlay-exit-hint">按配置键执行后退出</span>
            ) : null}
            <button
              type="button"
              className="quick-overlay-close"
              aria-label="关闭快捷交互窗"
              aria-keyshortcuts="Escape"
              title="关闭快捷交互窗（Esc）"
              onClick={onDismiss}
            >
              <X size={15} aria-hidden="true" />
            </button>
          </div>
        </header>

        {view.items.length === 0 ? (
          <div className="quick-overlay-empty">
            <p>{view.promptMode ? '此 Prompt 面板暂未添加按键内容' : '此快捷配置暂未添加按键功能'}</p>
            <span>在主窗口选择「{view.profileName}」即可为按键配置提示词或快捷行为</span>
          </div>
        ) : (
          <div className="quick-surface-scroll">
            <QuickOverlaySurface view={view} renderKeySlot={renderKeySlot} />
          </div>
        )}

        {activeDetail && (
          <div className="quick-surface-detail-bar" aria-live="polite">
            <div className="quick-detail-head">
              <span className="quick-detail-key-pill">{activeDetail.keyLabel}</span>
              {activeDetail.title && <strong className="quick-detail-title">{activeDetail.title}</strong>}
              <span className={`quick-detail-badge${view.promptMode ? ' is-prompt' : ''}`}>{activeDetail.badge}</span>
              {activeDetail.steps && <span className="quick-detail-steps">{activeDetail.steps}</span>}
            </div>
            <p className="quick-detail-body">{activeDetail.body}</p>
          </div>
        )}
      </aside>
    </div>
  )
}
