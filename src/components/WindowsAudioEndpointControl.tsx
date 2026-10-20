import { invoke } from '@tauri-apps/api/core'
import { ExternalLink, RotateCcw } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import type { AudioProbe, WindowsAudioEndpoints, WindowsAudioOutput } from '../appTypes'
import { captureEndpointsFor, endpointOptionLabel, windowsOutputPresentation } from '../windowsAudioEndpoints'
import { SettingsHelp } from './SettingsHelp'

type Props = {
  supported: boolean
  output?: WindowsAudioOutput | null
  driverBusy: boolean
  driverError?: string | null
  onProbeChange: (probe: AudioProbe) => void
  onOutputChange: (output: WindowsAudioOutput) => void
  onInstall: () => void
  onOpenSound: () => void
}

export function WindowsAudioEndpointControl(props: Props) {
  const { supported, output, driverBusy, driverError, onInstall, onOpenSound } = props
  const callbacks = useRef(props)
  callbacks.current = props
  const mounted = useRef(false)
  const requestVersion = useRef(0)
  const running = useRef(false)
  const [snapshot, setSnapshot] = useState<WindowsAudioEndpoints | null>(null)
  const [renderId, setRenderId] = useState('')
  const [captureId, setCaptureId] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')

  const load = async (resetDraft: boolean, version: number) => {
    const next = await invoke<WindowsAudioEndpoints>('get_windows_audio_endpoints')
    if (!mounted.current || requestVersion.current !== version) return
    setSnapshot(next)
    callbacks.current.onOutputChange(next.output)
    if (resetDraft) {
      setRenderId(next.binding?.renderEndpointId ?? '')
      setCaptureId(next.binding?.captureEndpointId ?? '')
    }
    if (next.error) setError(next.error)
  }

  const refresh = async (resetDraft = false) => {
    if (!supported || running.current) return
    running.current = true
    const version = ++requestVersion.current
    setBusy(true)
    setError('')
    setNotice('')
    try { await load(resetDraft, version) }
    catch (cause) {
      if (mounted.current && requestVersion.current === version) setError(`无法读取音频设备：${String(cause)}`)
    } finally {
      if (requestVersion.current === version) {
        running.current = false
        if (mounted.current) setBusy(false)
      }
    }
  }

  useEffect(() => {
    mounted.current = true
    void refresh(true)
    return () => { mounted.current = false; requestVersion.current++; running.current = false }
    // Callbacks stay current without restarting enumeration on every audio poll.
  }, [supported])

  const change = async (clear: boolean) => {
    if (!supported || running.current) return
    running.current = true
    const version = ++requestVersion.current
    setBusy(true)
    setError('')
    setNotice('')
    try {
      const probe = await invoke<AudioProbe>(clear ? 'clear_windows_audio_endpoint' : 'set_windows_audio_endpoint',
        clear ? undefined : { renderEndpointId: renderId, captureEndpointId: captureId || null })
      if (!mounted.current || requestVersion.current !== version) return
      callbacks.current.onProbeChange(probe)
      if (clear) { setRenderId(''); setCaptureId('') }
      setNotice(clear ? '已清除设备绑定。请选择播放端后应用，不会切换到其他设备。' : '设备选择已保存并生效。')
      setSnapshot((current) => current ? {
        ...current,
        binding: clear ? null : { schemaVersion: 1, renderEndpointId: renderId, captureEndpointId: captureId || null, adapterInstanceId: current.endpoints.find((endpoint) => endpoint.id === renderId)?.adapterId ?? '' },
        output: probe.output ?? current.output,
      } : current)
      try { await load(true, version) }
      catch (cause) {
        if (mounted.current && requestVersion.current === version) setError(`操作已完成，但设备列表刷新失败：${String(cause)}`)
      }
    } catch (cause) {
      if (!mounted.current || requestVersion.current !== version) return
      const message = `${clear ? '清除失败' : '应用失败'}：${String(cause)}`
      // A failed switch may also fail to restore the old stream. Read the actual
      // output state, retaining the user's draft so they can retry explicitly.
      try { await load(false, version) } catch { /* Retain the primary actionable error. */ }
      if (mounted.current && requestVersion.current === version) { setNotice(''); setError(message) }
    } finally {
      if (requestVersion.current === version) {
        running.current = false
        if (mounted.current) setBusy(false)
      }
    }
  }

  const endpoints = snapshot?.endpoints ?? []
  const renders = endpoints.filter((endpoint) => endpoint.direction === 'render')
  const render = renders.find((endpoint) => endpoint.id === renderId)
  const captures = captureEndpointsFor(endpoints, renderId)
  const capture = captures.find((endpoint) => endpoint.id === captureId)
  const currentOutput = output ?? snapshot?.output
  const presentation = windowsOutputPresentation(currentOutput)
  const disabled = !supported || busy || driverBusy || currentOutput?.state === 'switching'
  const canApply = render?.state === 'active' && (!captureId || capture?.state === 'active') && (captures.length <= 1 || !!captureId)
  const chooseRender = (id: string) => {
    setRenderId(id)
    const choices = captureEndpointsFor(endpoints, id)
    setCaptureId(choices.length === 1 && choices[0].state === 'active' ? choices[0].id : '')
    setNotice('')
  }

  return <div className="settings-form-fields windows-audio-endpoints" aria-busy={busy}>
    <div className="settings-form-row">
      <span className="settings-form-label">语音播放端：</span>
      <div className="settings-form-control">
        <span className={`settings-permission-status ${supported && presentation.tone === 'ready' ? 'granted' : ''}`}>{!supported ? '未检测' : busy ? '正在处理…' : presentation.label}</span>
        <button type="button" className="dialog-secondary" disabled={disabled} onClick={() => void refresh()}><RotateCcw size={14} />重新检测</button>
        <button type="button" className="dialog-secondary" disabled={disabled} onClick={onOpenSound}>声音设置<ExternalLink size={14} /></button>
        <SettingsHelp id="windows-audio-route-help" label="语音播放端">选择接收遥控器声音的 VB-CABLE 播放端，应用按设备 ID 保存绑定，改名不会改变选择。名称后的 ID 后缀用于区分同名设备。播放端与录音端属于同一适配器仍需通过录音回放确认内部路由。</SettingsHelp>
      </div>
    </div>
    <div className="settings-form-row">
      <label className="settings-form-label" htmlFor="windows-audio-render">选择播放端：</label>
      <div className="settings-form-control">
        <select id="windows-audio-render" className="settings-audio-select" value={renderId} disabled={disabled || !snapshot} onChange={(event) => chooseRender(event.target.value)}>
          <option value="">请选择设备</option>
          {renderId && !render && <option value={renderId} disabled>已保存设备不可用 · {renderId.slice(-13)}</option>}
          {renders.map((endpoint) => <option key={endpoint.id} value={endpoint.id} disabled={endpoint.state !== 'active'}>{endpointOptionLabel(endpoint)}</option>)}
        </select>
        {render && <SettingsHelp id="windows-audio-adapter-help" label="播放端设备信息">适配器：{render.adapterId}；设备 ID：{render.id}；服务：{render.service || '未知'}；声道：{render.channels ?? '未知'}。这些信息仅用于区分设备。</SettingsHelp>}
      </div>
    </div>
    <div className="settings-form-row">
      <label className="settings-form-label" htmlFor="windows-audio-capture">应用麦克风：</label>
      <div className="settings-form-control">
        <select id="windows-audio-capture" className="settings-audio-select" value={captureId} disabled={disabled || !render} onChange={(event) => { setCaptureId(event.target.value); setNotice('') }}>
          <option value="">{captures.length > 1 ? '请选择对应录音端' : '未关联录音端'}</option>
          {captureId && !capture && <option value={captureId} disabled>已保存设备不可用 · {captureId.slice(-13)}</option>}
          {captures.map((endpoint) => <option key={endpoint.id} value={endpoint.id} disabled={endpoint.state !== 'active'}>{endpointOptionLabel(endpoint)}</option>)}
        </select>
        <SettingsHelp id="windows-audio-capture-help" label="应用麦克风">仅显示同一音频适配器的录音端。存在多个录音端时请明确选择，再在录音或通话应用中选择相同设备；未关联时无法确定应使用的麦克风。</SettingsHelp>
      </div>
    </div>
    <div className="settings-form-row">
      <span className="settings-form-label">应用选择：</span>
      <div className="settings-form-control">
        <button type="button" className="dialog-secondary" disabled={disabled || !canApply} onClick={() => void change(false)}>保存并应用</button>
        <button type="button" className="dialog-secondary" disabled={disabled || (!snapshot?.binding && currentOutput?.state !== 'configError')} onClick={() => void change(true)}>清除绑定</button>
        <button type="button" className="dialog-secondary" disabled={disabled} onClick={onInstall}>安装驱动</button>
      </div>
    </div>
    <div className="settings-form-row">
      <span className="settings-form-label">当前输出：</span>
      <div className="settings-form-control settings-audio-current" role="status" aria-live="polite">
        <span>{!supported ? '请在 Windows 桌面版中检测。' : presentation.detail}</span>
        {currentOutput?.captureEndpointName && <span>录音应用请选择「{currentOutput.captureEndpointName}」，并录音回放确认。</span>}
        {notice && <span>{notice}</span>}
      </div>
    </div>
    {(error || driverError) && <div className="settings-form-row"><span className="settings-form-label">需要处理：</span><div className="settings-audio-error" role="alert">{error || driverError}</div></div>}
  </div>
}
