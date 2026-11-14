import { useRef, useState, type ChangeEvent, type CSSProperties, type DragEvent, type KeyboardEvent } from 'react'
import { Download, FileCode2, FolderOpen, Layers, Radio, Trash2, Link2 } from 'lucide-react'
import {
  formatHexShort,
  formatReportIdHex,
  type CapturedKeySample,
  type DiscoveredProbeButton,
  type ParsedCaptureDraft,
  type SanitizedCaptureSvg,
} from './model'

export type RawCaptureFrameItem = {
  sequence: number
  reportId: number
  hex: string
  isStreamingNoise: boolean
}

export type CaptureSvgStageProps = {
  stageMode: 'svg' | 'probe'
  onStageModeChange: (mode: 'svg' | 'probe') => void
  sanitizedSvg: SanitizedCaptureSvg | null
  draft: ParsedCaptureDraft | null
  svgFileName: string | null
  svgError: string
  samples: ReadonlyMap<string, CapturedKeySample>
  armedInputId: string | null
  bindTargetInputId?: string | null
  livePressedIds: ReadonlySet<string>
  collisionIds: ReadonlySet<string>
  armedInputLabel?: string | null
  onSelectKey: (inputId: string) => void
  onLoadSvgText: (svgText: string, fileName: string) => Promise<void> | void
  rawFrames: readonly RawCaptureFrameItem[]
  discoveredProbeButtons: readonly DiscoveredProbeButton[]
  hideStreamingNoise: boolean
  onToggleHideStreamingNoise: (next: boolean) => void
  onClearProbe: () => void
  onExportRawProbeJson: () => void
  onBindProbeToArmedKey?: (probe: DiscoveredProbeButton) => void
}

export function CaptureSvgStage({
  stageMode,
  onStageModeChange,
  sanitizedSvg,
  draft,
  svgFileName,
  svgError,
  samples,
  armedInputId,
  bindTargetInputId,
  livePressedIds,
  collisionIds,
  armedInputLabel,
  onSelectKey,
  onLoadSvgText,
  rawFrames,
  discoveredProbeButtons,
  hideStreamingNoise,
  onToggleHideStreamingNoise,
  onClearProbe,
  onExportRawProbeJson,
  onBindProbeToArmedKey,
}: CaptureSvgStageProps) {
  const fileInputRef = useRef<HTMLInputElement>(null)
  const [dragging, setDragging] = useState(false)
  const [showPendingOutlines, setShowPendingOutlines] = useState(true)

  const handleFileChange = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0]
    event.target.value = ''
    if (!file) return
    const content = await file.text()
    await onLoadSvgText(content, file.name)
  }

  const handleDrop = async (event: DragEvent<HTMLElement>) => {
    event.preventDefault()
    setDragging(false)
    const file = [...(event.dataTransfer?.files ?? [])].find(item => /\.svg$/i.test(item.name))
    if (!file) return
    const content = await file.text()
    onStageModeChange('svg')
    await onLoadSvgText(content, file.name)
  }

  const handleHotzoneKeyDown = (event: KeyboardEvent<SVGGElement>, inputId: string) => {
    if (event.key !== 'Enter' && event.key !== ' ') return
    event.preventDefault()
    event.stopPropagation()
    onSelectKey(inputId)
  }

  const visibleFrames = hideStreamingNoise ? rawFrames.filter(frame => !frame.isStreamingNoise) : rawFrames

  const totalInputs = draft?.inputs.length ?? sanitizedSvg?.hotzones.length ?? 0
  const adaptedCount = draft ? draft.inputs.filter(item => samples.has(item.id)).length : samples.size

  return (
    <section
      className={`capture-stage-panel${dragging ? ' is-dragging' : ''}`}
      aria-label="设备图稿与原始探针舞台"
      onDragOver={event => {
        event.preventDefault()
        setDragging(true)
      }}
      onDragLeave={event => {
        if (event.currentTarget === event.target) setDragging(false)
      }}
      onDrop={event => void handleDrop(event)}
    >
      <input
        ref={fileInputRef}
        type="file"
        accept=".svg,image/svg+xml"
        hidden
        aria-label="选择设备 SVG 图稿文件"
        onChange={event => void handleFileChange(event)}
      />

      <header className="capture-stage-header">
        <div className="capture-stage-mode-tabs" role="tablist" aria-label="舞台视图模式">
          <button
            type="button"
            role="tab"
            aria-selected={stageMode === 'svg'}
            className={`capture-mode-tab${stageMode === 'svg' ? ' active' : ''}`}
            onClick={() => onStageModeChange('svg')}
          >
            <FileCode2 size={14} aria-hidden="true" />
            图稿热区
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={stageMode === 'probe'}
            className={`capture-mode-tab${stageMode === 'probe' ? ' active' : ''}`}
            onClick={() => onStageModeChange('probe')}
          >
            <Radio size={14} aria-hidden="true" />
            无图探针
            {discoveredProbeButtons.length > 0 && (
              <span className="capture-tab-count">{discoveredProbeButtons.length}</span>
            )}
          </button>
        </div>

        {stageMode === 'svg' ? (
          <div className="capture-stage-tools">
            {totalInputs > 0 && (
              <span className="capture-progress-pill" aria-live="polite">
                已适配 {adaptedCount} / {totalInputs}
              </span>
            )}
            {sanitizedSvg && (
              <button
                type="button"
                className="capture-tool-button"
                aria-pressed={showPendingOutlines}
                onClick={() => setShowPendingOutlines(current => !current)}
              >
                <Layers size={13} aria-hidden="true" />
                热区虚线
              </button>
            )}
            <button type="button" className="capture-tool-button" onClick={() => fileInputRef.current?.click()}>
              <FolderOpen size={13} aria-hidden="true" />
              {sanitizedSvg ? '更换 SVG' : '打开 SVG'}
            </button>
          </div>
        ) : (
          <div className="capture-stage-tools">
            <label className="capture-inline-check">
              <input
                type="checkbox"
                checked={hideStreamingNoise}
                onChange={event => onToggleHideStreamingNoise(event.target.checked)}
              />
              <span>过滤流噪声</span>
            </label>
            <button
              type="button"
              className="capture-tool-button"
              disabled={rawFrames.length === 0 && discoveredProbeButtons.length === 0}
              onClick={onClearProbe}
              aria-label="清空探针记录"
            >
              <Trash2 size={13} aria-hidden="true" />
              清空
            </button>
            <button
              type="button"
              className="capture-tool-button"
              disabled={rawFrames.length === 0 && discoveredProbeButtons.length === 0}
              onClick={onExportRawProbeJson}
            >
              <Download size={13} aria-hidden="true" />
              导出 JSON
            </button>
          </div>
        )}
      </header>

      {svgError && stageMode === 'svg' && (
        <p className="capture-inline-error" role="alert">
          {svgError}
        </p>
      )}

      {stageMode === 'svg' ? (
        <div className={`capture-svg-canvas${showPendingOutlines ? ' show-pending-outlines' : ''}`}>
          {sanitizedSvg ? (
            <div
              className="capture-svg-viewport"
              style={
                {
                  '--capture-svg-aspect': `${sanitizedSvg.viewBox.width} / ${sanitizedSvg.viewBox.height}`,
                  '--capture-svg-ratio': String(sanitizedSvg.viewBox.width / sanitizedSvg.viewBox.height),
                } as CSSProperties
              }
            >
              <svg
                className="capture-svg-element"
                width={sanitizedSvg.viewBox.width}
                height={sanitizedSvg.viewBox.height}
                viewBox={`${sanitizedSvg.viewBox.x} ${sanitizedSvg.viewBox.y} ${sanitizedSvg.viewBox.width} ${sanitizedSvg.viewBox.height}`}
                role="group"
                aria-label={`${draft?.displayName ?? svgFileName ?? '设备'} 按键热区`}
              >
                <image
                  href={sanitizedSvg.artworkDataUrl}
                  x={sanitizedSvg.viewBox.x}
                  y={sanitizedSvg.viewBox.y}
                  width={sanitizedSvg.viewBox.width}
                  height={sanitizedSvg.viewBox.height}
                  pointerEvents="none"
                  aria-hidden="true"
                />
                {sanitizedSvg.hotzones.map(zone => {
                  const isLive = livePressedIds.has(zone.id)
                  const isArmed = armedInputId === zone.id
                  const isCaptured = samples.has(zone.id)
                  const hasCollision = collisionIds.has(zone.id)
                  const visualState = isLive ? 'live' : isArmed ? 'armed' : isCaptured ? 'captured' : 'pending'
                  return (
                    <g
                      key={zone.id}
                      data-capture-key={zone.id}
                      data-state={visualState}
                      data-collision={hasCollision || undefined}
                      role="button"
                      tabIndex={0}
                      aria-label={zone.label}
                      aria-pressed={isArmed}
                      className={`capture-hotzone is-${visualState}${hasCollision ? ' is-collision' : ''}`}
                      onClick={() => onSelectKey(zone.id)}
                      onKeyDown={event => handleHotzoneKeyDown(event, zone.id)}
                    >
                      <title>
                        {zone.label}
                        {isCaptured ? ` · ${samples.get(zone.id)?.pressHex ?? ''}` : ''}
                      </title>
                      <path
                        className="capture-hotzone-halo"
                        d={zone.path}
                        transform={zone.transform}
                        aria-hidden="true"
                      />
                      <path
                        className="capture-hotzone-shape"
                        d={zone.path}
                        transform={zone.transform}
                        aria-hidden="true"
                      />
                    </g>
                  )
                })}
              </svg>
            </div>
          ) : (
            <div className="capture-svg-empty">
              <FileCode2 size={28} aria-hidden="true" />
              <strong>拖入或选择 .svg 设备图稿</strong>
              <div className="capture-svg-empty-actions">
                <button type="button" className="capture-btn-primary" onClick={() => fileInputRef.current?.click()}>
                  <FolderOpen size={14} aria-hidden="true" />
                  选择 SVG 图稿
                </button>
                <button type="button" className="capture-btn-secondary" onClick={() => onStageModeChange('probe')}>
                  <Radio size={14} aria-hidden="true" />
                  无图探针测键
                </button>
              </div>
            </div>
          )}
        </div>
      ) : (
        <div className="capture-probe-body">
          <section className="capture-probe-discovered" aria-label="探针发现的按键">
            <div className="capture-subpanel-head">
              <strong>按键特征 ({discoveredProbeButtons.length})</strong>
              {(bindTargetInputId ?? armedInputId) && armedInputLabel && (
                <span className="capture-subpanel-meta">当前目标：{armedInputLabel}</span>
              )}
            </div>
            {discoveredProbeButtons.length === 0 ? (
              <p className="capture-empty-hint">连接设备会话后按下实体按键，此处自动归纳非空按键帧</p>
            ) : (
              <div className="capture-probe-grid">
                {discoveredProbeButtons.map(probe => (
                  <div key={probe.key} className="capture-probe-card">
                    <div className="capture-probe-card-top">
                      <strong>{probe.label}</strong>
                      <span className="capture-hex-chip">
                        {formatReportIdHex(probe.reportId)} · ×{probe.hitCount}
                      </span>
                    </div>
                    <code className="capture-probe-hex" title={probe.pressHex}>
                      {formatHexShort(probe.pressHex, 8)}
                    </code>
                    {(bindTargetInputId ?? armedInputId) && onBindProbeToArmedKey && (
                      <button
                        type="button"
                        className="capture-probe-bind"
                        onClick={() => onBindProbeToArmedKey(probe)}
                        aria-label={`绑定 ${probe.label} 到 ${armedInputLabel ?? bindTargetInputId ?? armedInputId}`}
                      >
                        <Link2 size={12} aria-hidden="true" />
                        绑定到 {armedInputLabel ?? bindTargetInputId ?? armedInputId}
                      </button>
                    )}
                  </div>
                ))}
              </div>
            )}
          </section>

          <section className="capture-probe-stream" aria-label="实时原始 HID 报文">
            <div className="capture-subpanel-head">
              <strong>原始报文流 ({visibleFrames.length})</strong>
            </div>
            {visibleFrames.length === 0 ? (
              <p className="capture-empty-hint">暂无报文</p>
            ) : (
              <div className="capture-frame-list" role="log" aria-live="off">
                {visibleFrames.map(frame => (
                  <div key={frame.sequence} className={`capture-frame-row${frame.isStreamingNoise ? ' is-noise' : ''}`}>
                    <span className="capture-frame-seq">#{frame.sequence}</span>
                    <span className="capture-frame-rid">{formatReportIdHex(frame.reportId)}</span>
                    <code className="capture-frame-hex">{frame.hex}</code>
                    {frame.isStreamingNoise && <span className="capture-noise-tag">持续流</span>}
                  </div>
                ))}
              </div>
            )}
          </section>
        </div>
      )}

      {stageMode === 'svg' && sanitizedSvg && (
        <footer className="capture-stage-legend" aria-label="热区状态图例">
          <span className="capture-legend-item is-pending">待采集</span>
          <span className="capture-legend-item is-armed">当前选中</span>
          <span className="capture-legend-item is-captured">已采集</span>
          <span className="capture-legend-item is-live">实机按下</span>
          {svgFileName && <span className="capture-stage-filename">{svgFileName}</span>}
        </footer>
      )}
    </section>
  )
}
