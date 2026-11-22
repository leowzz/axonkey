import { useCallback, useEffect, useState } from 'react'
import { createPortal } from 'react-dom'
import { invoke } from '@tauri-apps/api/core'
import { Check, Copy, QrCode, Radio, RefreshCw, Smartphone, Trash2, Wifi, X } from 'lucide-react'
import { QRCodeSVG } from 'qrcode.react'
import { SettingsHelp } from '../../components/SettingsHelp'
import './MobileDeviceConnectionCard.css'

const UDP_DISCOVERY_PORT = 49671

type ActiveSessionInfo = {
  sessionId: string
  peerId: string
  deviceName: string
  inputEpoch: number
}

type MobileHostStatus = {
  running: boolean
  hostId: string
  hostName: string
  port: number
  addrs: string[]
  pairedCount: number
  activeSession: ActiveSessionInfo | null
}

type PairingOfferResponse = {
  qrPayload: string
}

type PairedPeerSummary = {
  peerId: string
  deviceName: string
}

type MobileDeviceConnectionCardProps = {
  native: boolean
}

export function MobileDeviceConnectionCard({ native }: MobileDeviceConnectionCardProps) {
  const [status, setStatus] = useState<MobileHostStatus | null>(null)
  const [peers, setPeers] = useState<PairedPeerSummary[]>([])
  const [dialogOpen, setDialogOpen] = useState(false)
  const [pairing, setPairing] = useState<PairingOfferResponse | null>(null)
  const [loadingOffer, setLoadingOffer] = useState(false)
  const [copied, setCopied] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const refresh = useCallback(async () => {
    if (!native) return
    try {
      const [nextStatus, nextPeers] = await Promise.all([
        invoke<MobileHostStatus>('mobile_host_status'),
        invoke<PairedPeerSummary[]>('mobile_host_list_peers'),
      ])
      setStatus(nextStatus)
      setPeers(nextPeers)
      setError(null)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    }
  }, [native])

  useEffect(() => {
    void refresh()
    if (!native) return
    const intervalMs = dialogOpen ? 1500 : 3000
    const timer = window.setInterval(() => void refresh(), intervalMs)
    return () => window.clearInterval(timer)
  }, [dialogOpen, native, refresh])

  const requestPairingOffer = useCallback(async () => {
    if (!native) return
    setLoadingOffer(true)
    try {
      const offer = await invoke<PairingOfferResponse>('mobile_host_start_pairing')
      setPairing(offer)
      setCopied(false)
      setError(null)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setLoadingOffer(false)
    }
  }, [native])

  const openPairingDialog = () => {
    setDialogOpen(true)
    void refresh()
    void requestPairingOffer()
  }

  const revokePeer = async (peerId: string) => {
    if (!native) return
    try {
      await invoke<boolean>('mobile_host_revoke_peer', { peerId })
      await refresh()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    }
  }

  const copyPayload = async () => {
    if (!pairing) return
    try {
      await navigator.clipboard.writeText(pairing.qrPayload)
      setCopied(true)
      window.setTimeout(() => setCopied(false), 1800)
    } catch {
      setError('无法写入剪贴板')
    }
  }

  useEffect(() => {
    if (!dialogOpen) return
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !event.defaultPrevented) {
        setDialogOpen(false)
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [dialogOpen])

  const activeSession = status?.activeSession ?? null
  const connectedName = activeSession?.deviceName
  const pairedTotal = Math.max(status?.pairedCount ?? 0, peers.length)
  const barText = !native
    ? '预览模式'
    : connectedName
      ? `已连接 · ${connectedName}`
      : status?.running
        ? pairedTotal > 0
          ? `等待手机连接 · 已配对 ${pairedTotal} 台`
          : '等待扫码配对'
        : '服务未就绪'
  const dotTone = connectedName ? 'online' : status?.running ? (pairedTotal > 0 ? 'ready' : 'waiting') : ''
  const lanSummary = status?.addrs?.length ? status.addrs.join(' · ') : null

  return (
    <>
      <div className="mobile-device-bar" role="region" aria-label="手机连接状态">
        <div className="mobile-device-bar-status" title={barText}>
          <span className={`mobile-device-dot ${dotTone}`.trim()} aria-hidden="true" />
          <span className="mobile-device-bar-text">{barText}</span>
        </div>
        <button
          type="button"
          className="mobile-device-pair-btn"
          disabled={!native}
          title={!native ? '请在桌面应用中扫码配对手机' : '扫码配对或管理已配对手机'}
          onClick={openPairingDialog}
        >
          <QrCode size={13} aria-hidden="true" />
          <span>配对</span>
        </button>
      </div>

      {dialogOpen &&
        createPortal(
          <div
            className="behavior-dialog-backdrop mobile-pair-backdrop"
            role="presentation"
            onClick={() => setDialogOpen(false)}
          >
            <section
              className="behavior-dialog mobile-pair-dialog"
              role="dialog"
              aria-modal="true"
              aria-labelledby="mobile-pair-dialog-title"
              onClick={event => event.stopPropagation()}
            >
              <header className="behavior-dialog-head mobile-pair-dialog-head">
                <div className="mobile-pair-title-group">
                  <h2 id="mobile-pair-dialog-title">扫码连接手机</h2>
                  <SettingsHelp id="mobile-pair-help" label="手机扫码与自动发现">
                    手机与电脑接入同一局域网或热点后，打开 Axonkey Mobile 扫码即可完成私有 CA
                    加密配对；已配对手机后续打开会自动通过局域网发现（UDP {UDP_DISCOVERY_PORT}）直连，IP
                    或端口变化无需重新扫码。
                  </SettingsHelp>
                </div>
                <button
                  type="button"
                  className="dialog-close"
                  aria-label="关闭扫码配对窗口"
                  onClick={() => setDialogOpen(false)}
                >
                  <X size={17} aria-hidden="true" />
                </button>
              </header>

              <div className="behavior-dialog-body mobile-pair-dialog-body">
                {error && (
                  <p role="alert" className="managed-error">
                    {error}
                  </p>
                )}

                {connectedName && (
                  <div className="mobile-pair-live-banner" role="status">
                    <span className="mobile-device-dot online" aria-hidden="true" />
                    <span>已连接 · {connectedName}</span>
                  </div>
                )}

                <div className="mobile-pair-qr-wrap" aria-busy={loadingOffer || undefined}>
                  {pairing ? (
                    <QRCodeSVG value={pairing.qrPayload} size={220} level="L" includeMargin />
                  ) : (
                    <div className="mobile-pair-qr-placeholder">正在生成加密配对码…</div>
                  )}
                </div>

                <div className="mobile-pair-network" aria-label="局域网连接信息">
                  {lanSummary && (
                    <span className="mobile-pair-endpoint-badge" title={`监听地址：${lanSummary}`}>
                      <Wifi size={12} aria-hidden="true" />
                      <span>{lanSummary}</span>
                    </span>
                  )}
                  <span className="mobile-pair-discovery-badge" title={`局域网自动发现端口 UDP ${UDP_DISCOVERY_PORT}`}>
                    <Radio size={12} aria-hidden="true" />
                    <span>自动发现 :{UDP_DISCOVERY_PORT}</span>
                  </span>
                </div>

                <div className="mobile-pair-actions">
                  <button
                    type="button"
                    className="dialog-secondary"
                    disabled={loadingOffer}
                    onClick={() => void requestPairingOffer()}
                  >
                    <RefreshCw size={13} className={loadingOffer ? 'is-spinning' : undefined} aria-hidden="true" />
                    <span>刷新二维码</span>
                  </button>
                  {pairing && (
                    <button type="button" className="dialog-secondary" onClick={() => void copyPayload()}>
                      {copied ? <Check size={13} aria-hidden="true" /> : <Copy size={13} aria-hidden="true" />}
                      <span>{copied ? '已复制配对码' : '复制配对码'}</span>
                    </button>
                  )}
                </div>

                {peers.length > 0 && (
                  <div className="mobile-pair-peers" aria-label="已配对手机">
                    <span className="mobile-pair-peers-label">已配对手机（{peers.length}）</span>
                    <div className="mobile-pair-peers-list">
                      {peers.map(peer => {
                        const isOnline = activeSession?.peerId === peer.peerId
                        return (
                          <div key={peer.peerId} className="mobile-pair-peer-row">
                            <span className="mobile-pair-peer-info">
                              <Smartphone size={14} aria-hidden="true" />
                              <strong className="mobile-pair-peer-name">{peer.deviceName}</strong>
                              {isOnline && <span className="mobile-pair-peer-online">在线</span>}
                            </span>
                            <button
                              type="button"
                              className="dialog-secondary mobile-pair-revoke-btn"
                              aria-label={`移除 ${peer.deviceName}`}
                              onClick={() => void revokePeer(peer.peerId)}
                            >
                              <Trash2 size={12} aria-hidden="true" />
                              <span>移除</span>
                            </button>
                          </div>
                        )
                      })}
                    </div>
                  </div>
                )}
              </div>
            </section>
          </div>,
          document.body,
        )}
    </>
  )
}
