import { invoke } from '@tauri-apps/api/core'
import { AudioLines, Minus, Plus, RotateCcw, X } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import type { AudioProbe, Platform } from '../appTypes'
import { audioGainMin, audioGainMax } from '../appConfig'
import { gainAdjustedLevel, gainLevelTone, suggestedAudioGain } from '../audioGain'

type AudioLevel = { peak: number; rms: number }

const decibels = (value: number) => value > 0 ? `${(20 * Math.log10(value)).toFixed(1)} dBFS` : '−∞ dBFS'

export function AudioTestDialog({ platform, nativeRuntime, audioGain, gainError, onAudioGainChange, onClose }: {
  platform: Platform
  nativeRuntime: boolean
  audioGain: number
  gainError: string
  onAudioGainChange: (gain: number) => void
  onClose: () => void
}) {
  const dialogRef = useRef<HTMLDialogElement>(null)
  const [sample, setSample] = useState<[AudioProbe, AudioLevel] | null>(null)
  const [error, setError] = useState('')
  const [maximum, setMaximum] = useState(0)

  useEffect(() => {
    const dialog = dialogRef.current
    dialog?.showModal()
    return () => dialog?.close()
  }, [])

  useEffect(() => {
    if (!nativeRuntime || platform === 'unsupported') return
    let active = true
    let timer: number | undefined
    const poll = async () => {
      try {
        const next = await invoke<[AudioProbe, AudioLevel]>('get_audio_test_state')
        if (active) {
          setSample(next)
          setMaximum((previous) => next[0].error || !next[0].driverInstalled || !next[0].bluetoothConnected
            ? 0 : Math.max(previous, next[1].peak))
          setError('')
        }
      } catch (cause) {
        if (active) {
          setSample(null)
          setMaximum(0)
          setError(`无法读取音频状态：${String(cause)}`)
        }
      } finally {
        if (active) timer = window.setTimeout(() => void poll(), 100)
      }
    }
    void poll()
    return () => { active = false; window.clearTimeout(timer) }
  }, [nativeRuntime, platform])

  const [status, level] = sample ?? [null, { peak: 0, rms: 0 }]
  const supported = nativeRuntime && platform !== 'unsupported'
  const message = !supported ? '请在 macOS 或 Windows 桌面应用中测试，浏览器预览不提供真实音频。'
    : error || status?.error || (!status ? '正在读取音频状态…'
      : !status.driverInstalled ? '未检测到音频驱动，请先在音频设置中安装驱动。'
        : !status.bluetoothConnected ? '等待遥控器连接，请检查蓝牙连接并唤醒遥控器。'
          : level.peak > 0 ? '已收到音频信号，请观察说话和停顿时的电平变化。'
            : status.forwarding ? '语音通道已开启，暂未检测到声音。请靠近遥控器说话。'
              : '已连接，请按住遥控器语音键开始说话。')
  const deviceName = platform === 'windows' ? 'CABLE Output' : 'MiRemoteV 2ch'
  const adjustedPeak = gainAdjustedLevel(level.peak, audioGain)
  const adjustedMaximum = gainAdjustedLevel(maximum, audioGain)
  const tone = gainLevelTone(adjustedPeak)
  const suggestedGain = suggestedAudioGain(maximum, audioGainMin, audioGainMax)
  const meterValue = adjustedPeak > 0 ? Math.max(0, Math.min(100, (20 * Math.log10(adjustedPeak) + 60) / 60 * 100)) : 0
  const ready = supported && !!status?.driverInstalled && !!status.bluetoothConnected && !error && !status.error && !gainError
  const resultTone = !ready ? 'silent' : maximum >= 0.999 ? 'clipping' : gainLevelTone(adjustedMaximum)
  const result = {
    silent: { title: '等待正常讲话', hint: '按住语音键，以日常距离和音量说“音频测试，一二三”，持续几秒。' },
    low: { title: '音量偏低 · 请提高增益', hint: '正常讲话后，点击“应用建议”或逐步提高增益，直到显示绿色 OK。不要根据静音或背景噪声调整。' },
    good: { title: 'OK · 增益合适', hint: '本次讲话的估算峰值在合适范围内，可以保留当前设置。再录一小段回放，确认声音清晰。' },
    hot: { title: '音量偏高 · 请降低增益', hint: '点击“应用建议”或逐步降低增益，直到显示绿色 OK，为较大音量留出余量。' },
    clipping: { title: '音量过大 · 有失真风险', hint: maximum >= 0.999 ? '原始声音已接近满幅，请离遥控器远一些，再点击“重新测量”并正常讲话。' : '请降低增益，直到显示绿色 OK。红色表示音量过大，不是测试通过。' },
  }[resultTone]

  return <dialog ref={dialogRef} className="audio-test-dialog" aria-labelledby="audio-test-title" onCancel={onClose} onClick={(event) => { if (event.target === event.currentTarget) onClose() }}>
    <div className="audio-test-content">
      <header><div><AudioLines size={20} /><h2 id="audio-test-title">测试音频</h2></div><button type="button" className="dialog-close" aria-label="关闭音频测试" onClick={onClose} autoFocus><X size={18} /></button></header>
      <p className="audio-test-intro">按住语音键，用正常音量说几句话，再调整到绿色 OK。</p>
      <div className="audio-test-layout">
        <section className="audio-test-gain" aria-label="输入增益调整">
          <h3>1. 正常讲话，调整增益</h3>
          <p>保持日常使用距离，说“音频测试，一二三”，持续几秒。</p>
          <p><strong>按键声过滤：</strong>每次按下语音键后的前 200ms（0.2 秒）不计入测试电平和增益建议，避免按键声干扰判断。仅影响测试统计，正常语音仍完整传输，不会被裁剪或静音。</p>
          <div className="audio-test-gain-heading"><label htmlFor="audio-test-gain">输入增益</label><output htmlFor="audio-test-gain">{audioGain > 0 ? '+' : ''}{audioGain} dB</output></div>
          <div className="audio-test-gain-controls">
            <button type="button" className="dialog-secondary" aria-label="降低 1 dB" title="降低 1 dB" disabled={!supported || audioGain <= audioGainMin} onClick={() => onAudioGainChange(audioGain - 1)}><Minus size={16} /></button>
            <input id="audio-test-gain" type="range" min={audioGainMin} max={audioGainMax} step={1} value={audioGain} disabled={!supported} onChange={(event) => onAudioGainChange(Number(event.target.value))} />
            <button type="button" className="dialog-secondary" aria-label="提高 1 dB" title="提高 1 dB" disabled={!supported || audioGain >= audioGainMax} onClick={() => onAudioGainChange(audioGain + 1)}><Plus size={16} /></button>
            <button type="button" className="dialog-secondary" aria-label="恢复默认增益 0 dB" title="恢复默认增益 0 dB" disabled={!supported || audioGain === 0} onClick={() => onAudioGainChange(0)}><RotateCcw size={16} /></button>
          </div>
          <p>无需追求固定数值，设置自动保存并与首页同步。</p>
          {maximum >= 0.999 ? <p className="audio-test-gain-error">原始输入已接近满幅，降低软件增益无法修复源头失真。请远离麦克风或降低说话音量后重新测量。</p>
            : <div className="audio-test-suggestion"><span>{suggestedGain === null ? '正常讲话后，可一键应用建议增益。' : `建议增益 ${suggestedGain > 0 ? '+' : ''}${suggestedGain} dB。`}</span><button type="button" className="dialog-secondary" disabled={!ready || suggestedGain === null || suggestedGain === audioGain} onClick={() => { if (suggestedGain !== null) onAudioGainChange(suggestedGain) }}>应用建议</button></div>}
          {gainError && <p role="alert" className="audio-test-gain-error">{gainError}</p>}
        </section>
        <section className={`audio-test-meter ${tone}`}>
          <h3>2. 查看测试结果</h3>
          {ready && <p className="audio-test-connection" role="status">{message}</p>}
          <div className={`audio-test-result ${resultTone}`} role="status" aria-live="polite" aria-atomic="true">
            <strong>{ready ? result.title : '暂时无法判断增益'}</strong>
            <span>{ready ? result.hint : gainError || message}</span>
          </div>
          <p className="audio-test-result-note">按本次最高峰值判断，停顿时保留结果；改变距离或说话音量后，请重新测量。</p>
          <h3>实时音量 · 绿色区域为合适范围</h3>
          <div className="audio-test-track" role="meter" aria-label="增益后估算峰值电平" aria-valuemin={-60} aria-valuemax={0} aria-valuenow={Math.max(-60, Math.min(0, adjustedPeak > 0 ? 20 * Math.log10(adjustedPeak) : -60))} aria-valuetext={decibels(adjustedPeak)}><div style={{ width: `${meterValue}%` }} /></div>
          <div className="audio-test-scale"><span>偏低</span><span>合适</span><span>偏高</span></div>
        </section>
      </div>
      <div className="audio-test-playback"><strong>3. 录音回放确认</strong><span>在录音或通话应用中选择「{deviceName}」作为麦克风，录一小段，确认声音清晰。</span></div>
      <details className="audio-test-details">
        <summary>详细电平与测量说明</summary>
        <dl><div><dt>原始峰值</dt><dd>{decibels(level.peak)}</dd></div><div><dt>增益后估算</dt><dd>{decibels(adjustedPeak)}</dd></div><div><dt>本次最高估算</dt><dd>{decibels(adjustedMaximum)}</dd></div></dl>
        <dl><div><dt>原始 RMS</dt><dd>{decibels(level.rms)}</dd></div><div><dt>估算 RMS</dt><dd>{decibels(gainAdjustedLevel(level.rms, audioGain))}</dd></div><div><dt>参考峰值范围</dt><dd>−24 至 −6 dBFS</dd></div></dl>
        <p className="audio-test-note">每次语音开始后的前 200ms 不参与测试电平和增益建议，实际转发音频不受影响。测试峰值再剔除每批振幅最高的 1% 样本（不足 100 个时不剔除），这项过滤不改变 RMS。增益后数值是估算，超过 0 dBFS 表示削波风险，短暂削波仍可能被过滤。建议不能区分语音与噪声，请以录音回放为准；本窗口不播放或保存录音。</p>
      </details>
      <footer><button type="button" className="dialog-secondary" onClick={() => setMaximum(0)}>重新测量</button><button type="button" className="dialog-secondary" onClick={onClose}>完成</button></footer>
    </div>
  </dialog>
}
