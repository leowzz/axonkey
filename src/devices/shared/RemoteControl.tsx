import { useEffect, useRef, useState } from 'react'
import { xiaomiRemoteView } from '../xiaomi-remote/view.ts'
import type { RemoteView } from '../types.ts'

type Props = {
  activeId: string
  pressedId?: string | null
  pressedIds?: readonly string[]
  mappedIds: readonly string[]
  onSelect: (id: string) => void
  remoteView?: RemoteView
}

const hintDismissedKey = 'axonkey.remote-interaction-hint.v1'

export function RemoteControl({
  activeId,
  pressedId,
  pressedIds = [],
  mappedIds,
  onSelect,
  remoteView = xiaomiRemoteView,
}: Props) {
  const [keyboardPressedId, setKeyboardPressedId] = useState<string | null>(null)
  const [pointerPressedId, setPointerPressedId] = useState<string | null>(null)
  const [hintDismissed, setHintDismissed] = useState(() => {
    try {
      return window.localStorage.getItem(hintDismissedKey) === '1'
    } catch {
      return false
    }
  })
  const spaceKeyRef = useRef<string | null>(null)

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

  const selectKey = (id: string) => {
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
        {remoteView.buttons.map(button => (
          <g
            key={button.id}
            data-remote-key={button.id}
            role="button"
            tabIndex={0}
            aria-label={button.label}
            aria-pressed={activeId === button.id}
            className={`remote-key${activeId === button.id ? ' selected' : ''}${pressedId === button.id || pressedIds.includes(button.id) ? ' pressed' : ''}${mappedIds.includes(button.id) ? ' mapped' : ''}${keyboardPressedId === button.id ? ' keyboard-pressed' : ''}${pointerPressedId === button.id ? ' pointer-pressed' : ''}`}
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
            <path
              className="remote-key-halo"
              d={remoteView.keyRegions[button.id].path}
              transform={remoteView.keyRegions[button.id].transform}
              aria-hidden="true"
            />
            <path
              className="remote-key-outline"
              d={remoteView.keyRegions[button.id].path}
              transform={remoteView.keyRegions[button.id].transform}
              aria-hidden="true"
            />
            <path
              className="remote-key-surface"
              d={remoteView.keyRegions[button.id].path}
              transform={remoteView.keyRegions[button.id].transform}
              aria-hidden="true"
            />
          </g>
        ))}
      </svg>
      <p className={`remote-control-hint${hintDismissed ? ' dismissed' : ''}`} aria-hidden={hintDismissed}>
        点击按键配置动作
      </p>
    </div>
  )
}
