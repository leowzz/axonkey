import { invoke } from '@tauri-apps/api/core'
import { ArrowLeft, Check, Copy, RefreshCw, ShieldAlert, TriangleAlert, Wrench } from 'lucide-react'
import { useCallback, useEffect, useRef, useState } from 'react'
import type { Platform } from '../../appTypes'
import { writeClipboardText } from '../../clipboard'
import { packageFor } from './model'
import type { DeviceKind } from './model'
import './ConnectionTroubleshootPage.css'

export type BluetoothAdapterStatus = {
  name: string
  instanceId: string
  status: string
  problemCode: number | null
  leSupported: boolean | null
}

export type PairingFailureRecord = {
  timestampIso: string
  timestampMs: number
  provider: string
  eventId: number
  kind: string
  targetAddress: string | null
  errorCodeHex: string | null
  title: string
  explanation: string
  resolvedNow: boolean
  matchingChipSignature: string | null
}

export type PairedDeviceDiagnostic = {
  address: string
  name: string
  vidHex: string | null
  pidHex: string | null
  chipSignature: string | null
  chipVendorLabel: string | null
  lastConnectedMs: number | null
  lastSeenMs: number | null
  present: boolean
  boundToQuarbor: boolean
  recoveryActive: boolean
  supportedKind: string | null
  suspectReason: string | null
}

export type ConnectionTroubleshootReport = {
  platform: string
  checkedAtMs: number
  summaryKind: 'irk_conflict' | 'pairing_error' | 'bluetooth_off' | 'ok' | 'preview' | string
  headline: string
  detail: string
  bluetoothAdapters: BluetoothAdapterStatus[]
  pairingFailures: PairingFailureRecord[]
  pairedDevices: PairedDeviceDiagnostic[]
  warnings: string[]
}

export type ConnectionTroubleshootProps = {
  native: boolean
  platform: Platform
  onBack: () => void
  onOpenBluetoothSettings: () => void
  onOpenDeviceManager: () => void
  onOpenLogs?: () => void
  onToast?: (message: string) => void
  diagnose?: () => Promise<ConnectionTroubleshootReport>
  backLabel?: string
}

export function previewReport(platform: Platform): ConnectionTroubleshootReport {
  return {
    platform,
    checkedAtMs: Date.now(),
    summaryKind: 'preview',
    headline: '浏览器预览模式无法读取本机蓝牙日志与驱动信息',
    detail:
      '请在 Axonkey 桌面应用中打开此页面，系统会自动检测蓝牙适配器状态、Windows IRK 冲突事件（BTHUSB 35 / 0x80090003）以及同芯片已配对设备。',
    bluetoothAdapters: [],
    pairingFailures: [],
    pairedDevices: [],
    warnings: [],
  }
}

export async function loadConnectionTroubleshootReport(
  native: boolean,
  platform: Platform,
  diagnose?: () => Promise<ConnectionTroubleshootReport>,
): Promise<ConnectionTroubleshootReport> {
  if (diagnose) return diagnose()
  if (!native) return previewReport(platform)
  return invoke<ConnectionTroubleshootReport>('diagnose_connection_issues')
}

export function formatTroubleshootTimestamp(ms: number | null | undefined): string {
  if (!ms || !Number.isFinite(ms)) return '-'
  try {
    return new Date(ms).toLocaleString('zh-CN', {
      hour12: false,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    })
  } catch {
    return String(ms)
  }
}

export function formatTroubleshootSummary(report: ConnectionTroubleshootReport): string {
  const lines = [
    `Axonkey 设备连接排查摘要`,
    `平台: ${report.platform}`,
    `检测时间: ${formatTroubleshootTimestamp(report.checkedAtMs)}`,
    `结论 (${report.summaryKind}): ${report.headline}`,
    `说明: ${report.detail}`,
  ]
  if (report.bluetoothAdapters.length > 0) {
    lines.push('', '蓝牙适配器:')
    for (const adapter of report.bluetoothAdapters) {
      const le = adapter.leSupported === null ? '未知' : adapter.leSupported ? '支持 BLE' : '不支持 BLE'
      lines.push(`- ${adapter.name} | 状态: ${adapter.status} | ${le} | ${adapter.instanceId}`)
    }
  }
  if (report.pairingFailures.length > 0) {
    lines.push('', '系统配对异常记录:')
    for (const failure of report.pairingFailures) {
      lines.push(
        `- ${formatTroubleshootTimestamp(failure.timestampMs)} | ${failure.provider} #${failure.eventId} | ${failure.targetAddress ?? '-'} | ${failure.errorCodeHex ?? '-'} | ${failure.resolvedNow ? '后续已恢复' : '未解决'}`,
      )
    }
  }
  if (report.pairedDevices.length > 0) {
    lines.push('', '已配对蓝牙设备:')
    for (const dev of report.pairedDevices) {
      const vidPid = dev.vidHex && dev.pidHex ? `${dev.vidHex}:${dev.pidHex}` : '-'
      const chip = dev.chipSignature ?? '-'
      const quarbor = dev.boundToQuarbor ? (dev.recoveryActive ? 'Quarbor恢复中' : '已挂载Quarbor') : '系统驱动'
      lines.push(
        `- ${dev.name} (${dev.address}) | 芯片: ${chip} | VID/PID: ${vidPid} | ${dev.present ? '在线' : '离线'} | ${quarbor}${dev.suspectReason ? ` | 可疑: ${dev.suspectReason}` : ''}`,
      )
    }
  }
  if (report.warnings.length > 0) {
    lines.push('', '提示:')
    for (const warning of report.warnings) lines.push(`- ${warning}`)
  }
  return lines.join('\n')
}

function summaryClassName(kind: ConnectionTroubleshootReport['summaryKind']): string {
  if (kind === 'irk_conflict') return 'is-conflict'
  if (kind === 'bluetooth_off') return 'is-error'
  if (kind === 'pairing_error') return 'is-warning'
  if (kind === 'preview') return 'is-preview'
  return 'is-ok'
}

export function ConnectionTroubleshootPage({
  native,
  platform,
  onBack,
  onOpenBluetoothSettings,
  onOpenDeviceManager,
  onOpenLogs,
  onToast,
  diagnose,
  backLabel = '我的设备',
}: ConnectionTroubleshootProps) {
  const [report, setReport] = useState<ConnectionTroubleshootReport | null>(() =>
    native || diagnose ? null : previewReport(platform),
  )
  const [loading, setLoading] = useState(native || Boolean(diagnose))
  const [error, setError] = useState('')
  const [copied, setCopied] = useState(false)
  const copyTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => {
    return () => {
      if (copyTimerRef.current !== null) clearTimeout(copyTimerRef.current)
    }
  }, [])

  const refresh = useCallback(async () => {
    setLoading(true)
    setError('')
    try {
      const next = await loadConnectionTroubleshootReport(native, platform, diagnose)
      setReport(next)
    } catch (err) {
      setError(String(err))
    } finally {
      setLoading(false)
    }
  }, [diagnose, native, platform])

  useEffect(() => {
    if (!native && !diagnose) {
      setReport(previewReport(platform))
      setLoading(false)
      setError('')
      return
    }
    void refresh()
  }, [diagnose, native, platform, refresh])

  const handleCopy = async () => {
    if (!report) return
    try {
      await writeClipboardText(formatTroubleshootSummary(report))
      setCopied(true)
      onToast?.('已复制设备排查信息')
      if (copyTimerRef.current !== null) clearTimeout(copyTimerRef.current)
      copyTimerRef.current = setTimeout(() => setCopied(false), 1800)
    } catch (err) {
      onToast?.(`复制失败：${String(err)}`)
    }
  }

  const suspects = report?.pairedDevices.filter(item => Boolean(item.suspectReason)) ?? []
  const unresolvedFailures = report?.pairingFailures.filter(item => !item.resolvedNow) ?? []

  return (
    <section className="troubleshoot-page" aria-label="设备无法连接排查">
      <header className="device-workspace-header">
        <div className="device-workspace-title">
          <button type="button" className="device-workspace-back" aria-label={`返回${backLabel}`} onClick={onBack}>
            <ArrowLeft size={15} />
            {backLabel}
          </button>
          <h1>设备无法连接排查</h1>
        </div>
        <div className="troubleshoot-header-actions">
          <button
            type="button"
            className="troubleshoot-header-btn"
            disabled={loading || (!native && !diagnose)}
            onClick={() => void refresh()}
          >
            <RefreshCw size={14} className={loading ? 'troubleshoot-spin' : undefined} aria-hidden="true" />
            {loading ? '检测中…' : '重新检测'}
          </button>
          <button
            type="button"
            className="troubleshoot-header-btn"
            disabled={!report}
            onClick={() => void handleCopy()}
          >
            {copied ? <Check size={14} aria-hidden="true" /> : <Copy size={14} aria-hidden="true" />}
            {copied ? '已复制' : '复制排查信息'}
          </button>
        </div>
      </header>

      <div className="troubleshoot-scroll">
        {error && (
          <p className="managed-error" role="alert">
            读取排查信息失败：{error}
          </p>
        )}

        {report && (
          <section className={`troubleshoot-summary-card ${summaryClassName(report.summaryKind)}`} aria-live="polite">
            <div className="troubleshoot-summary-head">
              {report.summaryKind === 'irk_conflict' || report.summaryKind === 'bluetooth_off' ? (
                <ShieldAlert size={20} className="troubleshoot-summary-icon" aria-hidden="true" />
              ) : report.summaryKind === 'pairing_error' ? (
                <TriangleAlert size={20} className="troubleshoot-summary-icon" aria-hidden="true" />
              ) : (
                <Wrench size={20} className="troubleshoot-summary-icon" aria-hidden="true" />
              )}
              <div>
                <h2 className="troubleshoot-summary-title">{report.headline}</h2>
                <p className="troubleshoot-summary-detail">{report.detail}</p>
              </div>
            </div>

            {suspects.length > 0 && (
              <div className="troubleshoot-suspect-list">
                {suspects.map(item => (
                  <div key={item.address} className="troubleshoot-suspect-item">
                    <div className="troubleshoot-suspect-title">
                      <span>疑似冲突设备：{item.name}</span>
                      <span className="troubleshoot-mono">{item.address}</span>
                      {(item.chipVendorLabel || item.chipSignature) && (
                        <span className="troubleshoot-badge is-error">
                          芯片 {item.chipVendorLabel ?? item.chipSignature}
                        </span>
                      )}
                    </div>
                    <p className="troubleshoot-suspect-reason">{item.suspectReason}</p>
                    {item.boundToQuarbor && (
                      <p className="troubleshoot-quarbor-warn">
                        该设备当前已挂载 Quarbor 驱动：请先在本软件点击「恢复原驱动」，再前往系统蓝牙设置删除此设备。
                      </p>
                    )}
                  </div>
                ))}
              </div>
            )}

            <div className="troubleshoot-actions-row">
              <button
                type="button"
                className="troubleshoot-primary-btn"
                disabled={!native || (platform !== 'windows' && platform !== 'macos')}
                onClick={onOpenBluetoothSettings}
              >
                打开系统蓝牙设置
              </button>
              {platform === 'windows' && (
                <button type="button" disabled={!native} onClick={onOpenDeviceManager}>
                  打开设备管理器
                </button>
              )}
              {onOpenLogs && (
                <button type="button" disabled={!native} onClick={onOpenLogs}>
                  打开日志目录
                </button>
              )}
            </div>
          </section>
        )}

        {report && report.warnings.length > 0 && (
          <div className="managed-notice" role="status">
            {report.warnings.join('；')}
          </div>
        )}

        {report && (
          <div className="troubleshoot-grid">
            <section className="troubleshoot-card">
              <h3 className="troubleshoot-card-title">
                <span>本机蓝牙适配器</span>
                <span className="troubleshoot-card-count">{report.bluetoothAdapters.length} 个</span>
              </h3>
              {report.bluetoothAdapters.length === 0 ? (
                <p className="troubleshoot-empty">
                  {platform === 'macos'
                    ? '请在「系统设置 -> 蓝牙」确认蓝牙已开启，并检查 Axonkey 的输入监控与辅助功能权限。'
                    : report.summaryKind === 'preview'
                      ? '需在桌面应用中读取本机蓝牙适配器状态。'
                      : '未检测到启用中的蓝牙适配器。'}
                </p>
              ) : (
                <div className="troubleshoot-item-list">
                  {report.bluetoothAdapters.map(adapter => (
                    <div key={adapter.instanceId} className="troubleshoot-subrow">
                      <div className="troubleshoot-subrow-top">
                        <span className="troubleshoot-subrow-name">{adapter.name}</span>
                        <span className={`troubleshoot-badge ${adapter.status === 'OK' ? 'is-ok' : 'is-error'}`}>
                          {adapter.status === 'OK' ? '工作正常' : adapter.status}
                        </span>
                        {adapter.leSupported !== null && (
                          <span className={`troubleshoot-badge ${adapter.leSupported ? 'is-info' : 'is-warn'}`}>
                            {adapter.leSupported ? '支持 BLE' : '不支持 BLE'}
                          </span>
                        )}
                      </div>
                      <span className="troubleshoot-mono">{adapter.instanceId}</span>
                    </div>
                  ))}
                </div>
              )}
            </section>

            <section className="troubleshoot-card">
              <h3 className="troubleshoot-card-title">
                <span>最近配对拦截 / 错误日志</span>
                <span className="troubleshoot-card-count">
                  {unresolvedFailures.length > 0
                    ? `${unresolvedFailures.length} 条未解决`
                    : `${report.pairingFailures.length} 条记录`}
                </span>
              </h3>
              {report.pairingFailures.length === 0 ? (
                <p className="troubleshoot-empty">
                  {report.summaryKind === 'preview'
                    ? '需在桌面应用中读取 Windows 系统事件日志（BTHUSB / 配对关联错误）。'
                    : '近期无蓝牙配对密钥冲突（BTHUSB 事件 35 / 0x80090003）记录。'}
                </p>
              ) : (
                <div className="troubleshoot-item-list">
                  {report.pairingFailures.slice(0, 6).map((failure, index) => (
                    <div
                      key={`${failure.provider}-${failure.eventId}-${failure.timestampMs}-${index}`}
                      className={`troubleshoot-subrow ${failure.resolvedNow ? '' : 'is-suspect'}`}
                    >
                      <div className="troubleshoot-subrow-top">
                        <span className="troubleshoot-subrow-name">{failure.title}</span>
                        <span className={`troubleshoot-badge ${failure.resolvedNow ? 'is-ok' : 'is-error'}`}>
                          {failure.resolvedNow ? '后续已连上' : '未解决'}
                        </span>
                        {failure.errorCodeHex && (
                          <span className="troubleshoot-badge is-warn">{failure.errorCodeHex}</span>
                        )}
                      </div>
                      <div className="troubleshoot-meta-line">
                        <span>时间：{formatTroubleshootTimestamp(failure.timestampMs)}</span>
                        <span>目标地址：{failure.targetAddress ?? '-'}</span>
                        {failure.matchingChipSignature && <span>芯片：{failure.matchingChipSignature}</span>}
                      </div>
                      <p className="troubleshoot-empty">{failure.explanation}</p>
                    </div>
                  ))}
                </div>
              )}
            </section>
          </div>
        )}

        {report && (
          <section className="troubleshoot-card">
            <h3 className="troubleshoot-card-title">
              <span>已配对蓝牙设备与芯片 / 驱动状态</span>
              <span className="troubleshoot-card-count">{report.pairedDevices.length} 个</span>
            </h3>
            {report.pairedDevices.length === 0 ? (
              <p className="troubleshoot-empty">
                {report.summaryKind === 'preview'
                  ? '桌面应用将列出本机已配对的蓝牙设备、芯片指纹及 Quarbor 驱动挂载状态。'
                  : '暂未读取到已配对的蓝牙设备记录。'}
              </p>
            ) : (
              <div className="troubleshoot-device-table">
                {report.pairedDevices.map(dev => {
                  const pkg = dev.supportedKind ? packageFor(dev.supportedKind as DeviceKind) : null
                  return (
                    <div
                      key={dev.address}
                      className={`troubleshoot-device-row ${dev.suspectReason ? 'is-suspect' : ''}`}
                    >
                      <div className="troubleshoot-device-main">
                        <div className="troubleshoot-device-name-line">
                          <span className="troubleshoot-subrow-name">{dev.name}</span>
                          {dev.suspectReason && <span className="troubleshoot-badge is-error">疑似同芯片冲突</span>}
                          {pkg && <span className="troubleshoot-badge is-info">已支持 · {pkg.name}</span>}
                        </div>
                        <span className="troubleshoot-mono">{dev.address}</span>
                      </div>
                      <div className="troubleshoot-meta-line">
                        <span>芯片：{dev.chipVendorLabel ?? dev.chipSignature ?? '-'}</span>
                        <span>VID/PID：{dev.vidHex && dev.pidHex ? `${dev.vidHex} / ${dev.pidHex}` : '-'}</span>
                      </div>
                      <div className="troubleshoot-meta-line">
                        <span>最近连接：{formatTroubleshootTimestamp(dev.lastConnectedMs ?? dev.lastSeenMs)}</span>
                      </div>
                      <div className="troubleshoot-device-badges">
                        <span className={`troubleshoot-badge ${dev.present ? 'is-ok' : 'is-muted'}`}>
                          {dev.present ? '在线' : '离线'}
                        </span>
                        <span
                          className={`troubleshoot-badge ${
                            dev.recoveryActive ? 'is-warn' : dev.boundToQuarbor ? 'is-info' : 'is-muted'
                          }`}
                        >
                          {dev.recoveryActive ? '恢复原驱动中' : dev.boundToQuarbor ? 'Quarbor 已挂载' : '系统默认驱动'}
                        </span>
                      </div>
                    </div>
                  )
                })}
              </div>
            )}
          </section>
        )}

        <section className="troubleshoot-card">
          <h3 className="troubleshoot-card-title">常见无法连接原因与排查顺序</h3>
          <div className="troubleshoot-checklist">
            <div className="troubleshoot-check-step">
              <strong>1. 确认设备已进入配对广播状态</strong>
              <p>
                多数遥控器按一下按键只会尝试回连电视或机顶盒。需按住配对组合键直到指示灯快闪，再在系统蓝牙设置中搜索连接。
              </p>
            </div>
            <div className="troubleshoot-check-step">
              <strong>2. 提示“请尝试重新连接设备”</strong>
              <p>
                常见于两台同芯片（如 Realtek BLE）设备出厂默认 IRK
                冲突。若上方标出疑似冲突设备，先恢复原驱动并删除旧配对，再重新连接。
              </p>
            </div>
            <div className="troubleshoot-check-step">
              <strong>3. 系统已连接但列表仍找不到</strong>
              <p>
                核对上方设备的 VID/PID
                与在线状态；若已在线但未被默认机型识别，可使用「采集新设备」录制按键并生成设备描述。
              </p>
            </div>
          </div>
        </section>
      </div>
    </section>
  )
}
