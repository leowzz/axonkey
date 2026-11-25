import { useEffect, useRef } from 'react'
import { X } from 'lucide-react'
import type { ClipboardHudEntry, ClipboardOverlayPayload } from './quickOverlayModel'
import './ClipboardHud.css'

export type { ClipboardHudEntry, ClipboardOverlayPayload }

export function ClipboardHud({
  preview,
  clipboard,
  onDismiss,
  onSelect,
  onClear,
}: {
  preview: boolean
  clipboard: ClipboardOverlayPayload
  onDismiss: () => void
  onSelect?: (index: number) => void
  onClear?: () => void
}) {
  const entries = clipboard.entries
  const selectedIndex = entries.length === 0 ? 0 : Math.min(Math.max(0, clipboard.selectedIndex), entries.length - 1)
  const isCopy = clipboard.action === 'copyText'
  const selectedRef = useRef<HTMLButtonElement>(null)

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return
      event.preventDefault()
      onDismiss()
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [onDismiss])

  useEffect(() => {
    selectedRef.current?.scrollIntoView?.({ block: 'nearest' })
  }, [selectedIndex, entries.length])

  return (
    <div
      className="clipboard-hud-backdrop"
      onClick={event => {
        if (event.target === event.currentTarget) onDismiss()
      }}
    >
      <aside className="clipboard-hud-shell" role="dialog" aria-label={isCopy ? '剪贴板浮窗（仅复制）' : '剪贴板浮窗'}>
        <header className="clipboard-hud-header">
          <div className="clipboard-hud-identity">
            <strong className="clipboard-hud-title">{isCopy ? '剪贴板 · 仅复制' : '剪贴板'}</strong>
            {preview && <span className="clipboard-hud-pill is-preview">预览</span>}
            {entries.length > 0 && <span className="clipboard-hud-count">{entries.length}</span>}
          </div>
          <div className="clipboard-hud-actions">
            {entries.length > 0 && onClear && (
              <button
                type="button"
                className="clipboard-hud-clear"
                aria-label="清空剪贴板历史"
                title="清空剪贴板历史"
                onClick={onClear}
              >
                清空
              </button>
            )}
            <button
              type="button"
              className="clipboard-hud-close"
              aria-label="关闭剪贴板浮窗"
              aria-keyshortcuts="Escape"
              title="关闭（Esc）"
              onClick={onDismiss}
            >
              <X size={14} aria-hidden="true" />
            </button>
          </div>
        </header>

        {entries.length === 0 ? (
          <div className="clipboard-hud-empty">
            <p>剪贴板暂无文本记录</p>
            <span>{isCopy ? '复制文本后再次唤起即可选择复制' : '复制文本后再次唤起即可选择粘贴'}</span>
          </div>
        ) : (
          <div className="clipboard-hud-list" role="listbox" aria-label="剪贴板历史列表">
            {entries.map((entry, index) => {
              const isSelected = index === selectedIndex
              const display = entry.text.trim() || entry.text
              const showMeta = isSelected && (entry.text.includes('\n') || entry.text.length > 80)
              return (
                <button
                  key={`${entry.copiedAtMs}-${index}`}
                  ref={isSelected ? selectedRef : undefined}
                  type="button"
                  role="option"
                  aria-selected={isSelected}
                  data-selected={isSelected ? 'true' : undefined}
                  className={`clipboard-hud-row${isSelected ? ' is-selected' : ''}`}
                  title={entry.text}
                  onClick={() => onSelect?.(index)}
                >
                  <span className="clipboard-hud-index">{index + 1}</span>
                  <div className="clipboard-hud-body">
                    <span className="clipboard-hud-text">{display}</span>
                    {showMeta && <span className="clipboard-hud-meta">{entry.text.length} 字符</span>}
                  </div>
                  {isSelected && <span className="clipboard-hud-confirm-badge">{isCopy ? 'OK 复制' : 'OK 粘贴'}</span>}
                </button>
              )
            })}
          </div>
        )}

        {entries.length > 0 && (
          <footer className="clipboard-hud-footer">
            <span>
              <kbd>↑</kbd>
              <kbd>↓</kbd> 切换
            </span>
            <span>
              <kbd>OK</kbd> {isCopy ? '复制' : '粘贴'}
            </span>
            <span>
              <kbd>返回</kbd> / <kbd>Esc</kbd> 关闭
            </span>
          </footer>
        )}
      </aside>
    </div>
  )
}
