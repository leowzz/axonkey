import { useCallback, useEffect, useState } from 'react'
import { invoke } from '@tauri-apps/api/core'
import { Copy, QrCode, RefreshCw, Smartphone, Trash2 } from 'lucide-react'
import { QRCodeSVG } from 'qrcode.react'
import './MobilePairingPanel.css'

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
  offer: {
    v: number
    hostId: string
    hostName: string
    addrs: string[]
    caCertDerB64: string
    pairToken: string
    expiresAtMs: number
  }
  qrPayload: string
}

type PairedPeerSummary = {
  peerId: string
  deviceName: string
  pairedAtMs: number
  lastSeenMs: number
}

type MobilePairingPanelProps = {
  nativeRuntime: boolean
}

export function MobilePairingPanel({ nativeRuntime }: MobilePairingPanelProps) {
  const [status, setStatus] = useState<MobileHostStatus | null>(null)
  const [peers, setPeers] = useState<PairedPeerSummary[]>([])
  const [pairing, setPairing] = useState<PairingOfferResponse | null>(null)
  const [copied, setCopied] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const refresh = useCallback(async () => {
    if (!nativeRuntime) return
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
  }, [nativeRuntime])

  useEffect(() => {
    void refresh()
    if (!nativeRuntime) return
    const timer = window.setInterval(() => {
      void refresh()
    }, 3000)
    return () => window.clearInterval(timer)
  }, [nativeRuntime, refresh])

  const startPairing = async () => {
    if (!nativeRuntime) return
    setBusy(true)
    try {
      const offer = await invoke<PairingOfferResponse>('mobile_host_start_pairing')
      setPairing(offer)
      setCopied(false)
      setError(null)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }

  const revokePeer = async (peerId: string) => {
    if (!nativeRuntime) return
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

  return (
    <div className="mobile-pairing-panel">
      <div className="mobile-pairing-status-card">
        <div className="mobile-pairing-status-head">
          <div className="mobile-pairing-status-title">
            <span className={`mobile-status-dot ${status?.activeSession ? 'online' : status?.running ? 'ready' : ''}`} />
            <strong>{status?.activeSession ? `已连接 · ${status.activeSession.deviceName}` : status?.running ? 'WSS 服务就绪' : '未启动'}</strong>
          </div>
          <button type="button" className="dialog-secondary" onClick={() => void refresh()} disabled={!nativeRuntime}>
            <RefreshCw size={14} aria-hidden="true" />
            <span>刷新</span>
          </button>
        </div>

        {status && (
          <div className="mobile-pairing-meta">
            <span>局域网地址：{status.addrs.join(' / ')}</span>
            <span>协议：axonkey.mobile/1 (TLS 私有 CA)</span>
          </div>
        )}
      </div>

      {error && <div className="mobile-pairing-error">{error}</div>}

      <div className="mobile-pairing-qr-section">
        <div className="mobile-pairing-qr-actions">
          <button
            type="button"
            className="dialog-primary"
            disabled={!nativeRuntime || busy}
            onClick={() => void startPairing()}
          >
            <QrCode size={15} aria-hidden="true" />
            <span>{pairing ? '刷新配对二维码' : '生成配对二维码'}</span>
          </button>
          {pairing && (
            <button type="button" className="dialog-secondary" onClick={() => void copyPayload()}>
              <Copy size={14} aria-hidden="true" />
              <span>{copied ? '已复制载荷' : '复制配对载荷'}</span>
            </button>
          )}
        </div>

        {pairing && (
          <div className="mobile-pairing-qr-box">
            <QRCodeSVG value={pairing.qrPayload} size={184} level="M" includeMargin />
            <div className="mobile-pairing-qr-caption">有效期 120 秒 · 扫码后自动建立端到端加密信任</div>
          </div>
        )}
      </div>

      <div className="mobile-pairing-peers">
        <div className="mobile-pairing-peers-title">已配对手机（{peers.length}）</div>
        {peers.length === 0 ? (
          <div className="mobile-pairing-empty">暂无已配对设备</div>
        ) : (
          <div className="mobile-pairing-peer-list">
            {peers.map(peer => (
              <div key={peer.peerId} className="mobile-pairing-peer-row">
                <div className="mobile-pairing-peer-info">
                  <Smartphone size={15} aria-hidden="true" />
                  <span>{peer.deviceName}</span>
                </div>
                <button
                  type="button"
                  className="dialog-secondary mobile-revoke-btn"
                  onClick={() => void revokePeer(peer.peerId)}
                >
                  <Trash2 size={14} aria-hidden="true" />
                  <span>吊销</span>
                </button>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}
