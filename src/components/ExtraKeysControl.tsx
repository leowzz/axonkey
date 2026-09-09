import { Check, LoaderCircle, ShieldCheck } from 'lucide-react'
import type { useExtraKeys } from '../hooks/useExtraKeys'

export function ExtraKeysControl({ control }: { control: ReturnType<typeof useExtraKeys> }) {
  const { wanted, status, busy, mappingEnabled, change } = control
  const requesting = status.state === 'authorizing'
  const active = ['starting', 'waitingDevice', 'ready'].includes(status.state)
  const needsAuthorization = wanted && !active && !requesting
  const message = !mappingEnabled ? '请先开启自定义按键功能'
    : status.state === 'disabled' ? wanted ? '等待授权' : '未开启'
      : requesting ? '等待管理员授权…'
        : status.state === 'starting' ? '正在连接…'
          : status.state === 'waitingDevice' ? '等待遥控器连接'
            : status.state === 'ready' ? '已启用'
              : status.message.includes('取消') ? '已取消授权' : status.message
  return <section className={`extra-keys-control ${status.state}`} aria-labelledby="extra-keys-title">
    <div className="extra-keys-heading">
      <ShieldCheck size={19} aria-hidden="true" />
      <div className="extra-keys-copy">
        <h3 id="extra-keys-title">返回与音量键增强 <small>可选 · 默认关闭</small></h3>
        <p>为返回、音量加和音量减启用自定义映射。</p>
      </div>
    </div>
    <div className="extra-keys-disclosure" id="extra-keys-disclosure">
      <p><strong>游戏兼容性提醒</strong>通过 Frida 向 Windows 蓝牙设备宿主进程注入 DLL，需管理员权限。无法保证与游戏反作弊兼容；有顾虑请保持关闭。</p>
      <p>关闭会停止采集，但已加载的 DLL 可能仍驻留；如需清除，请关闭此功能并重启 Windows。</p>
    </div>
    <div className="extra-keys-activation">
      <div><strong>启用增强支持</strong><p>开启后记住选择，下次启动自动请求管理员授权。</p></div>
      <button type="button" className={`extra-keys-switch ${wanted ? 'on' : ''}`} role="switch"
        aria-checked={wanted} aria-label="返回键与音量键支持" aria-describedby="extra-keys-disclosure" disabled={busy || (!wanted && !mappingEnabled)}
        onClick={() => void change(!wanted)}><span /></button>
    </div>
    <div className="extra-keys-state" role="status" aria-live="polite">
      {requesting || status.state === 'starting' ? <LoaderCircle size={14} className="home-summary-loading-icon" /> : status.state === 'ready' ? <Check size={14} /> : null}
      <span>{message}</span>
      {needsAuthorization && mappingEnabled && <button type="button" className="home-row-action" disabled={busy} onClick={() => void change(true)}>管理员授权</button>}
    </div>
  </section>
}
