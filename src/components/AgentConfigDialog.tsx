import { useEffect, useRef, useState } from 'react'
import { invoke } from '@tauri-apps/api/core'
import { Check, Copy, Terminal, X } from 'lucide-react'
import { agentPromptScenarios, buildAgentCliPrompt, buildAgentScenarioPrompt } from '../agentPrompt.ts'
import { writeClipboardText } from '../clipboard'

type Props = {
  native: boolean
  initialCliPath?: string | null
  onClose: () => void
  onToast?: (message: string) => void
}

const agentCapabilityTags = [
  '设备与键位图',
  '云端/内置预制',
  '快捷键与序列',
  '应用自动切换',
  '纯 Prompt 快捷窗',
  '--dry-run 预览',
] as const

export function AgentConfigDialog({ native, initialCliPath = null, onClose, onToast }: Props) {
  const dialogRef = useRef<HTMLDialogElement>(null)
  const [cliPath, setCliPath] = useState<string | null>(() => {
    const trimmed = typeof initialCliPath === 'string' ? initialCliPath.trim() : ''
    return trimmed || null
  })
  const pendingPathRef = useRef<Promise<string | null> | null>(null)
  const [copiedId, setCopiedId] = useState<string | null>(null)
  const [copyError, setCopyError] = useState(false)
  const copyTimerRef = useRef<number | null>(null)

  useEffect(() => {
    const dialog = dialogRef.current
    const previousFocus = document.activeElement
    dialog?.showModal()
    return () => {
      if (copyTimerRef.current !== null) window.clearTimeout(copyTimerRef.current)
      dialog?.close()
      if (previousFocus instanceof HTMLElement && previousFocus.isConnected) previousFocus.focus()
    }
  }, [])

  useEffect(() => {
    const trimmed = typeof initialCliPath === 'string' ? initialCliPath.trim() : ''
    if (trimmed) {
      setCliPath(trimmed)
      return
    }
    if (!native || typeof window === 'undefined' || !('__TAURI_INTERNALS__' in window)) return
    let cancelled = false
    const request = invoke<string>('cli_executable_path').then(
      value => (typeof value === 'string' && value.trim() ? value.trim() : null),
      () => null,
    )
    pendingPathRef.current = request
    void request.then(resolved => {
      if (!cancelled && resolved) setCliPath(resolved)
    })
    return () => {
      cancelled = true
    }
  }, [native, initialCliPath])

  const markCopied = (id: string, message: string) => {
    setCopyError(false)
    setCopiedId(id)
    onToast?.(message)
    if (copyTimerRef.current !== null) window.clearTimeout(copyTimerRef.current)
    copyTimerRef.current = window.setTimeout(() => {
      setCopiedId(current => (current === id ? null : current))
    }, 2200)
  }

  const copyText = async (id: string, build: (path: string | null) => string, toastMessage: string) => {
    try {
      const resolved = cliPath ?? (await pendingPathRef.current) ?? null
      await writeClipboardText(build(resolved))
      markCopied(id, toastMessage)
    } catch {
      setCopyError(true)
    }
  }

  const starterPrompt = buildAgentCliPrompt(cliPath)

  return (
    <dialog
      ref={dialogRef}
      className="agent-config-dialog"
      aria-labelledby="agent-config-dialog-title"
      onCancel={onClose}
      onClick={event => {
        if (event.target === event.currentTarget) onClose()
      }}
    >
      <div className="agent-config-shell">
        <header className="behavior-dialog-head agent-config-head">
          <div className="agent-config-title-group">
            <span className="agent-config-title-icon" aria-hidden="true">
              <Terminal size={16} />
            </span>
            <div>
              <h2 id="agent-config-dialog-title">用 AI Agent 配置 Axonkey</h2>
              <p className="agent-config-subtitle">
                把提示词发给支持终端的 AI 助手，直接代配按键、预制方案与快捷交互窗。
              </p>
            </div>
          </div>
          <button type="button" className="managed-icon" aria-label="关闭" onClick={onClose}>
            <X size={16} aria-hidden="true" />
          </button>
        </header>

        <div className="behavior-dialog-body agent-config-body">
          <section className="agent-config-section" aria-labelledby="agent-starter-title">
            <div className="agent-config-section-head">
              <div className="agent-config-section-meta">
                <h3 id="agent-starter-title">起始提示词</h3>
                <span className={`agent-path-badge${cliPath ? ' ready' : ''}`}>
                  {cliPath ? '已附带本机 CLI 路径' : '桌面端自动附带本机路径'}
                </span>
              </div>
              <button
                type="button"
                className="agent-copy-button primary"
                aria-label="复制通用提示词"
                onClick={() => void copyText('starter', buildAgentCliPrompt, '已复制 Agent 通用提示词')}
              >
                {copiedId === 'starter' ? (
                  <Check size={14} aria-hidden="true" />
                ) : (
                  <Copy size={14} aria-hidden="true" />
                )}
                <span>{copiedId === 'starter' ? '已复制' : '复制提示词'}</span>
              </button>
            </div>
            <pre className="agent-config-prompt-box">
              <code>{starterPrompt}</code>
            </pre>
            {copyError && (
              <p className="agent-copy-error" role="alert">
                复制失败，请手动选中上方文本后使用系统快捷键复制。
              </p>
            )}
          </section>

          <section className="agent-config-section" aria-labelledby="agent-scenarios-title">
            <div className="agent-config-section-head">
              <h3 id="agent-scenarios-title">常用场景模板</h3>
            </div>
            <div className="agent-scenario-grid">
              {agentPromptScenarios.map(scenario => {
                const isCopied = copiedId === scenario.id
                return (
                  <article key={scenario.id} className="agent-scenario-card">
                    <div className="agent-scenario-head">
                      <strong>{scenario.title}</strong>
                      <button
                        type="button"
                        className="agent-copy-button"
                        aria-label={`复制模板：${scenario.title}`}
                        onClick={() =>
                          void copyText(
                            scenario.id,
                            resolved => buildAgentScenarioPrompt(scenario.task, resolved),
                            `已复制「${scenario.title}」提示词`,
                          )
                        }
                      >
                        {isCopied ? <Check size={13} aria-hidden="true" /> : <Copy size={13} aria-hidden="true" />}
                        <span>{isCopied ? '已复制' : '复制'}</span>
                      </button>
                    </div>
                    <p>{scenario.summary}</p>
                  </article>
                )
              })}
            </div>
          </section>

          <section className="agent-config-section" aria-labelledby="agent-capabilities-title">
            <div className="agent-config-section-head">
              <h3 id="agent-capabilities-title">支持的能力</h3>
            </div>
            <ul className="agent-capability-pills">
              {agentCapabilityTags.map(tag => (
                <li key={tag}>{tag}</li>
              ))}
            </ul>
          </section>
        </div>

        <footer className="managed-dialog-footer agent-config-footer">
          <span className="agent-config-footer-note">
            适用于 Claude Code、Codex、Cursor、Antigravity 等具备终端能力的 AI
          </span>
          <button type="button" className="managed-primary" onClick={onClose} autoFocus>
            关闭
          </button>
        </footer>
      </div>
    </dialog>
  )
}
