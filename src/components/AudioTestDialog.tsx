import { invoke } from '@tauri-apps/api/core'
import { AudioLines, X } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import type { AudioProbe, Platform } from '../appTypes'

type AudioLevel = { peak: number; rms: number }

const decibels = (value: number) => value > 0 ? `${(20 * Math.log10(value)).toFixed(1)} dBFS` : '−∞ dBFS'

export function AudioTestDialog({ platform, nativeRuntime, onClose }: {
  platform: Platform
  nativeRuntime: boolean
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
          setMaximum((previous) => Math.max(previous, next[1].peak))
          setError('')
        }
      } catch (cause) {
        if (active) {
          setSample(null)
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
  const meterValue = level.peak > 0 ? Math.max(0, Math.min(100, (20 * Math.log10(level.peak) + 60) / 60 * 100)) : 0

  return <dialog ref={dialogRef} className="audio-test-dialog" aria-labelledby="audio-test-title" onCancel={onClose} onClick={(event) => { if (event.target === event.currentTarget) onClose() }}>
    <div className="audio-test-content">
      <header><div><AudioLines size={20} /><h2 id="audio-test-title">测试音频</h2></div><button type="button" className="dialog-close" aria-label="关闭音频测试" onClick={onClose} autoFocus><X size={18} /></button></header>
      <ol className="audio-test-steps">
        <li><strong>连接遥控器</strong><span>确认 RC003 已通过蓝牙连接，音频驱动已安装。</span></li>
        <li><strong>按住语音键并说话</strong><span>靠近遥控器说“音频测试，一二三”，交替说话和停顿，观察下方电平。</span></li>
        <li><strong>确认目标应用能收到声音</strong><span>在录音或通话应用中选择「{deviceName}」作为麦克风，按住语音键录一小段并回放确认。</span></li>
      </ol>
      <section className="audio-test-meter">
        <p role="status">{message}</p>
        <div className="audio-test-track" role="meter" aria-label="实时峰值电平" aria-valuemin={-60} aria-valuemax={0} aria-valuenow={Math.max(-60, level.peak > 0 ? 20 * Math.log10(level.peak) : -60)} aria-valuetext={decibels(level.peak)}><div style={{ width: `${meterValue}%` }} /></div>
        <div className="audio-test-scale"><span>−60 dBFS</span><span>−30</span><span>0</span></div>
        <dl><div><dt>实时峰值</dt><dd>{decibels(level.peak)}</dd></div><div><dt>平均电平（RMS）</dt><dd>{decibels(level.rms)}</dd></div><div><dt>本次最高</dt><dd>{decibels(maximum)}</dd></div></dl>
      </section>
      <p className="audio-test-note">此处显示遥控器解码后、增益处理前的输入电平，不播放或保存录音。电平变化仅说明收到声音，不代表目标应用已正确选择麦克风。松开语音键后电平应回落；一直无变化时请检查连接和驱动。</p>
      <footer><button type="button" className="dialog-secondary" onClick={() => setMaximum(0)}>重置最高值</button><button type="button" className="dialog-secondary" onClick={onClose}>完成</button></footer>
    </div>
  </dialog>
}
