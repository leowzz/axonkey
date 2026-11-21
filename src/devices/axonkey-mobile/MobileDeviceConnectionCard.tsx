import { useCallback, useEffect, useState } from 'react'
import { createPortal } from 'react-dom'
import { invoke } from '@tauri-apps/api/core'
import { Copy, QrCode, Smartphone, Trash2, X } from 'lucide-react'
import { QRCodeSVG } from 'qrcode.react'
import './MobileDeviceConnectionCard.css'

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
    const timer = window.setInterval(() => void refresh(), 3000)
    return () => window.clearInterval(timer)
  }, [native, refresh])

  const openPairingDialog = async () => {
    setDialogOpen(true)
    if (!native) return
    try {
      const offer = await invoke<PairingOfferResponse>('mobile_host_start_pairing')
      setPairing(offer)
      setCopied(false)
      setError(null)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    }
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
      window.setTimeout(() => setCopied(false), 1600)
    } catch {
      setError('无法写入剪贴板')
    }
  }

  useEffect(() => {
    if (!dialogOpen) return
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setDialogOpen(false)
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [dialogOpen])

  const connectedName = status?.activeSession?.deviceName

  return (
    <>
      <div className="mobile-device-bar">
        <div className="mobile-device-bar-status">
          <span className={`mobile-device-dot ${connectedName ? 'online' : status?.running ? 'ready' : ''}`} />
          <span className="mobile-device-bar-text">
            {connectedName ? `已连接 · ${connectedName}` : status?.running ? '等待手机扫码连接' : '未就绪'}
          </span>
        </div>
        <button
          type="button"
          className="mobile-device-pair-btn"
          disabled={!native}
          onClick={() => void openPairingDialog()}
        >
          <QrCode size={14} aria-hidden="true" />
          <span>配对</span>
        </button>
      </div>

      {dialogOpen &&
        createPortal(
          <div className="behavior-dialog-backdrop mobile-pair-backdrop" role="presentation" onClick={() => setDialogOpen(false)}>
            <div
              className="behavior-dialog mobile-pair-dialog"
              role="dialog"
              aria-modal="true"
              aria-label="Axonkey Mobile 扫码配对"
              onClick={e => e.stopPropagation()}
            >
              <div className="mobile-pair-dialog-head">
                <h3>扫码连接 Axonkey Mobile</h3>
                <button
                  type="button"
                  className="mobile-pair-close"
                  aria-label="关闭"
                  onClick={() => setDialogOpen(false)}
                >
                  <X size={16} aria-hidden="true" />
                </button>
              </div>

              {error && <p className="managed-error">{error}</p>}

              {pairing && (
                <div className="mobile-pair-qr-wrap">
                  <QRCodeSVG value={pairing.qrPayload} size={236} level="L" includeMargin />
                </div>
              )}

              {status && (
                <div className="mobile-pair-meta">
                  <span>{status.addrs.join(' / ')}</span>
                </div>
              )}

              <div className="mobile-pair-actions">
                <button type="button" className="dialog-secondary" onClick={() => void openPairingDialog()}>
                  刷新二维码
                </button>
                {pairing && (
                  <button type="button" className="dialog-secondary" onClick={() => void copyPayload()}>
                    <Copy size={14} aria-hidden="true" />
                    <span>{copied ? '已复制' : '复制载荷'}</span>
                  </button>
                )}
              </div>

              {peers.length > 0 && (
                <div className="mobile-pair-peers">
                  {peers.map(peer => (
                    <div key={peer.peerId} className="mobile-pair-peer-row">
                      <span className="mobile-pair-peer-name">
                        <Smartphone size={14} aria-hidden="true" />
                        {peer.deviceName}
                      </span>
                      <button
                        type="button"
                        className="dialog-secondary"
                        onClick={() => void revokePeer(peer.peerId)}
                      >
                        <Trash2 size={13} aria-hidden="true" />
                        <span>吊销</span>
                      </button>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>,
          document.body,
        )}
    </>
  )
}
