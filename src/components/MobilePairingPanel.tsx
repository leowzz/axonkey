import { useCallback, useEffect, useState } from 'react'
import { invoke } from '@tauri-apps/api/core'
import { Check, Copy, Keyboard, QrCode, RefreshCw, Smartphone, Trash2 } from 'lucide-react'
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

type MobileTile = {
  id: string
  label: string
  subtitle?: string
  actionSummary?: string
  icon: string
  accent: string
  colSpan: number
  mode: string
  hasDoubleClick: boolean
  hasLongPress: boolean
}

type MobileDeckPage = {
  id: string
  name: string
  layout?: 'remote' | 'grid'
  columns: number
  tiles: MobileTile[]
}

type MobileDeckResponse = {
  revision: number
  snapshot: {
    activePageId: string
    pages: MobileDeckPage[]
  }
}

type NativeBehaviorDto =
  | { type: 'key'; enabled: boolean; key: string }
  | { type: 'shortcut'; enabled: boolean; keys: string[] }
  | { type: 'paste'; enabled: boolean; text: string }
  | { type: 'typeText'; enabled: boolean; text: string }

type TileActionBindings = {
  tap: NativeBehaviorDto[]
  double: NativeBehaviorDto[]
  long: NativeBehaviorDto[]
  holdKeys: string[]
}

type BindingKind = 'shortcut' | 'key' | 'paste' | 'typeText'

type MobilePairingPanelProps = {
  nativeRuntime: boolean
}

export function MobilePairingPanel({ nativeRuntime }: MobilePairingPanelProps) {
  const [status, setStatus] = useState<MobileHostStatus | null>(null)
  const [peers, setPeers] = useState<PairedPeerSummary[]>([])
  const [deck, setDeck] = useState<MobileDeckResponse | null>(null)
  const [bindings, setBindings] = useState<Record<string, TileActionBindings>>({})
  const [pairing, setPairing] = useState<PairingOfferResponse | null>(null)
  const [copied, setCopied] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  // PC-side key mapping editor state
  const [selectedTileId, setSelectedTileId] = useState<string | null>(null)
  const [editKind, setEditKind] = useState<BindingKind>('shortcut')
  const [editValue, setEditValue] = useState('')
  const [editSubmitEnter, setEditSubmitEnter] = useState(false)
  const [savedNotice, setSavedNotice] = useState<string | null>(null)

  const refresh = useCallback(async () => {
    if (!nativeRuntime) return
    try {
      const [nextStatus, nextPeers, nextDeck, nextBindings] = await Promise.all([
        invoke<MobileHostStatus>('mobile_host_status'),
        invoke<PairedPeerSummary[]>('mobile_host_list_peers'),
        invoke<MobileDeckResponse>('mobile_host_get_deck'),
        invoke<Record<string, TileActionBindings>>('mobile_host_get_bindings'),
      ])
      setStatus(nextStatus)
      setPeers(nextPeers)
      setDeck(nextDeck)
      setBindings(nextBindings)
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
    }, 3500)
    return () => window.clearInterval(timer)
  }, [nativeRuntime, refresh])

  const openBindingEditor = (tileId: string) => {
    setSelectedTileId(tileId)
    setSavedNotice(null)
    const current = bindings[tileId]?.tap ?? []
    const first = current[0]
    if (!first) {
      setEditKind('shortcut')
      setEditValue('Control+Enter')
      setEditSubmitEnter(false)
      return
    }
    if (first.type === 'shortcut') {
      setEditKind('shortcut')
      setEditValue(first.keys.join('+'))
      setEditSubmitEnter(false)
    } else if (first.type === 'key') {
      setEditKind('key')
      setEditValue(first.key)
      setEditSubmitEnter(false)
    } else if (first.type === 'paste') {
      setEditKind('paste')
      setEditValue(first.text)
      setEditSubmitEnter(current.length > 1 && current[1]?.type === 'key' && current[1].key === 'Enter')
    } else if (first.type === 'typeText') {
      setEditKind('typeText')
      setEditValue(first.text)
      setEditSubmitEnter(current.length > 1 && current[1]?.type === 'key' && current[1].key === 'Enter')
    }
  }

  const saveBinding = async () => {
    if (!selectedTileId || !nativeRuntime) return
    const val = editValue.trim()
    if (!val) {
      setError('映射内容不能为空')
      return
    }
    const tap: NativeBehaviorDto[] = []
    if (editKind === 'shortcut') {
      const keys = val
        .split('+')
        .map(s => s.trim())
        .filter(Boolean)
      if (keys.length === 0) return
      tap.push({ type: 'shortcut', enabled: true, keys })
    } else if (editKind === 'key') {
      tap.push({ type: 'key', enabled: true, key: val })
    } else if (editKind === 'paste') {
      tap.push({ type: 'paste', enabled: true, text: val })
      if (editSubmitEnter) tap.push({ type: 'key', enabled: true, key: 'Enter' })
    } else {
      tap.push({ type: 'typeText', enabled: true, text: val })
      if (editSubmitEnter) tap.push({ type: 'key', enabled: true, key: 'Enter' })
    }

    const prev = bindings[selectedTileId] ?? { tap: [], double: [], long: [], holdKeys: [] }
    const nextBinding: TileActionBindings = { ...prev, tap }

    try {
      const updated = await invoke<MobileDeckResponse>('mobile_host_set_tile_binding', {
        tileId: selectedTileId,
        binding: nextBinding,
      })
      setDeck(updated)
      setBindings(b => ({ ...b, [selectedTileId]: nextBinding }))
      setSavedNotice('已保存并实时同步至手机显示')
      setError(null)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    }
  }

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
            <strong>
              {status?.activeSession
                ? `已连接 · ${status.activeSession.deviceName}`
                : status?.running
                  ? 'WSS 服务就绪'
                  : '未启动'}
            </strong>
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
            <QRCodeSVG value={pairing.qrPayload} size={248} level="L" includeMargin />
            <div className="mobile-pairing-qr-caption">有效期 120 秒 · 用 Axonkey Mobile 扫码建立端到端加密信任</div>
          </div>
        )}
      </div>

      {/* PC-Side Authoritative Key Mapping Section */}
      {deck && (
        <div className="mobile-mapping-section">
          <div className="mobile-pairing-peers-title">
            <Keyboard size={14} aria-hidden="true" />
            <span>PC 端按键映射（手机仅发送键位信号，此处映射实时同步为手机丝印）</span>
          </div>

          <div className="mobile-mapping-pages">
            {deck.snapshot.pages.map(page => (
              <div key={page.id} className="mobile-mapping-page-block">
                <div className="mobile-mapping-page-name">{page.name}</div>
                <div className="mobile-mapping-chips">
                  {page.tiles.map(tile => (
                    <button
                      key={tile.id}
                      type="button"
                      className={`mobile-mapping-chip ${selectedTileId === tile.id ? 'selected' : ''}`}
                      onClick={() => openBindingEditor(tile.id)}
                    >
                      <span className="mobile-mapping-chip-label">{tile.label}</span>
                      <span className="mobile-mapping-chip-action">{tile.actionSummary ?? '未映射'}</span>
                    </button>
                  ))}
                </div>
              </div>
            ))}
          </div>

          {selectedTileId && (
            <div className="mobile-mapping-editor">
              <div className="mobile-mapping-editor-head">
                <strong>键位信号：{selectedTileId}</strong>
                {savedNotice && (
                  <span className="mobile-mapping-saved">
                    <Check size={13} aria-hidden="true" />
                    {savedNotice}
                  </span>
                )}
              </div>
              <div className="mobile-mapping-editor-row">
                <select
                  value={editKind}
                  onChange={e => setEditKind(e.target.value as BindingKind)}
                  className="mobile-mapping-select"
                >
                  <option value="shortcut">组合快捷键</option>
                  <option value="key">单个按键</option>
                  <option value="paste">粘贴文本/Prompt</option>
                  <option value="typeText">模拟键入文本</option>
                </select>
                <input
                  type="text"
                  value={editValue}
                  onChange={e => setEditValue(e.target.value)}
                  placeholder={
                    editKind === 'shortcut'
                      ? '例如 Control+Shift+P'
                      : editKind === 'key'
                        ? '例如 Enter / Escape / ArrowUp'
                        : '输入要发送的提示词…'
                  }
                  className="mobile-mapping-input"
                />
                <button type="button" className="dialog-primary" onClick={() => void saveBinding()}>
                  保存映射
                </button>
              </div>
              {(editKind === 'paste' || editKind === 'typeText') && (
                <label className="settings-checkbox">
                  <input
                    type="checkbox"
                    checked={editSubmitEnter}
                    onChange={e => setEditSubmitEnter(e.target.checked)}
                  />
                  发送后自动按 Enter 提交
                </label>
              )}
            </div>
          )}
        </div>
      )}

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
