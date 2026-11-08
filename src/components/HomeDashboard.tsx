import { useEffect, useRef, type ReactNode, type RefObject } from 'react'
import { X } from 'lucide-react'
import './HomeDashboard.css'

type HomeDashboardProps = {
  deviceContent: ReactNode
  nativeRuntime: boolean
  microphoneDriverAbnormal: boolean
  microphoneDriverWarningSuppressed: boolean
  onDismissMicrophoneDriverWarning: () => void | Promise<void>
  onOpenAudioDriver: () => void
  settingsButtonRef: RefObject<HTMLButtonElement>
}

export function HomeDashboard({
  deviceContent,
  nativeRuntime,
  microphoneDriverAbnormal,
  microphoneDriverWarningSuppressed,
  onDismissMicrophoneDriverWarning,
  onOpenAudioDriver,
  settingsButtonRef,
}: HomeDashboardProps) {
  const warningRef = useRef<HTMLDivElement>(null)
  const closingAnimation = useRef<Animation | null>(null)

  useEffect(() => () => closingAnimation.current?.cancel(), [])

  const dismissWarning = async () => {
    if (closingAnimation.current) return
    const warning = warningRef.current
    const settings = settingsButtonRef.current
    const restoreFocus = warning?.contains(document.activeElement)
    if (warning && settings && !window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
      const from = warning.getBoundingClientRect()
      const to = settings.getBoundingClientRect()
      const scale = Math.min(to.width / from.width, to.height / from.height)
      const x = to.left + to.width / 2 - from.left - (from.width * scale) / 2
      const y = to.top + to.height / 2 - from.top - (from.height * scale) / 2
      warning.dataset.closing = 'true'
      warning.inert = true
      const animation = warning.animate(
        [
          { transform: 'translate(0, 0) scale(1)', opacity: 1, borderRadius: '0px' },
          {
            offset: 0.5,
            transform: `translate(${x * 0.65}px, ${y * 0.3}px) scale(0.45)`,
            opacity: 0.95,
            borderRadius: '12px',
          },
          { offset: 0.9, opacity: 0.85 },
          { transform: `translate(${x}px, ${y}px) scale(${scale})`, opacity: 0, borderRadius: '16px' },
        ],
        { duration: 520, easing: 'cubic-bezier(0.4, 0, 0.2, 1)', fill: 'forwards' },
      )
      closingAnimation.current = animation
      try {
        await animation.finished
      } catch {
        return
      }
      settings.animate([{ boxShadow: '0 0 0 5px rgb(121 90 35 / 22%)' }, { boxShadow: '0 0 0 0 transparent' }], {
        duration: 280,
        easing: 'ease-out',
      })
    }
    await onDismissMicrophoneDriverWarning()
    if (restoreFocus) settings?.focus({ preventScroll: true })
    closingAnimation.current?.cancel()
    closingAnimation.current = null
    if (warning) {
      delete warning.dataset.closing
      warning.inert = false
    }
  }

  return (
    <div className="home-page">
      {nativeRuntime && microphoneDriverAbnormal && !microphoneDriverWarningSuppressed && (
        <div ref={warningRef} className="home-microphone-warning" role="alert">
          <span>虚拟麦克风驱动异常，这会导致遥控器无语音功能。</span>
          <button type="button" className="home-utility-button" onClick={onOpenAudioDriver}>
            Quarbor 虚拟麦克风驱动
          </button>
          <button
            type="button"
            className="home-microphone-warning-close"
            aria-label="关闭麦克风驱动异常提醒"
            title="关闭本次提醒"
            onClick={() => void dismissWarning()}
          >
            <X size={16} aria-hidden="true" />
          </button>
        </div>
      )}
      {deviceContent}
    </div>
  )
}
