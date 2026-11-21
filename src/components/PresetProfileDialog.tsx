import { useEffect, useId, useRef } from 'react'
import { X } from 'lucide-react'
import type { Platform } from '../appTypes'
import { countConfiguredInputs, summarizePresetHighlights, type DevicePresetOption } from '../devices/bundledPresets.ts'
import './PresetProfileDialog.css'

type PresetProfileDialogProps = {
  deviceName: string
  platform: Platform
  inputs: readonly { id: string; label: string }[]
  presets: readonly DevicePresetOption[]
  activeProfileName: string
  activeProfileIsQuick?: boolean
  onCopyAsNew: (preset: DevicePresetOption) => void
  onOverwriteCurrent: (preset: DevicePresetOption) => void
  onClose: () => void
}

export function PresetProfileDialog({
  deviceName,
  platform,
  inputs,
  presets,
  activeProfileName,
  activeProfileIsQuick = false,
  onCopyAsNew,
  onOverwriteCurrent,
  onClose,
}: PresetProfileDialogProps) {
  const dialogRef = useRef<HTMLDialogElement>(null)
  const titleId = useId()

  useEffect(() => {
    const dialog = dialogRef.current
    const previousFocus = document.activeElement
    dialog?.showModal?.()
    return () => {
      dialog?.close?.()
      if (previousFocus instanceof HTMLElement && previousFocus.isConnected) {
        previousFocus.focus()
      }
    }
  }, [])

  return (
    <dialog ref={dialogRef} className="preset-profile-dialog" aria-labelledby={titleId} onCancel={onClose}>
      <section className="preset-profile-surface">
        <header className="preset-profile-head">
          <h2 id={titleId}>{deviceName} · 预制配置方案</h2>
          <button type="button" className="dialog-close" aria-label="关闭预制配置" onClick={onClose}>
            <X size={17} aria-hidden="true" />
          </button>
        </header>

        <div className="preset-profile-list">
          {presets.length === 0 ? (
            <p className="preset-profile-empty">当前设备暂无可用预制配置。</p>
          ) : (
            presets.map(preset => {
              const keyCount = countConfiguredInputs(preset.behaviors)
              const highlights = summarizePresetHighlights(preset, inputs, platform)
              const compatibleWithActive = Boolean(preset.quick) === Boolean(activeProfileIsQuick)
              return (
                <article key={preset.id} className="preset-profile-card">
                  <div className="preset-profile-card-head">
                    <div className="preset-profile-card-title">
                      <strong>{preset.name}</strong>
                      {preset.isDefault && <span className="preset-profile-badge is-default">推荐默认</span>}
                      <span className={`preset-profile-badge${preset.source === 'cloud' ? ' is-cloud' : ''}`}>
                        {preset.source === 'cloud' ? '云端下发' : '内置'}
                      </span>
                      {preset.quick && <span className="preset-profile-badge">快捷交互窗</span>}
                    </div>
                    <span className="preset-profile-count">已配 {keyCount} 键</span>
                  </div>

                  {preset.description && <p className="preset-profile-desc">{preset.description}</p>}

                  {highlights.length > 0 && (
                    <ul className="preset-profile-highlights" aria-label={`${preset.name} 主要按键功能`}>
                      {highlights.map(item => (
                        <li key={item}>{item}</li>
                      ))}
                    </ul>
                  )}

                  <div className="preset-profile-actions">
                    <button
                      type="button"
                      disabled={!compatibleWithActive}
                      title={
                        compatibleWithActive
                          ? `将此预制写入「${activeProfileName}」并覆盖现有映射`
                          : '普通配置与快捷交互窗配置类型不同，无法直接覆盖'
                      }
                      onClick={() => onOverwriteCurrent(preset)}
                    >
                      覆盖「{activeProfileName}」
                    </button>
                    <button type="button" className="is-primary" onClick={() => onCopyAsNew(preset)}>
                      复制为新配置
                    </button>
                  </div>
                </article>
              )
            })
          )}
        </div>
      </section>
    </dialog>
  )
}
