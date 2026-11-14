import { useMemo, useState } from 'react'
import { Plug, PlugZap, RefreshCw, RotateCcw, Search, ShieldAlert, ShieldCheck, ShieldX } from 'lucide-react'
import {
  formatVidPid,
  safetyBadgeLabel,
  transportLabel,
  type CaptureCandidate,
  type CaptureSessionStatus,
} from './model'

export type CaptureDeviceListProps = {
  native: boolean
  candidates: readonly CaptureCandidate[]
  selectedTargetId: string | null
  sessionStatus: CaptureSessionStatus | null
  loading: boolean
  busyInstanceId: string | null
  includeGatt: boolean
  onIncludeGattChange: (value: boolean) => void
  onRefresh: (includeGatt?: boolean) => void
  onSelectCandidate: (candidate: CaptureCandidate) => void
  onRequestAttachDriver: (candidate: CaptureCandidate) => void
  onDetachDriver: (candidate: CaptureCandidate) => void
  onStartSession: (candidate: CaptureCandidate) => void
  onStopSession: () => void
}

type CandidateFilter = 'all' | 'safe' | 'bound'

export function CaptureDeviceList({
  native,
  candidates,
  selectedTargetId,
  sessionStatus,
  loading,
  busyInstanceId,
  includeGatt,
  onIncludeGattChange,
  onRefresh,
  onSelectCandidate,
  onRequestAttachDriver,
  onDetachDriver,
  onStartSession,
  onStopSession,
}: CaptureDeviceListProps) {
  const [query, setQuery] = useState('')
  const [filter, setFilter] = useState<CandidateFilter>('all')

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase()
    return candidates.filter(candidate => {
      if (filter === 'safe' && candidate.safetyTier !== 'safe') return false
      if (filter === 'bound' && !candidate.boundToQuarbor) return false
      if (!q) return true
      const vidPid = formatVidPid(candidate.vid, candidate.pid).toLowerCase()
      const gattText = [
        candidate.gattInfo?.manufacturer,
        candidate.gattInfo?.modelNumber,
        candidate.gattInfo?.softwareRevision,
      ]
        .filter(Boolean)
        .join(' ')
        .toLowerCase()
      return (
        candidate.displayName.toLowerCase().includes(q) ||
        candidate.instanceId.toLowerCase().includes(q) ||
        vidPid.includes(q) ||
        transportLabel(candidate.transport).toLowerCase().includes(q) ||
        gattText.includes(q)
      )
    })
  }, [candidates, filter, query])

  const boundCount = candidates.filter(item => item.boundToQuarbor).length

  return (
    <div className="capture-device-step">
      <div className="capture-device-toolbar">
        <div className="capture-search-box">
          <Search size={14} aria-hidden="true" />
          <input
            type="search"
            value={query}
            onChange={event => setQuery(event.target.value)}
            placeholder="搜索设备名、VID:PID 或实例 ID"
            aria-label="搜索候选设备"
          />
        </div>
        <button
          type="button"
          className="capture-icon-btn"
          aria-label="刷新候选设备"
          title="刷新候选设备"
          disabled={!native || loading}
          onClick={() => onRefresh(includeGatt)}
        >
          <RefreshCw size={14} className={loading ? 'is-spinning' : undefined} />
        </button>
      </div>

      <div className="capture-filter-bar">
        <div className="capture-filter-pills" role="group" aria-label="设备筛选">
          <button type="button" aria-pressed={filter === 'all'} onClick={() => setFilter('all')}>
            全部 ({candidates.length})
          </button>
          <button type="button" aria-pressed={filter === 'safe'} onClick={() => setFilter('safe')}>
            推荐安全
          </button>
          <button type="button" aria-pressed={filter === 'bound'} onClick={() => setFilter('bound')}>
            已挂载 ({boundCount})
          </button>
        </div>

        <label className="capture-inline-check">
          <input
            type="checkbox"
            checked={includeGatt}
            disabled={!native || loading}
            onChange={event => {
              const next = event.target.checked
              onIncludeGattChange(next)
              if (native) onRefresh(next)
            }}
          />
          <span>读取蓝牙信息</span>
        </label>
      </div>

      {!native ? (
        <div className="capture-empty-box">
          <strong>需在桌面应用枚举实体设备</strong>
          <span>当前为浏览器预览，可直接在步骤 2 加载 SVG 图稿体验热区适配与导出。</span>
        </div>
      ) : filtered.length === 0 ? (
        <div className="capture-empty-box">
          <strong>{loading ? '正在扫描物理设备…' : '未找到匹配的候选设备'}</strong>
          {!loading && <span>蓝牙遥控器请先在系统蓝牙设置完成配对后点击刷新。</span>}
        </div>
      ) : (
        <div className="capture-candidate-list" role="list" aria-label="物理设备候选列表">
          {filtered.map(candidate => {
            const selected = selectedTargetId === candidate.targetId
            const isActiveSession =
              Boolean(sessionStatus?.active) &&
              (sessionStatus?.targetId === candidate.targetId || sessionStatus?.instanceId === candidate.instanceId)
            const busy = busyInstanceId === candidate.instanceId
            const blocked = candidate.safetyTier === 'blocked'
            const SafetyIcon =
              candidate.safetyTier === 'safe' ? ShieldCheck : candidate.safetyTier === 'caution' ? ShieldAlert : ShieldX

            return (
              <div
                key={candidate.targetId}
                role="listitem"
                data-target-id={candidate.targetId}
                data-selected={selected || undefined}
                data-safety={candidate.safetyTier}
                className={`capture-candidate-card${selected ? ' is-selected' : ''}${isActiveSession ? ' is-session-active' : ''}`}
                onClick={() => onSelectCandidate(candidate)}
              >
                <div className="capture-candidate-top">
                  <div className="capture-candidate-title-row">
                    <strong className="capture-candidate-name">{candidate.displayName}</strong>
                    <span className="capture-tag is-transport">{transportLabel(candidate.transport)}</span>
                    <span className="capture-tag is-vidpid">{formatVidPid(candidate.vid, candidate.pid)}</span>
                    {candidate.usagePage !== null && candidate.usage !== null && (
                      <span className="capture-tag is-usage">
                        {`0x${candidate.usagePage.toString(16).toUpperCase().padStart(2, '0')}:0x${candidate.usage.toString(16).toUpperCase().padStart(2, '0')}`}
                      </span>
                    )}
                  </div>

                  <span className={`capture-safety-badge is-${candidate.safetyTier}`}>
                    <SafetyIcon size={12} aria-hidden="true" />
                    {safetyBadgeLabel(candidate.safetyTier)}
                  </span>
                </div>

                <div className="capture-candidate-meta">
                  <span className={`capture-driver-state ${candidate.boundToQuarbor ? 'is-bound' : 'is-native'}`}>
                    {candidate.boundToQuarbor
                      ? 'Quarbor 已拦截'
                      : candidate.recoveryActive
                        ? '已恢复 · 待重连'
                        : '系统原驱动'}
                  </span>
                  {candidate.registeredKind && (
                    <span className="capture-registered-pill">内置型号：{candidate.registeredKind}</span>
                  )}
                  {candidate.gattInfo?.modelNumber && (
                    <span className="capture-gatt-meta">型号 {candidate.gattInfo.modelNumber}</span>
                  )}
                  <code className="capture-instance-id" title={candidate.instanceId}>
                    {candidate.instanceId}
                  </code>
                </div>

                {candidate.safetyReason && (
                  <p className={`capture-safety-reason is-${candidate.safetyTier}`} role={blocked ? 'note' : undefined}>
                    {candidate.safetyReason}
                  </p>
                )}

                <div className="capture-candidate-actions" onClick={event => event.stopPropagation()}>
                  {!candidate.boundToQuarbor ? (
                    <button
                      type="button"
                      className="capture-btn-primary"
                      disabled={!native || blocked || busyInstanceId !== null}
                      onClick={() => onRequestAttachDriver(candidate)}
                    >
                      <PlugZap size={13} aria-hidden="true" />
                      {busy ? '正在挂载…' : '挂载拦截驱动'}
                    </button>
                  ) : (
                    <button
                      type="button"
                      className="capture-btn-warning"
                      disabled={!native || busyInstanceId !== null}
                      onClick={() => onDetachDriver(candidate)}
                    >
                      <RotateCcw size={13} aria-hidden="true" />
                      {busy ? '正在恢复…' : '恢复原驱动'}
                    </button>
                  )}

                  {isActiveSession ? (
                    <button
                      type="button"
                      className="capture-btn-secondary"
                      disabled={!native || busy}
                      onClick={onStopSession}
                    >
                      断开会话
                    </button>
                  ) : (
                    <button
                      type="button"
                      className={candidate.boundToQuarbor ? 'capture-btn-primary' : 'capture-btn-secondary'}
                      disabled={!native || blocked || busyInstanceId !== null}
                      onClick={() => onStartSession(candidate)}
                    >
                      <Plug size={13} aria-hidden="true" />
                      {candidate.boundToQuarbor ? '连接采集' : '直接监听'}
                    </button>
                  )}
                </div>
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}
