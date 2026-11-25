import { useCallback, useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { invoke } from '@tauri-apps/api/core'
import { listen } from '@tauri-apps/api/event'
import {
  AlertTriangle,
  Check,
  Copy,
  ExternalLink,
  Pencil,
  QrCode,
  Radio,
  RefreshCw,
  ShieldAlert,
  Smartphone,
  Trash2,
  Wifi,
  X,
} from 'lucide-react'
import { QRCodeSVG } from 'qrcode.react'
import { SettingsHelp } from '../../components/SettingsHelp'
import { openExternalUrl } from '../../openExternalUrl'
import { setDynamicSupportPackageOverride } from '../integration/model'
import type { DeviceController } from '../integration/useDeviceInstances'
import { buildDynamicMobileSupportPackage, type DeckSnapshot } from './dynamicSvg'
import { applyPresetPayloadToDeviceController, type MobilePresetAppliedPayload } from './presetSync'
import './MobileDeviceConnectionCard.css'

const UDP_DISCOVERY_PORT = 49671
const DESKTOP_RELEASES_URL = 'https://github.com/leowzz/axonkey/releases'
const MOBILE_RELEASES_URL = 'https://github.com/timeStarry/axonkey-mobile/releases'
const DISMISSED_COMPAT_STORAGE_KEY = 'axonkey.mobile.dismissedVersionNotices.v1'

type VersionCompatibilityNotice = {
  key: string
  occurrenceId?: number
  severity: 'soft' | 'hard'
  target: 'mobile' | 'desktop'
  deviceName: string
  currentVersion?: string | null
  expectedVersion: string
  title: string
  message: string
}

function loadDismissedSoftKeys(): string[] {
  if (typeof window === 'undefined') return []
  try {
    const raw = window.localStorage.getItem(DISMISSED_COMPAT_STORAGE_KEY)
    if (!raw) return []
    const parsed = JSON.parse(raw)
    return Array.isArray(parsed) ? parsed.filter((x): x is string => typeof x === 'string') : []
  } catch {
    return []
  }
}

function persistDismissedSoftKeys(keys: string[]): void {
  if (typeof window === 'undefined') return
  try {
    window.localStorage.setItem(DISMISSED_COMPAT_STORAGE_KEY, JSON.stringify(keys.slice(-32)))
  } catch {
    /* ignore storage quota errors */
  }
}

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
  versionNotice?: VersionCompatibilityNotice | null
}

type PairingOfferResponse = {
  qrPayload: string
}

type PairedPeerSummary = {
  peerId: string
  deviceName: string
  hardwareName?: string
  remark?: string | null
}

type MobileDeckResponse = {
  revision: number
  snapshot: DeckSnapshot
}

type MobileDeviceConnectionCardProps = {
  native: boolean
  instanceId?: string
  controller?: DeviceController
  onToast?: (message: string) => void
}

export function MobileDeviceConnectionCard({ native, instanceId, controller }: MobileDeviceConnectionCardProps) {
  const [status, setStatus] = useState<MobileHostStatus | null>(null)
  const [peers, setPeers] = useState<PairedPeerSummary[]>([])
  const [deckSnapshot, setDeckSnapshot] = useState<DeckSnapshot | null>(null)
  const [selectedPageId, setSelectedPageId] = useState<string | null>(null)
  const lastDeckRevisionRef = useRef(0)
  const lastPhoneActivePageIdRef = useRef<string | null>(null)
  const [dialogOpen, setDialogOpen] = useState(false)
  const [pairing, setPairing] = useState<PairingOfferResponse | null>(null)
  const [loadingOffer, setLoadingOffer] = useState(false)
  const [copied, setCopied] = useState(false)
  const [editingPeerId, setEditingPeerId] = useState<string | null>(null)
  const [remarkDraft, setRemarkDraft] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [dismissedSoftKeys, setDismissedSoftKeys] = useState<string[]>(loadDismissedSoftKeys)
  const [dismissedHardKey, setDismissedHardKey] = useState<string | null>(null)

  const applyDeckPayload = useCallback((payload: MobileDeckResponse | null | undefined, forceActivePage = false) => {
    if (!payload?.snapshot) return
    if (payload.revision < lastDeckRevisionRef.current) return
    lastDeckRevisionRef.current = payload.revision
    const nextSnapshot = payload.snapshot
    setDeckSnapshot(nextSnapshot)

    if (forceActivePage || nextSnapshot.activePageId !== lastPhoneActivePageIdRef.current) {
      lastPhoneActivePageIdRef.current = nextSnapshot.activePageId
      setSelectedPageId(nextSnapshot.activePageId)
    } else {
      setSelectedPageId(prev =>
        prev && nextSnapshot.pages.some(page => page.id === prev) ? prev : nextSnapshot.activePageId,
      )
    }
  }, [])

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
      if (lastDeckRevisionRef.current === 0) {
        const initialDeck = await invoke<MobileDeckResponse>('mobile_host_get_deck').catch(() => null)
        applyDeckPayload(initialDeck)
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    }
  }, [applyDeckPayload, native])

  useEffect(() => {
    if (!native) return
    let alive = true
    void invoke<MobileDeckResponse>('mobile_host_get_deck')
      .then(res => {
        if (alive) applyDeckPayload(res)
      })
      .catch(() => {})

    const unlistenDeckPromise = listen<MobileDeckResponse>('axonkey-mobile-deck-changed', event => {
      if (alive) applyDeckPayload(event.payload)
    })

    const unlistenPresetPromise = listen<MobilePresetAppliedPayload>('axonkey-mobile-preset-applied', event => {
      if (!alive || !event.payload?.snapshot) return
      applyDeckPayload({ revision: event.payload.revision, snapshot: event.payload.snapshot }, true)
      if (controller) {
        void applyPresetPayloadToDeviceController(controller, event.payload, instanceId)
      }
    })

    return () => {
      alive = false
      void unlistenDeckPromise.then(unlisten => unlisten())
      void unlistenPresetPromise.then(unlisten => unlisten())
    }
  }, [applyDeckPayload, controller, instanceId, native])

  const effectivePageId =
    (selectedPageId && deckSnapshot?.pages.some(page => page.id === selectedPageId)
      ? selectedPageId
      : deckSnapshot?.activePageId) ??
    deckSnapshot?.pages[0]?.id ??
    null

  useEffect(() => {
    if (!deckSnapshot) return
    try {
      const pkg = buildDynamicMobileSupportPackage(deckSnapshot, effectivePageId ?? undefined)
      setDynamicSupportPackageOverride('axonkeyMobile', pkg)
    } catch {
      /* Fallback to previous or bundled package if malformed snapshot */
    }
  }, [deckSnapshot, effectivePageId])

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
      if (editingPeerId === peerId) setEditingPeerId(null)
      await refresh()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    }
  }

  const startRenamePeer = (peer: PairedPeerSummary) => {
    setEditingPeerId(peer.peerId)
    setRemarkDraft(peer.remark ?? peer.deviceName)
  }

  const submitRenamePeer = async (peerId: string) => {
    if (!native) return
    try {
      const trimmed = remarkDraft.trim()
      await invoke<PairedPeerSummary>('mobile_host_rename_peer', {
        peerId,
        remark: trimmed.length > 0 ? trimmed : null,
      })
      setEditingPeerId(null)
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
  const rawNotice = status?.versionNotice ?? null
  const activeVersionNotice =
    rawNotice &&
    (rawNotice.severity === 'hard' ? rawNotice.key !== dismissedHardKey : !dismissedSoftKeys.includes(rawNotice.key))
      ? rawNotice
      : null

  const dismissVersionNotice = useCallback((notice: VersionCompatibilityNotice) => {
    if (notice.severity === 'hard') {
      setDismissedHardKey(notice.key)
      return
    }
    setDismissedSoftKeys(prev => {
      if (prev.includes(notice.key)) return prev
      const next = [...prev, notice.key]
      persistDismissedSoftKeys(next)
      return next
    })
  }, [])

  useEffect(() => {
    if (!activeVersionNotice) return
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !event.defaultPrevented) {
        dismissVersionNotice(activeVersionNotice)
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [activeVersionNotice, dismissVersionNotice])
  const barText = !native
    ? '预览模式'
    : connectedName
      ? `已连接 · ${connectedName}`
      : status?.running
        ? pairedTotal > 0
          ? `等待手机连接 · 已配对 ${pairedTotal} 台（需同一局域网）`
          : '等待扫码配对 · 请确保双端在同一局域网'
        : '服务未就绪'
  const dotTone = connectedName ? 'online' : status?.running ? (pairedTotal > 0 ? 'ready' : 'waiting') : ''
  const lanSummary = status?.addrs?.length ? status.addrs.join(' · ') : null

  const pages = deckSnapshot?.pages ?? []

  return (
    <>
      <div className="mobile-device-bar" role="region" aria-label="手机连接状态">
        <div className="mobile-device-bar-main">
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

        {pages.length > 1 && (
          <div className="mobile-device-pages" role="tablist" aria-label="手机页面视图">
            {pages.map(page => {
              const isSelected = page.id === effectivePageId
              const isPhoneActive = page.id === deckSnapshot?.activePageId
              const pageLabel = page.name?.trim() || page.id
              return (
                <button
                  key={page.id}
                  type="button"
                  role="tab"
                  aria-selected={isSelected}
                  className={`mobile-device-page-pill${isSelected ? ' active' : ''}`}
                  title={isPhoneActive ? `${pageLabel}（手机当前页）` : `切换视图：${pageLabel}`}
                  onClick={() => setSelectedPageId(page.id)}
                >
                  {isPhoneActive && <span className="mobile-device-page-live-dot" aria-hidden="true" />}
                  <span className="mobile-device-page-name">{pageLabel}</span>
                </button>
              )
            })}
          </div>
        )}
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

                <p className="mobile-pair-lan-hint">请确保手机与电脑连接在同一局域网（同一 Wi‑Fi 或热点）下</p>

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
                        const isEditing = editingPeerId === peer.peerId
                        const showSub =
                          Boolean(peer.remark) && Boolean(peer.hardwareName) && peer.hardwareName !== peer.deviceName
                        return (
                          <div key={peer.peerId} className="mobile-pair-peer-row">
                            {isEditing ? (
                              <form
                                className="mobile-pair-rename-form"
                                onSubmit={e => {
                                  e.preventDefault()
                                  void submitRenamePeer(peer.peerId)
                                }}
                              >
                                <input
                                  type="text"
                                  className="mobile-pair-rename-input"
                                  value={remarkDraft}
                                  maxLength={48}
                                  placeholder={peer.hardwareName || '输入手机备注名称（留空恢复原名）'}
                                  autoFocus
                                  onChange={e => setRemarkDraft(e.target.value)}
                                  onKeyDown={e => {
                                    if (e.key === 'Escape') {
                                      e.stopPropagation()
                                      setEditingPeerId(null)
                                    }
                                  }}
                                />
                                <button
                                  type="submit"
                                  className="dialog-secondary mobile-pair-icon-btn"
                                  aria-label="保存备注"
                                >
                                  <Check size={12} aria-hidden="true" />
                                  <span>保存</span>
                                </button>
                                <button
                                  type="button"
                                  className="dialog-secondary mobile-pair-icon-btn"
                                  aria-label="取消修改"
                                  onClick={() => setEditingPeerId(null)}
                                >
                                  <span>取消</span>
                                </button>
                              </form>
                            ) : (
                              <>
                                <span className="mobile-pair-peer-info">
                                  <Smartphone size={14} aria-hidden="true" />
                                  <strong className="mobile-pair-peer-name">{peer.deviceName}</strong>
                                  {showSub && <span className="mobile-pair-peer-sub">({peer.hardwareName})</span>}
                                  {isOnline && <span className="mobile-pair-peer-online">在线</span>}
                                </span>
                                <span className="mobile-pair-peer-actions">
                                  <button
                                    type="button"
                                    className="dialog-secondary mobile-pair-icon-btn"
                                    aria-label={`修改 ${peer.deviceName} 备注名称`}
                                    onClick={() => startRenamePeer(peer)}
                                  >
                                    <Pencil size={12} aria-hidden="true" />
                                    <span>备注</span>
                                  </button>
                                  <button
                                    type="button"
                                    className="dialog-secondary mobile-pair-revoke-btn"
                                    aria-label={`移除 ${peer.deviceName}`}
                                    onClick={() => void revokePeer(peer.peerId)}
                                  >
                                    <Trash2 size={12} aria-hidden="true" />
                                    <span>移除</span>
                                  </button>
                                </span>
                              </>
                            )}
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

      {activeVersionNotice &&
        createPortal(
          <div
            className="behavior-dialog-backdrop mobile-compat-backdrop"
            role="presentation"
            onClick={() => dismissVersionNotice(activeVersionNotice)}
          >
            <section
              className="behavior-dialog mobile-compat-dialog"
              role="alertdialog"
              aria-modal="true"
              aria-labelledby="mobile-compat-dialog-title"
              onClick={event => event.stopPropagation()}
            >
              <header className="behavior-dialog-head mobile-pair-dialog-head">
                <div className="mobile-pair-title-group">
                  {activeVersionNotice.severity === 'hard' ? (
                    <ShieldAlert size={18} className="mobile-compat-icon is-hard" aria-hidden="true" />
                  ) : (
                    <AlertTriangle size={18} className="mobile-compat-icon is-soft" aria-hidden="true" />
                  )}
                  <h2 id="mobile-compat-dialog-title">{activeVersionNotice.title}</h2>
                </div>
                <button
                  type="button"
                  className="dialog-close"
                  aria-label="关闭版本提示窗口"
                  onClick={() => dismissVersionNotice(activeVersionNotice)}
                >
                  <X size={17} aria-hidden="true" />
                </button>
              </header>

              <div className="behavior-dialog-body mobile-compat-dialog-body">
                <div className={`mobile-compat-badge is-${activeVersionNotice.severity}`}>
                  {activeVersionNotice.severity === 'hard'
                    ? '协议不兼容 · 需更新后连接'
                    : '版本跨度较大 · 可能影响体验'}
                </div>

                <p className="mobile-compat-desc">{activeVersionNotice.message}</p>

                <div className="mobile-compat-meta">
                  <div className="mobile-compat-meta-row">
                    <span>需更新客户端</span>
                    <strong>
                      {activeVersionNotice.target === 'desktop' ? '电脑端 Axonkey' : '手机端 Axonkey Mobile'}
                    </strong>
                  </div>
                  <div className="mobile-compat-meta-row">
                    <span>版本要求</span>
                    <strong>
                      {activeVersionNotice.currentVersion
                        ? `v${activeVersionNotice.currentVersion.replace(/^v/i, '')} → `
                        : ''}
                      {activeVersionNotice.expectedVersion}
                    </strong>
                  </div>
                </div>

                <div className="mobile-compat-actions">
                  <button
                    type="button"
                    className="dialog-secondary"
                    onClick={() => dismissVersionNotice(activeVersionNotice)}
                  >
                    {activeVersionNotice.severity === 'hard' ? '知道了' : '继续使用（本版本不再提示）'}
                  </button>
                  <button
                    type="button"
                    className="dialog-primary mobile-compat-primary-btn"
                    onClick={() => {
                      const url = activeVersionNotice.target === 'desktop' ? DESKTOP_RELEASES_URL : MOBILE_RELEASES_URL
                      void openExternalUrl(url, { native })
                      if (activeVersionNotice.severity === 'soft') {
                        dismissVersionNotice(activeVersionNotice)
                      }
                    }}
                  >
                    <span>{activeVersionNotice.target === 'desktop' ? '前往下载电脑端新版' : '查看手机端更新包'}</span>
                    <ExternalLink size={13} aria-hidden="true" />
                  </button>
                </div>
              </div>
            </section>
          </div>,
          document.body,
        )}
    </>
  )
}
