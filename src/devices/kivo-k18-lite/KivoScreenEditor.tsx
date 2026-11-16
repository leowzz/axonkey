import {
  useEffect,
  useId,
  useRef,
  useState,
  type CSSProperties,
  type ChangeEvent,
  type CompositionEvent,
} from 'react'
import { invoke } from '@tauri-apps/api/core'
import { ChevronDown } from 'lucide-react'
import {
  defaultDeviceDisplaySettings,
  defaultProfileDisplay,
  type DeviceDisplaySettings,
  type DeviceInstance,
  type InstanceProfile,
  type ProfileDisplayConfig,
} from '../integration/model'
import './KivoScreenEditor.css'

export const OLED_WIDTH = 128
export const OLED_HEIGHT = 32
export const OLED_LINE_STRIDE = OLED_WIDTH / 8
export const OLED_FRAME_BYTES = OLED_LINE_STRIDE * OLED_HEIGHT
const PIXEL_SCALE = 4

const sleepOptions = [
  { value: 30, label: '30 秒' },
  { value: 60, label: '1 分钟' },
  { value: 180, label: '3 分钟' },
  { value: 300, label: '5 分钟' },
  { value: 600, label: '10 分钟' },
  { value: 0, label: '从不' },
] as const

type Props = {
  instance: DeviceInstance
  profile: InstanceProfile
  applicationName?: string
  native: boolean
  onUpdate: (change: (item: DeviceInstance) => DeviceInstance) => void
}

type DisplayLineField = 'line1' | 'line2'

export function KivoScreenEditor({ instance, profile, applicationName, native, onUpdate }: Props) {
  const baseId = useId()
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const profileDisplay = profile.display ?? defaultProfileDisplay
  const deviceDisplay: DeviceDisplaySettings = { ...defaultDeviceDisplaySettings, ...instance.display }

  const [draftLines, setDraftLines] = useState({ line1: profileDisplay.line1, line2: profileDisplay.line2 })
  const [composing, setComposing] = useState({ line1: false, line2: false })
  const composingRef = useRef({ line1: false, line2: false })
  const pendingLineRef = useRef<{ line1: string | null; line2: string | null }>({ line1: null, line2: null })
  const lastProfileIdRef = useRef(profile.id)

  useEffect(() => {
    const profileSwitched = lastProfileIdRef.current !== profile.id
    if (profileSwitched) {
      lastProfileIdRef.current = profile.id
      composingRef.current = { line1: false, line2: false }
      pendingLineRef.current = { line1: null, line2: null }
      setComposing({ line1: false, line2: false })
      setDraftLines({ line1: profileDisplay.line1, line2: profileDisplay.line2 })
      return
    }
    setDraftLines(prev => {
      let nextLine1 = prev.line1
      let nextLine2 = prev.line2
      if (!composingRef.current.line1) {
        if (pendingLineRef.current.line1 === null || pendingLineRef.current.line1 === profileDisplay.line1) {
          pendingLineRef.current.line1 = null
          nextLine1 = profileDisplay.line1
        }
      }
      if (!composingRef.current.line2) {
        if (pendingLineRef.current.line2 === null || pendingLineRef.current.line2 === profileDisplay.line2) {
          pendingLineRef.current.line2 = null
          nextLine2 = profileDisplay.line2
        }
      }
      return nextLine1 === prev.line1 && nextLine2 === prev.line2 ? prev : { line1: nextLine1, line2: nextLine2 }
    })
  }, [profile.id, profileDisplay.line1, profileDisplay.line2])

  const previewTop = profileDisplay.mode === 'custom' ? draftLines.line1 : (applicationName ?? instance.name)
  const previewBottom = profileDisplay.mode === 'custom' ? draftLines.line2 : profile.name
  const isAnyComposing = composing.line1 || composing.line2
  const [nativeFrame, setNativeFrame] = useState<Uint8Array | null>(null)

  useEffect(() => {
    if (!native) {
      setNativeFrame(null)
      return
    }
    if (isAnyComposing) return
    let active = true
    const timer = setTimeout(() => {
      void invoke<number[]>('render_kivo_oled_preview', { line1: previewTop, line2: previewBottom })
        .then(bytes => {
          if (active && Array.isArray(bytes) && bytes.length === OLED_FRAME_BYTES) {
            setNativeFrame(Uint8Array.from(bytes))
          }
        })
        .catch(() => {
          if (active) setNativeFrame(null)
        })
    }, 60)
    return () => {
      active = false
      clearTimeout(timer)
    }
  }, [native, previewTop, previewBottom, isAnyComposing])

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas || typeof canvas.getContext !== 'function') return
    const frame = nativeFrame ?? rasterizeFallbackOledFrame(previewTop, previewBottom)
    if (frame) paintOledCanvas(canvas, frame, deviceDisplay.brightness)
  }, [nativeFrame, previewTop, previewBottom, deviceDisplay.brightness])

  const updateProfileDisplay = (patch: Partial<ProfileDisplayConfig>) => {
    onUpdate(item => ({
      ...item,
      profiles: item.profiles.map(p => {
        if (p.id !== profile.id) return p
        const current = p.display ?? defaultProfileDisplay
        return { ...p, display: { ...current, ...patch } }
      }),
    }))
  }

  const commitLine = (field: DisplayLineField, rawValue: string) => {
    const clamped = rawValue.slice(0, 64)
    setDraftLines(prev => (prev[field] === clamped ? prev : { ...prev, [field]: clamped }))
    const baseline = pendingLineRef.current[field] ?? profileDisplay[field]
    if (clamped === baseline) return
    pendingLineRef.current[field] = clamped
    updateProfileDisplay({ [field]: clamped })
  }

  const handleLineCompositionStart = (field: DisplayLineField) => {
    composingRef.current[field] = true
    setComposing(prev => (prev[field] ? prev : { ...prev, [field]: true }))
  }

  const handleLineChange = (field: DisplayLineField, event: ChangeEvent<HTMLInputElement>) => {
    const value = event.target.value
    const nativeComposing = Boolean((event.nativeEvent as InputEvent | undefined)?.isComposing)
    if (composingRef.current[field] || nativeComposing) {
      setDraftLines(prev => (prev[field] === value ? prev : { ...prev, [field]: value }))
      return
    }
    commitLine(field, value)
  }

  const handleLineCompositionEnd = (field: DisplayLineField, event: CompositionEvent<HTMLInputElement>) => {
    composingRef.current[field] = false
    setComposing(prev => (prev[field] ? { ...prev, [field]: false } : prev))
    commitLine(field, event.currentTarget.value)
  }

  const handleLineBlur = (field: DisplayLineField, rawValue: string) => {
    if (!composingRef.current[field]) return
    composingRef.current[field] = false
    setComposing(prev => (prev[field] ? { ...prev, [field]: false } : prev))
    commitLine(field, rawValue)
  }

  const updateDeviceDisplay = (patch: Partial<DeviceDisplaySettings>) => {
    onUpdate(item => ({
      ...item,
      display: { ...defaultDeviceDisplaySettings, ...item.display, ...patch },
    }))
  }

  const previewSummary = [previewTop.trim(), previewBottom.trim()].filter(Boolean).join(' / ') || '空白'
  const hasCustomSleepValue = !sleepOptions.some(option => option.value === deviceDisplay.sleepTimeoutSec)

  return (
    <section className="kivo-screen-editor" aria-label="OLED 屏幕设置">
      <header className="kivo-screen-editor-head">
        <h2>OLED 屏幕</h2>
      </header>

      <div className="kivo-oled-preview" role="img" aria-label={`OLED 屏幕预览：${previewSummary}`}>
        <canvas
          ref={canvasRef}
          className="kivo-oled-preview-canvas"
          width={OLED_WIDTH * PIXEL_SCALE}
          height={OLED_HEIGHT * PIXEL_SCALE}
          aria-hidden="true"
        />
      </div>

      <div className="settings-form-fields">
        <div className="settings-form-row">
          <span id={`${baseId}-mode-label`} className="settings-form-label">
            显示内容：
          </span>
          <div className="settings-form-control">
            <div className="kivo-screen-mode-tabs" role="radiogroup" aria-labelledby={`${baseId}-mode-label`}>
              <button
                type="button"
                role="radio"
                aria-checked={profileDisplay.mode === 'auto'}
                onClick={() => updateProfileDisplay({ mode: 'auto' })}
              >
                自动状态
              </button>
              <button
                type="button"
                role="radio"
                aria-checked={profileDisplay.mode === 'custom'}
                onClick={() => updateProfileDisplay({ mode: 'custom' })}
              >
                自定义文本
              </button>
            </div>
          </div>
        </div>

        {profileDisplay.mode === 'custom' && (
          <>
            <div className="settings-form-row">
              <label className="settings-form-label" htmlFor={`${baseId}-line1`}>
                第一行：
              </label>
              <div className="settings-form-control">
                <input
                  id={`${baseId}-line1`}
                  className="kivo-screen-text-input"
                  type="text"
                  placeholder={applicationName ?? instance.name}
                  value={draftLines.line1}
                  onCompositionStart={() => handleLineCompositionStart('line1')}
                  onCompositionEnd={event => handleLineCompositionEnd('line1', event)}
                  onBlur={event => handleLineBlur('line1', event.currentTarget.value)}
                  onChange={event => handleLineChange('line1', event)}
                />
              </div>
            </div>
            <div className="settings-form-row">
              <label className="settings-form-label" htmlFor={`${baseId}-line2`}>
                第二行：
              </label>
              <div className="settings-form-control">
                <input
                  id={`${baseId}-line2`}
                  className="kivo-screen-text-input"
                  type="text"
                  placeholder={profile.name}
                  value={draftLines.line2}
                  onCompositionStart={() => handleLineCompositionStart('line2')}
                  onCompositionEnd={event => handleLineCompositionEnd('line2', event)}
                  onBlur={event => handleLineBlur('line2', event.currentTarget.value)}
                  onChange={event => handleLineChange('line2', event)}
                />
              </div>
            </div>
          </>
        )}

        <div className="settings-form-row">
          <label className="settings-form-label" htmlFor={`${baseId}-brightness`}>
            屏幕亮度：
          </label>
          <div className="settings-form-control">
            <div className="settings-sensitivity-control">
              <input
                id={`${baseId}-brightness`}
                type="range"
                min={0}
                max={100}
                step={1}
                style={{ '--sensitivity-progress': `${deviceDisplay.brightness}%` } as CSSProperties}
                aria-valuetext={`${deviceDisplay.brightness}%`}
                value={deviceDisplay.brightness}
                onChange={event => updateDeviceDisplay({ brightness: Number(event.target.value) })}
              />
              <output htmlFor={`${baseId}-brightness`}>
                {deviceDisplay.brightness}
                <span>%</span>
              </output>
            </div>
          </div>
        </div>

        <div className="settings-form-row">
          <label className="settings-form-label" htmlFor={`${baseId}-sleep`}>
            自动息屏：
          </label>
          <div className="settings-form-control">
            <span className="manual-key-select kivo-screen-select">
              <select
                id={`${baseId}-sleep`}
                value={deviceDisplay.sleepTimeoutSec}
                onChange={event => updateDeviceDisplay({ sleepTimeoutSec: Number(event.target.value) })}
              >
                {hasCustomSleepValue && (
                  <option value={deviceDisplay.sleepTimeoutSec}>{deviceDisplay.sleepTimeoutSec} 秒</option>
                )}
                {sleepOptions.map(option => (
                  <option key={option.value} value={option.value}>
                    {option.label}
                  </option>
                ))}
              </select>
              <span className="manual-key-select-icon" aria-hidden="true">
                <ChevronDown size={14} />
              </span>
            </span>
          </div>
        </div>

        <div className="settings-form-row">
          <span className="settings-form-label">瞬态提示：</span>
          <div className="settings-form-control kivo-screen-checkboxes">
            <label className="settings-checkbox">
              <input
                type="checkbox"
                checked={deviceDisplay.showKeyToast}
                onChange={event => updateDeviceDisplay({ showKeyToast: event.target.checked })}
              />
              按键触发提示
            </label>
            <label className="settings-checkbox">
              <input
                type="checkbox"
                checked={deviceDisplay.showProfileToast}
                onChange={event => updateDeviceDisplay({ showProfileToast: event.target.checked })}
              />
              切换配置提示
            </label>
          </div>
        </div>
      </div>
    </section>
  )
}

export function decodeOled1bppPixel(frame: ArrayLike<number>, x: number, y: number): boolean {
  if (x < 0 || x >= OLED_WIDTH || y < 0 || y >= OLED_HEIGHT) return false
  return (frame[y * OLED_LINE_STRIDE + (x >> 3)] & (0x80 >> (x & 7))) !== 0
}

function rasterizeFallbackOledFrame(line1: string, line2: string): Uint8Array | null {
  if (typeof document === 'undefined' || typeof document.createElement !== 'function') return null
  const surface = document.createElement('canvas')
  surface.width = OLED_WIDTH
  surface.height = OLED_HEIGHT
  const ctx = surface.getContext?.('2d', { willReadFrequently: true })
  if (!ctx) return null
  ctx.fillStyle = '#000'
  ctx.fillRect(0, 0, OLED_WIDTH, OLED_HEIGHT)
  ctx.fillStyle = '#fff'
  ctx.font = "600 11.5px system-ui, -apple-system, 'Segoe UI', 'PingFang SC', 'Microsoft YaHei', sans-serif"
  ctx.textBaseline = 'middle'
  drawClippedLine(ctx, line1.trim(), 0)
  drawClippedLine(ctx, line2.trim(), 16)
  const pixels = ctx.getImageData(0, 0, OLED_WIDTH, OLED_HEIGHT).data
  const frame = new Uint8Array(OLED_FRAME_BYTES)
  for (let y = 0; y < OLED_HEIGHT; y++) {
    for (let x = 0; x < OLED_WIDTH; x++) {
      if (pixels[(y * OLED_WIDTH + x) * 4] >= 104) {
        frame[y * OLED_LINE_STRIDE + (x >> 3)] |= 0x80 >> (x & 7)
      }
    }
  }
  return frame
}

function drawClippedLine(ctx: CanvasRenderingContext2D, text: string, bandTop: number) {
  if (!text) return
  ctx.save()
  ctx.beginPath()
  ctx.rect(2, bandTop, OLED_WIDTH - 4, 16)
  ctx.clip()
  ctx.fillText(text, 2, bandTop + 8.5)
  ctx.restore()
}

function paintOledCanvas(canvas: HTMLCanvasElement, frame: ArrayLike<number>, brightness: number) {
  const ctx = canvas.getContext('2d')
  if (!ctx) return
  const width = OLED_WIDTH * PIXEL_SCALE
  const height = OLED_HEIGHT * PIXEL_SCALE
  ctx.fillStyle = '#05080d'
  ctx.fillRect(0, 0, width, height)
  ctx.fillStyle = 'rgba(148, 163, 184, 0.055)'
  const dot = PIXEL_SCALE - 1
  for (let y = 0; y < OLED_HEIGHT; y++) {
    const py = y * PIXEL_SCALE
    for (let x = 0; x < OLED_WIDTH; x++) {
      ctx.fillRect(x * PIXEL_SCALE, py, dot, dot)
    }
  }
  const alpha = 0.28 + (Math.max(0, Math.min(100, brightness)) / 100) * 0.72
  ctx.fillStyle = `rgba(240, 249, 255, ${alpha.toFixed(3)})`
  for (let y = 0; y < OLED_HEIGHT; y++) {
    const py = y * PIXEL_SCALE
    for (let x = 0; x < OLED_WIDTH; x++) {
      if (decodeOled1bppPixel(frame, x, y)) {
        ctx.fillRect(x * PIXEL_SCALE, py, dot, dot)
      }
    }
  }
}
