import { useEffect, useRef, useState } from 'react'
import { disable, enable, isEnabled } from '@tauri-apps/plugin-autostart'

export function AutostartControl({ supported }: { supported: boolean }) {
  const [enabled, setEnabled] = useState<boolean | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [refreshVersion, setRefreshVersion] = useState(0)
  const inFlight = useRef(false)

  useEffect(() => {
    if (!supported) return
    let active = true
    let reading = false
    const refresh = async () => {
      if (inFlight.current || reading) return
      reading = true
      setBusy(true)
      try {
        const value = await isEnabled()
        if (active) { setEnabled(value); setError('') }
      } catch (cause) {
        if (active) setError(`无法读取开机自启设置：${String(cause)}`)
      } finally {
        reading = false
        if (active) setBusy(false)
      }
    }
    void refresh()
    window.addEventListener('focus', refresh)
    return () => { active = false; window.removeEventListener('focus', refresh) }
  }, [supported, refreshVersion])

  const toggle = async () => {
    if (!supported || inFlight.current) return
    inFlight.current = true
    setBusy(true)
    setError('')
    try {
      // Read again before changing: the OS setting may have changed externally.
      const current = await isEnabled()
      if (current) await disable()
      else await enable()
      const actual = await isEnabled()
      setEnabled(actual)
      if (actual === current) setError('开机自启设置未生效，请重试。')
    } catch (cause) {
      setError(`无法更改开机自启设置：${String(cause)}`)
      try { setEnabled(await isEnabled()) } catch { setEnabled(null) }
    } finally {
      inFlight.current = false
      setBusy(false)
    }
  }

  return <section className="home-autostart" aria-label="启动设置">
    <div className="home-autostart-row">
      <div><strong id="autostart-label">开机自启</strong><p id="autostart-description">{supported ? '登录电脑后自动启动 Axonkey' : '请在 Windows 或 macOS 桌面应用中设置'}</p></div>
      <button type="button" role="switch" className={`switch ${enabled ? 'on' : ''}`} aria-checked={enabled === true} aria-labelledby="autostart-label" aria-describedby="autostart-description" aria-busy={busy} disabled={!supported || busy || enabled === null} onClick={() => void toggle()}><span /></button>
    </div>
    {busy && <p className="home-autostart-status" role="status">正在同步系统设置…</p>}
    {error && <p className="home-autostart-error" role="alert">{error}<button type="button" disabled={busy} onClick={() => setRefreshVersion(value => value + 1)}>重新读取</button></p>}
  </section>
}
