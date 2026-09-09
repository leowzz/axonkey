import { Check, LoaderCircle, ShieldCheck } from 'lucide-react'
import type { useExtraKeys } from '../hooks/useExtraKeys'

export function ExtraKeysControl({ control }: { control: ReturnType<typeof useExtraKeys> }) {
  const { wanted, status, busy, mappingEnabled, change } = control
  const requesting = status.state === 'authorizing'
  const active = ['starting', 'waitingDevice', 'pairing', 'ready'].includes(status.state)
  const needsAuthorization = wanted && !active && !requesting
  return <section className={`extra-keys-control ${status.state}`} aria-labelledby="extra-keys-title">
    <div className="extra-keys-heading">
      <ShieldCheck size={19} aria-hidden="true" />
      <div className="extra-keys-copy">
        <h3 id="extra-keys-title">返回键与音量键支持</h3>
        <p>支持返回、音量加、音量减的自定义映射。开启时需在 Windows 授权窗口中选择“是”，为按键辅助进程授予管理员权限。</p>
      </div>
      <button type="button" className={`extra-keys-switch ${wanted ? 'on' : ''}`} role="switch"
        aria-checked={wanted} aria-label="返回键与音量键支持" disabled={busy}
        onClick={() => void change(!wanted)}><span /></button>
    </div>
    <div className="extra-keys-state" role="status" aria-live="polite">
      {requesting || status.state === 'starting' ? <LoaderCircle size={14} className="home-summary-loading-icon" /> : status.state === 'ready' ? <Check size={14} /> : null}
      <span>{!mappingEnabled ? '自定义按键功能已关闭。开启后，可在此授权这三个按键。'
        : status.state === 'disabled' ? wanted ? '本次运行尚未授权。点击“管理员授权”继续。' : '当前未开启。其他按键可正常使用。'
          : status.message}</span>
      {needsAuthorization && mappingEnabled && <button type="button" className="home-row-action" disabled={busy} onClick={() => void change(true)}>管理员授权</button>}
    </div>
    {status.state === 'pairing' && <ol className="extra-keys-pairing" aria-label="确认遥控器进度">
      {['返回', '音量加', '音量减'].map((label, index) => <li key={label} className={index < status.step ? 'done' : index === status.step ? 'current' : ''}>
        <span>{index < status.step ? <Check size={12} /> : index + 1}</span>按下并松开{label}
      </li>)}
    </ol>}
    <p className="extra-keys-hint">每次启动应用后手动授权；连接变化时按提示重新确认遥控器。关闭此开关会停止这三个按键的采集。</p>
  </section>
}
