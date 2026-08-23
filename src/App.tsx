import {
  BatteryMedium,
  Check,
  CheckCircle2,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  ChevronUp,
  Command,
  Copy,
  Home,
  Keyboard,
  Menu,
  Mic,
  Minus,
  Power,
  RotateCcw,
  Square,
  Target,
  Tv,
  X,
  X as CloseIcon,
} from 'lucide-react'
import { getCurrentWindow } from '@tauri-apps/api/window'
import {
  KeyboardEvent,
  PointerEvent as ReactPointerEvent,
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from 'react'

type ButtonId = 'power' | 'voice' | 'up' | 'left' | 'confirm' | 'right' | 'down' | 'home' | 'menu' | 'tv'

type RemoteButton = {
  id: ButtonId
  label: string
  short: string
  side: 'left' | 'right'
  x: number
  y: number
  icon: 'power' | 'mic' | 'up' | 'left' | 'center' | 'right' | 'down' | 'home' | 'menu' | 'tv'
}

const buttons: RemoteButton[] = [
  { id: 'power', label: '电源键', short: '电源', side: 'left', x: 18.27, y: 12.06, icon: 'power' },
  { id: 'voice', label: '语音键', short: '语音', side: 'right', x: 66.19, y: 11.50, icon: 'mic' },
  { id: 'up', label: '方向上', short: '上', side: 'left', x: 40.61, y: 24.79, icon: 'up' },
  { id: 'left', label: '方向左', short: '左', side: 'left', x: 12.76, y: 37.30, icon: 'left' },
  { id: 'confirm', label: '确认键', short: '确认', side: 'right', x: 42.23, y: 37.07, icon: 'center' },
  { id: 'right', label: '方向右', short: '右', side: 'right', x: 71.70, y: 36.07, icon: 'right' },
  { id: 'down', label: '方向下', short: '下', side: 'right', x: 40.61, y: 49.02, icon: 'down' },
  { id: 'home', label: '主页键', short: '主页', side: 'left', x: 22.80, y: 75.72, icon: 'home' },
  { id: 'menu', label: '功能键', short: '功能', side: 'left', x: 21.18, y: 90.79, icon: 'menu' },
  { id: 'tv', label: '电视键', short: '电视', side: 'right', x: 60.69, y: 91.91, icon: 'tv' },
]

const defaultMappings: Record<ButtonId, string> = {
  power: 'Esc',
  voice: 'RAlt',
  up: 'original',
  left: 'original',
  confirm: 'original',
  right: 'original',
  down: 'original',
  home: 'original',
  menu: 'original',
  tv: 'original',
}

const settingsStorageKey = 'axonkey.settings.v1'

type StoredSettings = {
  mappings: Record<ButtonId, string>
  enabled: boolean
}

function getStoredSettings(): StoredSettings {
  const fallback = { mappings: defaultMappings, enabled: false }
  if (typeof window === 'undefined') return fallback
  try {
    const stored = window.localStorage.getItem(settingsStorageKey)
    if (!stored) return fallback
    const parsed = JSON.parse(stored) as Partial<StoredSettings>
    return {
      mappings: { ...defaultMappings, ...(parsed.mappings ?? {}) },
      enabled: parsed.enabled === true,
    }
  } catch {
    return fallback
  }
}

const actionOptions = [
  { value: 'original', label: '保留原按键' },
  { value: 'Esc', label: 'Esc' },
  { value: 'Enter', label: 'Enter' },
  { value: 'Space', label: 'Space' },
  { value: 'RAlt', label: '右 Alt' },
  { value: 'Ctrl+C', label: 'Ctrl + C' },
  { value: 'Ctrl+V', label: 'Ctrl + V' },
  { value: 'Ctrl+Shift+P', label: 'Ctrl + Shift + P' },
  { value: 'Win+D', label: 'Win + D' },
  { value: 'VolumeUp', label: '音量增大' },
  { value: 'VolumeDown', label: '音量减小' },
  { value: 'MediaPlayPause', label: '播放 / 暂停' },
]

const iconFor = (kind: RemoteButton['icon'], size = 16) => {
  const props = { size, strokeWidth: 1.8 }
  switch (kind) {
    case 'power': return <Power {...props} />
    case 'mic': return <Mic {...props} />
    case 'up': return <ChevronUp {...props} />
    case 'left': return <ChevronLeft {...props} />
    case 'right': return <ChevronRight {...props} />
    case 'down': return <ChevronDown {...props} />
    case 'home': return <Home {...props} />
    case 'menu': return <Menu {...props} />
    case 'tv': return <Tv {...props} />
    default: return <Command {...props} />
  }
}

function displayAction(value: string) {
  return actionOptions.find((option) => option.value === value)?.label ?? value
}

async function windowCommand(command: 'minimize' | 'toggleMaximize' | 'close') {
  try {
    const currentWindow = getCurrentWindow()
    if (command === 'minimize') await currentWindow.minimize()
    if (command === 'toggleMaximize') await currentWindow.toggleMaximize()
    if (command === 'close') await currentWindow.close()
  } catch {
    // The browser demo has no native window; Tauri handles these commands in the desktop shell.
  }
}

function formatCapturedKey(event: KeyboardEvent<HTMLInputElement>) {
  const keyMap: Record<string, string> = {
    ' ': 'Space', Escape: 'Esc', Enter: 'Enter', Tab: 'Tab', Backspace: 'Backspace', Delete: 'Delete',
    ArrowUp: 'Up', ArrowDown: 'Down', ArrowLeft: 'Left', ArrowRight: 'Right', Meta: 'Win', Control: 'Ctrl',
    Shift: 'Shift', Alt: 'Alt', PageUp: 'PageUp', PageDown: 'PageDown', Home: 'Home', End: 'End',
  }
  let key = keyMap[event.key] ?? (event.key.length === 1 ? event.key.toUpperCase() : event.key)
  if (['Ctrl', 'Shift', 'Alt', 'Win'].includes(key)) return ''
  const modifiers = [event.ctrlKey ? 'Ctrl' : '', event.shiftKey ? 'Shift' : '', event.altKey ? 'Alt' : '', event.metaKey ? 'Win' : ''].filter(Boolean)
  return [...modifiers, key].join('+')
}

type Connector = { id: ButtonId; side: 'left' | 'right'; x1: number; y1: number; x2: number; y2: number }
type HitPosition = { x: number; y: number }

const initialHitPositions: Record<ButtonId, HitPosition> = {
  power: { x: 18.27, y: 12.06 },
  voice: { x: 66.19, y: 11.50 },
  up: { x: 40.61, y: 24.79 },
  left: { x: 12.76, y: 37.30 },
  confirm: { x: 42.23, y: 37.07 },
  right: { x: 71.70, y: 36.07 },
  down: { x: 40.61, y: 49.02 },
  home: { x: 22.80, y: 75.72 },
  menu: { x: 21.18, y: 90.79 },
  tv: { x: 60.69, y: 91.91 },
}

const hitPositionsStorageKey = 'axonkey.debug-hit-positions.v2'

function getStoredHitPositions() {
  if (typeof window === 'undefined') return initialHitPositions
  try {
    const stored = window.localStorage.getItem(hitPositionsStorageKey)
    if (!stored) return initialHitPositions
    return { ...initialHitPositions, ...JSON.parse(stored) } as Record<ButtonId, HitPosition>
  } catch {
    return initialHitPositions
  }
}

function App() {
  const [activeId, setActiveId] = useState<ButtonId>('voice')
  const [mappings, setMappings] = useState<Record<ButtonId, string>>(() => getStoredSettings().mappings)
  const [capturing, setCapturing] = useState<ButtonId | null>(null)
  const [enabled, setEnabled] = useState(() => getStoredSettings().enabled)
  const [debugMode, setDebugMode] = useState(false)
  const [hitPositions, setHitPositions] = useState<Record<ButtonId, HitPosition>>(getStoredHitPositions)
  const [draggingId, setDraggingId] = useState<ButtonId | null>(null)
  const [coordinateSnippet, setCoordinateSnippet] = useState('')
  const [autoSaveState, setAutoSaveState] = useState<'saved' | 'saving'>('saved')
  const [toast, setToast] = useState('')
  const workspaceRef = useRef<HTMLDivElement>(null)
  const remoteArtRef = useRef<HTMLDivElement>(null)
  const coordinateTextRef = useRef<HTMLTextAreaElement>(null)
  const markerRefs = useRef<Partial<Record<ButtonId, HTMLButtonElement>>>({})
  const rowRefs = useRef<Partial<Record<ButtonId, HTMLDivElement>>>({})
  const brandClickRef = useRef({ count: 0, lastAt: 0 })
  const [connectors, setConnectors] = useState<Connector[]>([])

  const updateMapping = useCallback((id: ButtonId, value: string) => {
    setMappings((current) => ({ ...current, [id]: value }))
    setAutoSaveState('saving')
  }, [])

  const measureConnectors = useCallback(() => {
    if (!workspaceRef.current) return
    const workspace = workspaceRef.current.getBoundingClientRect()
    const next = buttons.flatMap((button) => {
      const marker = markerRefs.current[button.id]
      const row = rowRefs.current[button.id]
      if (!marker || !row) return []
      const markerRect = marker.getBoundingClientRect()
      const rowRect = row.getBoundingClientRect()
      return [{
        id: button.id,
        side: button.side,
        x1: markerRect.left + markerRect.width / 2 - workspace.left,
        y1: markerRect.top + markerRect.height / 2 - workspace.top,
        x2: button.side === 'left'
          ? rowRect.right - workspace.left + 10
          : rowRect.left - workspace.left - 10,
        y2: rowRect.top + rowRect.height / 2 - workspace.top,
      }]
    })
    setConnectors(next)
  }, [])

  useLayoutEffect(() => {
    measureConnectors()
    const observer = new ResizeObserver(measureConnectors)
    if (workspaceRef.current) observer.observe(workspaceRef.current)
    window.addEventListener('resize', measureConnectors)
    return () => {
      observer.disconnect()
      window.removeEventListener('resize', measureConnectors)
    }
  }, [measureConnectors, activeId, mappings, debugMode])

  useLayoutEffect(() => {
    measureConnectors()
  }, [hitPositions, measureConnectors])

  useEffect(() => {
    window.localStorage.setItem(hitPositionsStorageKey, JSON.stringify(hitPositions))
  }, [hitPositions])

  useEffect(() => {
    window.localStorage.setItem(settingsStorageKey, JSON.stringify({ mappings, enabled }))
    setAutoSaveState('saved')
  }, [mappings, enabled])

  useEffect(() => {
    if (!coordinateSnippet || !coordinateTextRef.current) return
    coordinateTextRef.current.focus()
    coordinateTextRef.current.select()
  }, [coordinateSnippet])

  useEffect(() => {
    if (!capturing) return
    const handleOutsideKey = (event: globalThis.KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault()
        setCapturing(null)
      }
    }
    window.addEventListener('keydown', handleOutsideKey)
    return () => window.removeEventListener('keydown', handleOutsideKey)
  }, [capturing])

  const resetMappings = () => {
    setMappings(defaultMappings)
    setAutoSaveState('saving')
    setToast('已恢复默认映射，将自动保存')
    window.setTimeout(() => setToast(''), 2200)
  }

  const toggleEnabled = () => {
    setEnabled((value) => !value)
    setAutoSaveState('saving')
  }

  const handleBrandClick = () => {
    const now = Date.now()
    const clickState = brandClickRef.current
    if (now - clickState.lastAt > 1200) clickState.count = 0
    clickState.count += 1
    clickState.lastAt = now
    if (clickState.count < 5) return
    clickState.count = 0
    setDebugMode((current) => {
      const next = !current
      setToast(next ? '调试模式已开启' : '调试模式已关闭')
      window.setTimeout(() => setToast(''), 2200)
      return next
    })
  }

  const connectedCount = Object.values(mappings).filter((value) => value !== 'original').length

  const handleHotspotPointerDown = (button: RemoteButton, event: ReactPointerEvent<HTMLButtonElement>) => {
    if (!debugMode || !remoteArtRef.current) return
    event.preventDefault()
    event.stopPropagation()
    event.currentTarget.setPointerCapture(event.pointerId)
    setActiveId(button.id)
    setDraggingId(button.id)
  }

  const handleHotspotPointerMove = (button: RemoteButton, event: ReactPointerEvent<HTMLButtonElement>) => {
    if (!debugMode || draggingId !== button.id || !remoteArtRef.current) return
    const rect = remoteArtRef.current.getBoundingClientRect()
    const x = Math.max(2, Math.min(98, ((event.clientX - rect.left) / rect.width) * 100))
    const y = Math.max(2, Math.min(98, ((event.clientY - rect.top) / rect.height) * 100))
    setHitPositions((current) => ({ ...current, [button.id]: { x, y } }))
  }

  const finishHotspotDrag = (event: ReactPointerEvent<HTMLButtonElement>) => {
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId)
    setDraggingId(null)
  }

  const copyHitPositions = async () => {
    const lines = buttons.map((button) => `  ${button.id}: { x: ${hitPositions[button.id].x.toFixed(2)}, y: ${hitPositions[button.id].y.toFixed(2)} },`)
    const snippet = `const initialHitPositions: Record<ButtonId, HitPosition> = {\n${lines.join('\n')}\n}`
    setCoordinateSnippet(snippet)
    let copied = false
    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(snippet)
        copied = true
      }
    } catch {
      copied = false
    }
    if (!copied) {
      const fallback = document.createElement('textarea')
      fallback.value = snippet
      fallback.setAttribute('readonly', '')
      fallback.style.position = 'fixed'
      fallback.style.opacity = '0'
      document.body.appendChild(fallback)
      fallback.select()
      copied = document.execCommand('copy')
      fallback.remove()
    }
    setToast(copied ? '坐标已复制，也可以从弹窗中手动复制' : '请在弹窗文本框中按 Ctrl+C 复制坐标')
    window.setTimeout(() => setToast(''), 2600)
  }

  const resetHitPositions = () => {
    setHitPositions(initialHitPositions)
    window.localStorage.removeItem(hitPositionsStorageKey)
    setToast('已恢复默认点位')
    window.setTimeout(() => setToast(''), 2200)
  }

  return (
    <div className="app-shell">
      <main className="main-content">
        <header className="topbar">
          <div className="native-controls" aria-label="窗口控制">
            <button type="button" aria-label="最小化" title="最小化" onClick={() => void windowCommand('minimize')}><Minus size={15} /></button>
            <button type="button" aria-label="最大化" title="最大化" onClick={() => void windowCommand('toggleMaximize')}><Square size={13} /></button>
            <button className="close-control" type="button" aria-label="退出" title="退出" onClick={() => void windowCommand('close')}><CloseIcon size={15} /></button>
          </div>
          <div className="topbar-left">
            <button className="brand-lockup compact brand-trigger" type="button" aria-label="Axonkey" title="Axonkey" onClick={handleBrandClick}>
              <span className="brand-mark">A</span>
              <span>
                <span className="brand-name">axonkey</span>
                <span className="brand-version">RC003 控制台 <span>0.1</span></span>
              </span>
            </button>
            <div className="title-row"><h1>按键映射</h1><span className="title-divider" /><span className="title-hint">RC003</span></div>
          </div>
          <div className="header-actions">
            <label className="enable-control"><span>启用自定义按键功能</span><button className={`switch ${enabled ? 'on' : ''}`} type="button" aria-pressed={enabled} onClick={toggleEnabled}><span /></button></label>
            <div className="device-card"><div className="device-card-head"><strong>小米遥控器</strong><CheckCircle2 size={19} /></div><div className="device-card-meta"><span className="device-state-dot" /> <span>{enabled ? '已连接' : '未连接'}</span><BatteryMedium size={17} /><span className="device-meta-separator" /><span>电源正常</span></div></div>
          </div>
        </header>

        <div className="toolbar-row">
          <div className="toolbar-context"><span className="toolbar-context-mark" /> 选择按键，设置不同的触发行为</div>
          <div className="toolbar-meta"><span>{connectedCount} 个自定义动作</span><span className="toolbar-divider" /><span className={`auto-save-state ${autoSaveState}`}><Check size={13} /> {autoSaveState === 'saving' ? '保存中' : '已自动保存'}</span>{debugMode && <><span className="toolbar-divider" /><span className="debug-status"><Target size={13} /> 调试模式</span><span className="debug-hint">拖动图上的点调整连线起点</span><button type="button" className="reset-button" onClick={() => void copyHitPositions()}><Copy size={13} /> 复制坐标</button><button type="button" className="reset-button" onClick={resetHitPositions}><RotateCcw size={13} /> 恢复点位</button></>}<button type="button" className="reset-button" onClick={resetMappings}><RotateCcw size={14} /> 恢复默认</button></div>
        </div>

        <div className={`workspace ${debugMode ? 'debug-mode' : ''}`} ref={workspaceRef}>
          <MappingSide
            side="left"
            buttons={buttons.filter((button) => button.side === 'left')}
            mappings={mappings}
            activeId={activeId}
            capturing={capturing}
            rowRefs={rowRefs}
            setActiveId={setActiveId}
            setCapturing={setCapturing}
            updateMapping={updateMapping}
          />

          <section className="remote-panel panel-surface">
            <div className="panel-heading">
              <div><span className="section-kicker">REMOTE</span><h2>遥控器位置</h2></div>
              <span className="mini-status"><span className="live-dot" /> 在线</span>
            </div>
            <div className="remote-stage">
              <div className="remote-art" ref={remoteArtRef}>
                <img src="/rc003-remote-cutout.png" alt="小米 RC003 遥控器" />
                {buttons.map((button) => (
                  <button
                    key={button.id}
                    ref={(node) => { if (node) markerRefs.current[button.id] = node }}
                    type="button"
                    aria-label={button.label}
                    className={`hotspot hotspot-${button.icon} ${activeId === button.id ? 'active' : ''} ${mappings[button.id] !== 'original' ? 'mapped' : ''} ${draggingId === button.id ? 'dragging' : ''}`}
                    style={{ left: `${hitPositions[button.id].x}%`, top: `${hitPositions[button.id].y}%` }}
                    onClick={() => { setActiveId(button.id); setCapturing(null) }}
                    onPointerDown={(event) => handleHotspotPointerDown(button, event)}
                    onPointerMove={(event) => handleHotspotPointerMove(button, event)}
                    onPointerUp={finishHotspotDrag}
                    onPointerCancel={finishHotspotDrag}
                  >{button.icon === 'center' ? <span className="center-dot" /> : iconFor(button.icon, 13)}</button>
                ))}
              </div>
            </div>
            <div className="remote-caption"><span className="caption-line" /> 点击按键查看对应行为</div>
          </section>

          <MappingSide
            side="right"
            buttons={buttons.filter((button) => button.side === 'right')}
            mappings={mappings}
            activeId={activeId}
            capturing={capturing}
            rowRefs={rowRefs}
            setActiveId={setActiveId}
            setCapturing={setCapturing}
            updateMapping={updateMapping}
          />

          <svg className="connector-layer" aria-hidden="true">
            {connectors.map((line) => {
              const selected = line.id === activeId
              const elbow = line.side === 'left'
                ? Math.min(line.x1 - 34, line.x2 + 32)
                : Math.max(line.x1 + 34, line.x2 - 32)
              return <g key={line.id} className={selected ? 'connector selected' : 'connector'}>
                <path d={`M ${line.x1} ${line.y1} C ${elbow} ${line.y1}, ${elbow} ${line.y2}, ${line.x2} ${line.y2}`} />
                <circle cx={line.x1} cy={line.y1} r={selected ? 4 : 2.5} />
                <circle cx={line.x2} cy={line.y2} r={selected ? 3.5 : 2} />
              </g>
            })}
          </svg>
        </div>
        <footer className="main-footer"><span>Axonkey 仅修改 RC003 遥控器输入，不影响普通键盘。</span><span className="footer-key"><Command size={12} /> 本地配置</span></footer>
      </main>
      {toast && <div className="toast"><Check size={15} /> {toast}</div>}
      {coordinateSnippet && <div className="coordinate-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) setCoordinateSnippet('') }}>
        <section className="coordinate-dialog" role="dialog" aria-modal="true" aria-labelledby="coordinate-title">
          <div className="coordinate-dialog-head"><div><span className="section-kicker">DEBUG POSITION</span><h2 id="coordinate-title">坐标已生成</h2></div><button type="button" className="dialog-close" aria-label="关闭" onClick={() => setCoordinateSnippet('')}><X size={16} /></button></div>
          <p>文本框已经自动选中，按 Ctrl+C 后粘贴发给我，或替换 App.tsx 中的 initialHitPositions。</p>
          <textarea ref={coordinateTextRef} value={coordinateSnippet} readOnly aria-label="定位坐标代码" />
          <div className="coordinate-dialog-actions"><button type="button" className="dialog-secondary" onClick={() => coordinateTextRef.current?.select()}><Copy size={14} /> 全选坐标</button><button type="button" className="button primary" onClick={() => setCoordinateSnippet('')}>完成</button></div>
        </section>
      </div>}
    </div>
  )
}

type MappingSideProps = {
  side: 'left' | 'right'
  buttons: RemoteButton[]
  mappings: Record<ButtonId, string>
  activeId: ButtonId
  capturing: ButtonId | null
  rowRefs: { current: Partial<Record<ButtonId, HTMLDivElement>> }
  setActiveId: (id: ButtonId) => void
  setCapturing: (id: ButtonId | null) => void
  updateMapping: (id: ButtonId, value: string) => void
}

function MappingSide({ side, buttons: sideButtons, mappings, activeId, capturing, rowRefs, setActiveId, setCapturing, updateMapping }: MappingSideProps) {
  return <section className={`mapping-side panel-surface ${side}`}>
    <div className="mapping-list">
      {sideButtons.map((button) => (
        <MappingRow
          key={button.id}
          button={button}
          value={mappings[button.id]}
          active={activeId === button.id}
          capturing={capturing === button.id}
          rowRef={(node) => { if (node) rowRefs.current[button.id] = node }}
          onSelect={() => setActiveId(button.id)}
          onCapture={() => setCapturing(button.id)}
          onCancelCapture={() => setCapturing(null)}
          onKeyCapture={(event) => {
            const captured = formatCapturedKey(event)
            if (!captured) return
            event.preventDefault()
            updateMapping(button.id, captured)
            setCapturing(null)
          }}
          onChange={(value) => updateMapping(button.id, value)}
        />
      ))}
    </div>
  </section>
}

type MappingRowProps = {
  button: RemoteButton
  value: string
  active: boolean
  capturing: boolean
  rowRef: (node: HTMLDivElement | null) => void
  onSelect: () => void
  onCapture: () => void
  onCancelCapture: () => void
  onKeyCapture: (event: KeyboardEvent<HTMLInputElement>) => void
  onChange: (value: string) => void
}

function MappingRow({ button, value, active, capturing, rowRef, onSelect, onCapture, onCancelCapture, onKeyCapture, onChange }: MappingRowProps) {
  return <article ref={rowRef} className={`mapping-card ${active ? 'active' : ''}`} onClick={onSelect}>
    <div className="mapping-card-title"><span className={`row-icon icon-${button.icon}`}>{iconFor(button.icon, 17)}</span><strong>{button.label}</strong><span className="card-status">{value === 'original' ? '默认' : '已设置'}</span></div>
    <div className="action-slots">
      <div className={`action-slot configured ${capturing ? 'capturing' : ''}`}>
        <span className="slot-label">单击</span>
        <Keyboard size={14} className="slot-icon" />
        <input
          value={capturing ? '按下组合键…' : displayAction(value)}
          aria-label={`${button.label}动作`}
          onFocus={onCapture}
          onClick={(event) => { event.stopPropagation(); onCapture() }}
          onChange={(event) => onChange(event.target.value)}
          onKeyDown={onKeyCapture}
          onBlur={onCancelCapture}
        />
        {capturing && <X size={13} className="slot-close" />}
      </div>
      <div className="action-slot muted"><span className="slot-label">双击</span><strong>未设置</strong></div>
      <div className="action-slot muted"><span className="slot-label">长按</span><strong>未设置</strong></div>
    </div>
  </article>
}

export default App
