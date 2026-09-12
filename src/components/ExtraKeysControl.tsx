import { Check, ChevronRight, LoaderCircle, ShieldCheck } from 'lucide-react'
import type { useExtraKeys } from '../hooks/useExtraKeys'

type Control = ReturnType<typeof useExtraKeys>

export function ExtraKeysNotice({ control, onOpen }: { control: Control; onOpen: () => void }) {
  const { wanted, status, mappingEnabled } = control
  const ready = wanted && mappingEnabled && status.state === 'ready'
  const title = ready ? '增强支持已启用'
    : !mappingEnabled ? '自定义按键功能已关闭'
      : !wanted ? '增强未开启，此按键的映射尚未生效'
        : status.state === 'waitingDevice' ? '等待遥控器连接，此按键暂不可用'
          : status.state === 'starting' || status.state === 'authorizing' ? '增强正在启动，此按键暂不可用'
            : '增强尚未就绪，此按键的映射尚未生效'
  if (ready) return <button type="button" className="extra-keys-context compact-ready" onClick={onOpen} aria-label="打开高级选项"><ShieldCheck size={16} aria-hidden="true" /><strong>增强支持已启用</strong><ChevronRight size={15} /></button>
  return <section className={`extra-keys-context unavailable`} aria-label="此按键的增强支持状态">
    <ShieldCheck size={20} aria-hidden="true" /><div className="extra-keys-context-copy"><strong>{title}</strong><p>{!mappingEnabled ? '请先打开顶部的自定义按键开关，再检查增强支持。' : '返回和音量加减的映射需要增强支持。仅保存映射不会启用。'}</p></div><button type="button" className="extra-keys-action" onClick={onOpen}>{wanted ? '查看状态 / 授权' : '查看说明并开启'}<ChevronRight size={15} /></button>
  </section>
}

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
        <div className="extra-keys-title-row">
          <h3 id="extra-keys-title">返回与音量键增强</h3>
          <div className="extra-keys-state" role="status" aria-live="polite">
            {requesting || status.state === 'starting' ? <LoaderCircle size={14} className="home-summary-loading-icon" /> : status.state === 'ready' && mappingEnabled ? <Check size={14} /> : null}
            <span>{message}</span>
          </div>
        </div>
        <p>返回和音量加减的映射均需要此功能。</p>
      </div>
      <div className="extra-keys-heading-actions">
        {!wanted && <button type="button" className="extra-keys-action" disabled={busy || !mappingEnabled}
          aria-describedby="extra-keys-disclosure" onClick={() => void change(true)}><ShieldCheck size={16} />开启并授权</button>}
        {needsAuthorization && mappingEnabled && <button type="button" className="extra-keys-action" disabled={busy} onClick={() => void change(true)}>管理员授权</button>}
        <button type="button" className={`extra-keys-switch ${wanted ? 'on' : ''}`} role="switch"
          aria-checked={wanted} aria-label="返回键与音量键支持" aria-describedby="extra-keys-disclosure" disabled={busy || (!wanted && !mappingEnabled)}
          title="可选，默认关闭；开启后记住选择，下次启动自动请求管理员授权"
          onClick={() => void change(!wanted)}><span /></button>
      </div>
    </div>
    <div className="extra-keys-disclosure" id="extra-keys-disclosure">
      <p><strong>游戏兼容性提醒</strong>通过 Frida 向 Windows 蓝牙设备宿主进程注入 DLL，需管理员权限。无法保证与游戏反作弊兼容；有顾虑请保持关闭。</p>
      <p>关闭会停止采集，但已加载的 DLL 可能仍驻留；如需清除，请关闭此功能并重启 Windows。</p>
    </div>
  </section>
}

