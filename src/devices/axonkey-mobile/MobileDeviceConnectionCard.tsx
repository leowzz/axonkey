import { useCallback, useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { invoke } from '@tauri-apps/api/core'
import { listen } from '@tauri-apps/api/event'
import { Check, Copy, Pencil, QrCode, Radio, RefreshCw, Smartphone, Trash2, Wifi, X } from 'lucide-react'
import { QRCodeSVG } from 'qrcode.react'
import { SettingsHelp } from '../../components/SettingsHelp'
import { replaceInstanceProfileBehaviors } from '../integration/instanceProfiles'
import { setDynamicSupportPackageOverride } from '../integration/model'
import type { DeviceController } from '../integration/useDeviceInstances'
import {
  buildDynamicMobileSupportPackage,
  type DeckSnapshot,
  type StarterPresetId,
  type VoicePresetKind,
} from './dynamicSvg'
import {
  applyPresetPayloadToDeviceController,
  inferActiveStarterPreset,
  inferVoicePresetFromSummary,
  voicePresetToRustBinding,
  voicePresetToTriggerBehaviors,
  type MobilePresetAppliedPayload,
} from './presetSync'
import './MobileDeviceConnectionCard.css'

const UDP_DISCOVERY_PORT = 49671

const STARTER_PRESETS: ReadonlyArray<{
  id: StarterPresetId
  label: string
  title: string
}> = [
  { id: 'daily-remote', label: '日常+语音', title: '经典遥控器 + 影音网页快捷页' },
  { id: 'vibe-coding', label: 'AI编程', title: 'AI 编程副屏（继续执行 / 采纳 / 撤销 / 终端）+ 经典遥控器' },
  { id: 'presentation-media', label: '演示影音', title: 'PPT 翻页放映 + 内嵌触控混排页' },
  { id: 'blank-canvas', label: '空白起步', title: '单页 2 列纯净空白面板（无预置按键映射）' },
]

const VOICE_PRESETS: ReadonlyArray<{
  id: VoicePresetKind
  label: string
  title: string
}> = [
  { id: 'doubao-alt', label: 'Alt', title: '按住保持 Alt + 虚拟麦克风（适配豆包等语音输入）' },
  { id: 'system-win-h', label: 'Win+H', title: '触发 Win+H 系统听写 + 虚拟麦克风' },
  { id: 'ctrl-win', label: 'Ctrl+Win', title: '按住保持 Ctrl+Win + 虚拟麦克风' },
  { id: 'pure-mic', label: '纯麦克风', title: '仅传输虚拟麦克风音频，不注入任何快捷键' },
]

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

export function MobileDeviceConnectionCard({
  native,
  instanceId,
  controller,
  onToast,
}: MobileDeviceConnectionCardProps) {
  const [status, setStatus] = useState<MobileHostStatus | null>(null)
  const [peers, setPeers] = useState<PairedPeerSummary[]>([])
  const [deckSnapshot, setDeckSnapshot] = useState<DeckSnapshot | null>(null)
  const [selectedPageId, setSelectedPageId] = useState<string | null>(null)
  const [applyingPreset, setApplyingPreset] = useState(false)
  const lastDeckRevisionRef = useRef(0)
  const lastPhoneActivePageIdRef = useRef<string | null>(null)
  const [dialogOpen, setDialogOpen] = useState(false)
  const [pairing, setPairing] = useState<PairingOfferResponse | null>(null)
  const [loadingOffer, setLoadingOffer] = useState(false)
  const [copied, setCopied] = useState(false)
  const [editingPeerId, setEditingPeerId] = useState<string | null>(null)
  const [remarkDraft, setRemarkDraft] = useState('')
  const [error, setError] = useState<string | null>(null)

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

  const activeStarterPreset = inferActiveStarterPreset(deckSnapshot)
  const inferredVoicePreset = inferVoicePresetFromSummary(deckSnapshot?.voiceBindingSummary)

  const handleApplyPreset = async (preset: StarterPresetId) => {
    if (!native || applyingPreset) return
    setApplyingPreset(true)
    try {
      const voicePreset: VoicePresetKind | null =
        preset === 'blank-canvas'
          ? null
          : inferredVoicePreset && !(activeStarterPreset === 'blank-canvas' && inferredVoicePreset === 'pure-mic')
            ? inferredVoicePreset
            : 'doubao-alt'
      const res = await invoke<MobileDeckResponse>('mobile_host_apply_preset', {
        preset,
        voicePreset,
      })
      applyDeckPayload(res, true)
      const label = STARTER_PRESETS.find(item => item.id === preset)?.label ?? preset
      onToast?.(`已切换预设方案「${label}」`)
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      setError(msg)
      onToast?.(`切换预设失败：${msg}`)
    } finally {
      setApplyingPreset(false)
    }
  }

  const handleSelectVoicePreset = async (voicePreset: VoicePresetKind) => {
    if (!native || applyingPreset) return
    setApplyingPreset(true)
    try {
      const res = await invoke<MobileDeckResponse>('mobile_host_set_tile_binding', {
        tileId: 'mobile.voice',
        binding: voicePresetToRustBinding(voicePreset),
      })
      applyDeckPayload(res)
      if (controller) {
        const target = controller.snapshot.store.instances.find(
          inst => inst.kind === 'axonkeyMobile' && (!instanceId || inst.id === instanceId),
        )
        if (target) {
          const effectiveId = controller.snapshot.runtime[target.id]?.effectiveProfileId ?? target.activeProfileId
          const prof =
            target.profiles.find(p => !p.quick && p.id === effectiveId) ??
            target.profiles.find(p => !p.quick) ??
            target.profiles[0]
          if (prof) {
            const voiceSeq = voicePresetToTriggerBehaviors(voicePreset)
            await controller.update(target.id, current => {
              const latestProf = current.profiles.find(p => p.id === prof.id)
              const existing = (latestProf?.behaviors ?? {}) as Record<string, unknown>
              const nextMap = { ...existing }
              if (voicePreset === 'pure-mic') {
                delete nextMap['mobile.voice']
              } else {
                nextMap['mobile.voice'] = voiceSeq
              }
              return replaceInstanceProfileBehaviors(
                current,
                prof.id,
                nextMap as Parameters<typeof replaceInstanceProfileBehaviors>[2],
              )
            })
          }
        }
      }
      const label = VOICE_PRESETS.find(item => item.id === voicePreset)?.label ?? voicePreset
      onToast?.(`语音触发已切换为「${label}」`)
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      setError(msg)
      onToast?.(`语音触发切换失败：${msg}`)
    } finally {
      setApplyingPreset(false)
    }
  }

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

  const pages = deckSnapshot?.pages ?? []

  return (
    <>
      <div className="mobile-device-bar" role="region" aria-label="手机连接与预设">
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

        <div className="mobile-device-presets" aria-label="预设方案与语音触发">
          <div className="mobile-device-preset-head">
            <span className="mobile-device-section-label">预设方案</span>
            <SettingsHelp id="mobile-starter-preset-help" label="手机预设方案与语音触发说明">
              一键切换手机端面板布局与当前配置的映射动作，手机与桌面端双向实时同步；「空白起步」将清空预置按键动作，方便从零自定义。
            </SettingsHelp>
          </div>
          <div className="mobile-device-preset-grid" role="group" aria-label="预设方案">
            {STARTER_PRESETS.map(item => {
              const isActive = activeStarterPreset === item.id
              return (
                <button
                  key={item.id}
                  type="button"
                  disabled={!native || applyingPreset}
                  aria-pressed={isActive}
                  className={`mobile-device-preset-pill${isActive ? ' active' : ''}`}
                  title={item.title}
                  onClick={() => void handleApplyPreset(item.id)}
                >
                  {item.label}
                </button>
              )
            })}
          </div>
          <div className="mobile-device-voice-row" role="group" aria-label="语音触发方式">
            <span className="mobile-device-voice-label">语音触发</span>
            <div className="mobile-device-voice-pills">
              {VOICE_PRESETS.map(item => {
                const isActive = inferredVoicePreset === item.id
                return (
                  <button
                    key={item.id}
                    type="button"
                    disabled={!native || applyingPreset}
                    aria-pressed={isActive}
                    className={`mobile-device-voice-pill${isActive ? ' active' : ''}`}
                    title={item.title}
                    onClick={() => void handleSelectVoicePreset(item.id)}
                  >
                    {item.label}
                  </button>
                )
              })}
            </div>
          </div>
        </div>
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
    </>
  )
}
