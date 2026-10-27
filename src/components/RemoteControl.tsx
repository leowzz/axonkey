import { useEffect, useRef, useState } from 'react'
import type { ButtonId } from '../behaviorModel'
import type { RemoteButton } from '../appTypes'
import { remoteKeyRegions, remoteViewBox } from '../remoteControlGeometry'
import type { RemoteView } from '../devices/remoteTypes.ts'

type Props = {
  buttons: Pick<RemoteButton, 'id' | 'label'>[]
  activeId: ButtonId
  pressedId: ButtonId | null
  mappedIds: ButtonId[]
  onSelect: (id: ButtonId) => void
  remoteView?: RemoteView
}

const hintDismissedKey = 'axonkey.remote-interaction-hint.v1'
const xiaomiRemoteView: RemoteView = {
  buttons: [],
  viewBox: remoteViewBox,
  keyRegions: remoteKeyRegions,
  artworkUrl: '/rc003-remote-keymap.svg',
  ariaLabel: '小米 RC003 遥控器按键',
}

export function RemoteControl({
  buttons,
  activeId,
  pressedId,
  mappedIds,
  onSelect,
  remoteView = xiaomiRemoteView,
}: Props) {
  const [keyboardPressedId, setKeyboardPressedId] = useState<ButtonId | null>(null)
  const [pointerPressedId, setPointerPressedId] = useState<ButtonId | null>(null)
  const [hintDismissed, setHintDismissed] = useState(() => {
    try {
      return window.localStorage.getItem(hintDismissedKey) === '1'
    } catch {
      return false
    }
  })
  const spaceKeyRef = useRef<ButtonId | null>(null)

  useEffect(() => {
    if (typeof window === 'undefined') return
    const clearPress = () => {
      spaceKeyRef.current = null
      setKeyboardPressedId(null)
      setPointerPressedId(null)
    }
    const clearPointer = () => setPointerPressedId(null)
    const onVisibilityChange = () => {
      if (document.hidden) clearPress()
    }
    window.addEventListener('blur', clearPress)
    window.addEventListener('pointerup', clearPointer)
    window.addEventListener('pointercancel', clearPointer)
    document.addEventListener('visibilitychange', onVisibilityChange)
    return () => {
      window.removeEventListener('blur', clearPress)
      window.removeEventListener('pointerup', clearPointer)
      window.removeEventListener('pointercancel', clearPointer)
      document.removeEventListener('visibilitychange', onVisibilityChange)
    }
  }, [])

  const selectKey = (id: ButtonId) => {
    setHintDismissed(true)
    try {
      window.localStorage.setItem(hintDismissedKey, '1')
    } catch {
      /* Selection also works without storage. */
    }
    onSelect(id)
  }

  return (
    <div className="remote-control-view">
      <svg
        className="remote-control"
        viewBox={`0 0 ${remoteView.viewBox.width} ${remoteView.viewBox.height}`}
        role="group"
        aria-label={remoteView.ariaLabel}
      >
        <image
          href={remoteView.artworkUrl}
          width={remoteView.viewBox.width}
          height={remoteView.viewBox.height}
          aria-hidden="true"
          pointerEvents="none"
        />
        {buttons.map(button => (
          <g
            key={button.id}
            data-remote-key={button.id}
            role="button"
            tabIndex={0}
            aria-label={button.label}
            aria-pressed={activeId === button.id}
            className={`remote-key${activeId === button.id ? ' selected' : ''}${pressedId === button.id ? ' pressed' : ''}${mappedIds.includes(button.id) ? ' mapped' : ''}${keyboardPressedId === button.id ? ' keyboard-pressed' : ''}${pointerPressedId === button.id ? ' pointer-pressed' : ''}`}
            onClick={() => selectKey(button.id)}
            onPointerDown={event => {
              if (event.button === 0 && event.isPrimary) setPointerPressedId(button.id)
            }}
            onPointerUp={() => setPointerPressedId(null)}
            onPointerCancel={() => setPointerPressedId(null)}
            onPointerLeave={() => setPointerPressedId(null)}
            onBlur={() => {
              spaceKeyRef.current = null
              setKeyboardPressedId(null)
            }}
            onKeyDown={event => {
              if (event.key !== 'Enter' && event.key !== ' ') return
              event.preventDefault()
              event.stopPropagation()
              if (event.repeat) return
              setKeyboardPressedId(button.id)
              if (event.key === 'Enter') selectKey(button.id)
              else {
                spaceKeyRef.current = button.id
              }
            }}
            onKeyUp={event => {
              if (event.key !== 'Enter' && event.key !== ' ') return
              event.preventDefault()
              event.stopPropagation()
              const activate = event.key === ' ' && spaceKeyRef.current === button.id
              spaceKeyRef.current = null
              setKeyboardPressedId(null)
              if (activate) selectKey(button.id)
            }}
          >
            <title>{button.label}</title>
            <path className="remote-key-halo" d={remoteView.keyRegions[button.id].path} aria-hidden="true" />
            <path className="remote-key-outline" d={remoteView.keyRegions[button.id].path} aria-hidden="true" />
            <path className="remote-key-surface" d={remoteView.keyRegions[button.id].path} aria-hidden="true" />
          </g>
        ))}
      </svg>
      <p className={`remote-control-hint${hintDismissed ? ' dismissed' : ''}`} aria-hidden={hintDismissed}>
        点击按键配置动作
      </p>
    </div>
  )
}
