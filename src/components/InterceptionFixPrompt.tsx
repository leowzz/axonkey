import { ShieldCheck } from 'lucide-react'

type InterceptionFixPromptProps = {
  busy: boolean
  error: string
  onInstall: () => void
  onSkip: () => void
}

export function InterceptionFixPrompt({ busy, error, onInstall, onSkip }: InterceptionFixPromptProps) {
  return <div className="interception-fix-prompt-backdrop" role="presentation">
    <section className="interception-fix-prompt" role="dialog" aria-modal="true" aria-labelledby="interception-fix-prompt-title">
      <div className="interception-fix-prompt-icon"><ShieldCheck size={24} /></div>
      <span className="section-kicker">WINDOWS INPUT</span>
      <h2 id="interception-fix-prompt-title">启用重连兼容增强？</h2>
      <p>检测到你已从旧版本升级，当前 Interception 输入驱动已经安装。这个增强用于改善遥控器断连或睡眠唤醒后的恢复，属于可选功能。</p>
      <p className="interception-fix-prompt-note">不安装不会影响基本按键映射。之后可以在“设置 → 设备与权限”中手动安装；安装后需要重启 Windows。</p>
      {error && <p className="interception-fix-prompt-error" role="alert">操作未完成：{error}</p>}
      <div className="interception-fix-prompt-actions">
        <button type="button" className="dialog-secondary" disabled={busy} onClick={onSkip}>暂不安装</button>
        <button type="button" className="button primary" disabled={busy} onClick={onInstall}>{busy ? '处理中…' : '安装增强'}</button>
      </div>
    </section>
  </div>
}
