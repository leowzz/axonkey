import { useRef, useState, type ChangeEvent, type CSSProperties, type DragEvent, type KeyboardEvent } from 'react'
import { FileCode2, FolderOpen, Layers } from 'lucide-react'
import {
  HID_EVENT_DRAG_MIME,
  isInputDefined,
  type CapturedKeySample,
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
  sanitizedSvg: SanitizedCaptureSvg | null
  draft: ParsedCaptureDraft | null
  svgFileName: string | null
  svgError: string
  samples: ReadonlyMap<string, CapturedKeySample>
  armedInputId: string | null
  selectedInputId?: string | null
  livePressedIds: ReadonlySet<string>
  liveReleasedIds?: ReadonlySet<string>
  lastLiveTransition?: { label: string; pressed: boolean } | null
  collisionIds: ReadonlySet<string>
  draggingHidEventId?: string | null
  onSelectKey: (inputId: string) => void
  onDropHidEventOnKey?: (inputId: string, eventId: string) => void
  onLoadSvgText: (svgText: string, fileName: string) => Promise<void> | void
}

export function CaptureSvgStage({
  sanitizedSvg,
  draft,
  svgFileName,
  svgError,
  samples,
  armedInputId,
  selectedInputId,
  livePressedIds,
  liveReleasedIds,
  lastLiveTransition,
  collisionIds,
  draggingHidEventId,
  onSelectKey,
  onDropHidEventOnKey,
  onLoadSvgText,
}: CaptureSvgStageProps) {
  const fileInputRef = useRef<HTMLInputElement>(null)
  const [fileDragging, setFileDragging] = useState(false)
  const [dropTargetId, setDropTargetId] = useState<string | null>(null)
  const [showPendingOutlines, setShowPendingOutlines] = useState(true)

  const isHidEventDrag = (event: DragEvent) =>
    Boolean(draggingHidEventId) || Boolean(event.dataTransfer?.types?.includes(HID_EVENT_DRAG_MIME))

  const handleFileChange = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0]
    event.target.value = ''
    if (!file) return
    const content = await file.text()
    await onLoadSvgText(content, file.name)
  }

  const handleStageDrop = async (event: DragEvent<HTMLElement>) => {
    if (isHidEventDrag(event)) {
      setDropTargetId(null)
      return
    }
    event.preventDefault()
    setFileDragging(false)
    const file = [...(event.dataTransfer?.files ?? [])].find(item => /\.svg$/i.test(item.name))
    if (!file) return
    const content = await file.text()
    await onLoadSvgText(content, file.name)
  }

  const handleHotzoneKeyDown = (event: KeyboardEvent<SVGGElement>, inputId: string) => {
    if (event.key !== 'Enter' && event.key !== ' ') return
    event.preventDefault()
    event.stopPropagation()
    onSelectKey(inputId)
  }

  const totalInputs = draft?.inputs.length ?? sanitizedSvg?.hotzones.length ?? 0
  const adaptedCount = draft ? draft.inputs.filter(item => isInputDefined(item, samples)).length : samples.size

  return (
    <section
      className={`capture-stage-panel${fileDragging ? ' is-dragging' : ''}${draggingHidEventId ? ' is-event-dragging' : ''}`}
      aria-label="SVG 示意图舞台"
      onDragOver={event => {
        if (isHidEventDrag(event)) return
        event.preventDefault()
        setFileDragging(true)
      }}
      onDragLeave={event => {
        if (event.currentTarget === event.target) {
          setFileDragging(false)
          setDropTargetId(null)
        }
      }}
      onDrop={event => void handleStageDrop(event)}
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
        <div className="capture-stage-title-group">
          <strong className="capture-panel-title">SVG 示意图</strong>
          {totalInputs > 0 && (
            <span className="capture-progress-pill" aria-live="polite">
              已适配 {adaptedCount} / {totalInputs}
            </span>
          )}
          {lastLiveTransition && (
            <span
              className={`capture-live-stage-pill ${lastLiveTransition.pressed ? 'is-down' : 'is-up'}`}
              role="status"
            >
              {lastLiveTransition.label} · {lastLiveTransition.pressed ? '按下' : '抬起'}
            </span>
          )}
        </div>

        <div className="capture-stage-tools">
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
      </header>

      {svgError && (
        <p className="capture-inline-error" role="alert">
          {svgError}
        </p>
      )}

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
                const isReleased = !isLive && Boolean(liveReleasedIds?.has(zone.id))
                const isArmed = armedInputId === zone.id
                const isSelected = selectedInputId === zone.id
                const isDropTarget = dropTargetId === zone.id
                const sample = samples.get(zone.id)
                const draftInput = draft?.inputs.find(item => item.id === zone.id)
                const isCaptured = draftInput ? isInputDefined(draftInput, samples) : Boolean(sample)
                const hasCollision = collisionIds.has(zone.id)
                const visualState = isLive ? 'live' : isArmed ? 'armed' : isCaptured ? 'captured' : 'pending'
                const livePhase = isLive ? 'pressed' : isReleased ? 'released' : undefined
                return (
                  <g
                    key={zone.id}
                    data-capture-key={zone.id}
                    data-state={visualState}
                    data-live-phase={livePhase}
                    data-drop-target={isDropTarget || undefined}
                    data-collision={hasCollision || undefined}
                    role="button"
                    tabIndex={0}
                    aria-label={zone.label}
                    aria-pressed={isArmed || isSelected}
                    className={`capture-hotzone is-${visualState}${isSelected && !isArmed ? ' is-selected' : ''}${isDropTarget ? ' is-drop-target' : ''}${isReleased ? ' is-released' : ''}${hasCollision ? ' is-collision' : ''}`}
                    onClick={() => onSelectKey(zone.id)}
                    onKeyDown={event => handleHotzoneKeyDown(event, zone.id)}
                    onDragOver={event => {
                      if (!onDropHidEventOnKey || !isHidEventDrag(event)) return
                      event.preventDefault()
                      event.stopPropagation()
                      if (event.dataTransfer) event.dataTransfer.dropEffect = 'copy'
                      if (dropTargetId !== zone.id) setDropTargetId(zone.id)
                    }}
                    onDragLeave={() => {
                      if (dropTargetId === zone.id) setDropTargetId(null)
                    }}
                    onDrop={event => {
                      if (!onDropHidEventOnKey) return
                      const droppedId = event.dataTransfer?.getData(HID_EVENT_DRAG_MIME) || draggingHidEventId || ''
                      if (!droppedId) return
                      event.preventDefault()
                      event.stopPropagation()
                      setDropTargetId(null)
                      setFileDragging(false)
                      onDropHidEventOnKey(zone.id, droppedId)
                    }}
                  >
                    <title>
                      {zone.label}
                      {sample ? ` · ↓ ${sample.pressHex}${sample.releaseHex ? ` / ↑ ${sample.releaseHex}` : ''}` : ''}
                      {sample?.sourceDeviceName ? ` (${sample.sourceDeviceName})` : ''}
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
                选择本地 SVG
              </button>
            </div>
          </div>
        )}
      </div>

      {sanitizedSvg && (
        <footer className="capture-stage-legend" aria-label="热区状态图例">
          <span className="capture-legend-item is-pending">待采集</span>
          <span className="capture-legend-item is-armed">监听中</span>
          <span className="capture-legend-item is-captured">已适配</span>
          <span className="capture-legend-item is-live">按下</span>
          {liveReleasedIds && <span className="capture-legend-item is-released">已抬起</span>}
          {svgFileName && <span className="capture-stage-filename">{svgFileName}</span>}
        </footer>
      )}
    </section>
  )
}
