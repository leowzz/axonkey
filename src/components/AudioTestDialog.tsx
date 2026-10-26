import { invoke } from '@tauri-apps/api/core'
import { SlidersHorizontal, Minus, Plus, RotateCcw, X } from 'lucide-react'
import { useEffect, useReducer, useRef, useState } from 'react'
import type { CSSProperties } from 'react'
import { AudioTestWaveform } from './AudioTestWaveform'
import { SettingsHelp } from './SettingsHelp'
import type { CalibrationWaveformPoint } from '../audioGain'
import type { AudioProbe, Platform } from '../appTypes'
import { audioGainMin, audioGainMax } from '../appConfig'
import {
  audioTestMeasurementReducer,
  initialAudioTestMeasurement,
  gainAdjustedLevel,
  gainLevelTone,
} from '../audioGain'

type AudioLevel = { peak: number; rms: number; nowMs?: number; waveform?: CalibrationWaveformPoint[] }

const decibels = (value: number) => (value > 0 ? `${(20 * Math.log10(value)).toFixed(1)} dBFS` : '−∞ dBFS')

export function AudioTestDialog({
  platform,
  nativeRuntime,
  instanceId,
  audioGain,
  gainError,
  onAudioGainChange,
  onClose,
}: {
  platform: Platform
  nativeRuntime: boolean
  instanceId?: string
  audioGain: number
  gainError: string
  onAudioGainChange: (gain: number) => void
  onClose: () => void
}) {
  const dialogRef = useRef<HTMLDialogElement>(null)
  const [sample, setSample] = useState<[AudioProbe, AudioLevel] | null>(null)
  const [error, setError] = useState('')
  const [{ maximum, completed, suggestedGain }, updateMeasurement] = useReducer(
    audioTestMeasurementReducer,
    initialAudioTestMeasurement,
  )

  useEffect(() => {
    const dialog = dialogRef.current
    dialog?.showModal()
    return () => dialog?.close()
  }, [])

  useEffect(() => {
    if (!nativeRuntime || platform === 'unsupported') return
    let active = true
    let wasForwarding = false
    let timer: number | undefined
    const poll = async () => {
      try {
        const next = await invoke<[AudioProbe, AudioLevel]>('get_audio_test_state', { instanceId })
        if (active) {
          setSample(next)
          const valid = !next[0].error && next[0].driverInstalled && next[0].bluetoothConnected
          const forwarding = valid && next[0].forwarding
          if (!valid || (forwarding && !wasForwarding)) updateMeasurement({ type: 'reset' })
          if (valid && (forwarding || wasForwarding)) {
            updateMeasurement({
              type: 'sample',
              peak: Math.max(next[1].peak, ...(next[1].waveform ?? []).map(p => p.peak)),
            })
          }
          if (wasForwarding && valid && !forwarding) {
            updateMeasurement({ type: 'finish', minimum: audioGainMin, maximum: audioGainMax })
          }
          wasForwarding = forwarding
          setError('')
        }
      } catch (cause) {
        if (active) {
          wasForwarding = false
          setSample(null)
          updateMeasurement({ type: 'reset' })
          setError(`无法读取音频状态：${String(cause)}`)
        }
      } finally {
        if (active) timer = window.setTimeout(() => void poll(), 100)
      }
    }
    void poll()
    return () => {
      active = false
      window.clearTimeout(timer)
    }
  }, [instanceId, nativeRuntime, platform])

  const [status, level] = sample ?? [null, { peak: 0, rms: 0 }]
  const supported = nativeRuntime && platform !== 'unsupported'
  const message = !supported
    ? '浏览器不支持音量测试，请使用桌面应用。'
    : error ||
      status?.error ||
      (!status
        ? '正在读取音频状态…'
        : !status.driverInstalled
          ? '未检测到音频驱动，请先在音频设置中安装驱动。'
          : !status.bluetoothConnected
            ? '请连接并唤醒遥控器。'
            : '')
  const deviceName = platform === 'windows' ? 'CABLE Output' : 'MiRemoteV 2ch'
  const adjustedPeak = gainAdjustedLevel(level.peak, audioGain)
  const adjustedMaximum = gainAdjustedLevel(maximum, audioGain)
  const tone = gainLevelTone(adjustedPeak)
  const meterValue =
    adjustedPeak > 0 ? Math.max(0, Math.min(100, ((20 * Math.log10(adjustedPeak) + 60) / 60) * 100)) : 0
  const ready =
    supported && !!status?.driverInstalled && !!status.bluetoothConnected && !error && !status.error && !gainError
  const resultTone = !ready || !completed ? 'silent' : maximum >= 0.999 ? 'clipping' : gainLevelTone(adjustedMaximum)
  const result = {
    silent: { title: '未检测到声音', hint: '请靠近遥控器重新测试。' },
    low: { title: '音量偏低', hint: '提高增益，或应用建议。' },
    good: { title: '增益合适', hint: '' },
    hot: { title: '音量偏高', hint: '降低增益，或应用建议。' },
    clipping: {
      title: '音量过大 · 可能失真',
      hint: maximum >= 0.999 ? '原始输入接近满幅，请离遥控器远一些再试。' : '请降低增益。',
    },
  }[resultTone]
  const resultHint = !ready ? (gainError ? '' : message) : completed ? result.hint : ''
  const changeGain = (gain: number) => {
    onAudioGainChange(gain)
    if (instanceId) void invoke('set_audio_gain', { instanceId, gain }).catch(() => {})
  }

  return (
    <dialog
      ref={dialogRef}
      className="audio-test-dialog"
      aria-labelledby="audio-test-title"
      onCancel={onClose}
      onClick={event => {
        if (event.target === event.currentTarget) onClose()
      }}
    >
      <div className="audio-test-content">
        <header>
          <div>
            <SlidersHorizontal size={20} />
            <h2 id="audio-test-title">校准音量</h2>
            <SettingsHelp id="audio-calibration-help" label="音量校准">
              建议基于增益后的估算音量，不能替代试听。可在录音应用中选择「{deviceName}
              」回放确认；此窗口不播放或保存录音。
            </SettingsHelp>
          </div>
          <button type="button" className="dialog-close" aria-label="关闭音量校准" onClick={onClose} autoFocus>
            <X size={18} />
          </button>
        </header>
        <p className="audio-test-intro">按住语音键正常讲话，松开查看建议。</p>
        <div className="audio-test-layout">
          <section className={`audio-test-meter ${tone}`}>
            <h3>测试结果</h3>
            <div className={`audio-test-result ${resultTone}`} role="status" aria-live="polite" aria-atomic="true">
              <strong>
                {!ready ? '暂不可测试' : completed ? result.title : status?.forwarding ? '正在收音…' : '等待测试'}
              </strong>
              {resultHint && <span>{resultHint}</span>}
            </div>
            <h3 className="audio-test-meter-heading">实时音量</h3>
            <div
              className="audio-test-track"
              role="meter"
              aria-label="增益后估算峰值电平"
              aria-valuemin={-60}
              aria-valuemax={0}
              aria-valuenow={Math.max(-60, Math.min(0, adjustedPeak > 0 ? 20 * Math.log10(adjustedPeak) : -60))}
              aria-valuetext={decibels(adjustedPeak)}
            >
              <div style={{ width: `${meterValue}%` }} />
            </div>
            <div className="audio-test-scale">
              <span>偏低</span>
              <span>合适</span>
              <span>偏高</span>
            </div>
          </section>
          <section className="audio-test-gain" aria-label="输入增益调整">
            <div className="audio-test-gain-heading">
              <label htmlFor="audio-test-gain">输入增益</label>
              <output htmlFor="audio-test-gain">
                {audioGain > 0 ? '+' : ''}
                {audioGain}
                <span> dB</span>
              </output>
              <button
                type="button"
                className="dialog-secondary"
                aria-label="恢复默认增益 0 dB"
                title="恢复默认增益 0 dB"
                disabled={!supported || audioGain === 0}
                onClick={() => changeGain(0)}
              >
                <RotateCcw size={15} />
              </button>
            </div>
            <div className="audio-test-gain-controls">
              <button
                type="button"
                className="dialog-secondary"
                aria-label="降低 1 dB"
                title="降低 1 dB"
                disabled={!supported || audioGain <= audioGainMin}
                onClick={() => changeGain(audioGain - 1)}
              >
                <Minus size={16} />
              </button>
              <input
                id="audio-test-gain"
                type="range"
                min={audioGainMin}
                max={audioGainMax}
                step={1}
                value={audioGain}
                aria-valuetext={`${audioGain} dB`}
                style={
                  {
                    '--gain-progress': `${((audioGain - audioGainMin) / (audioGainMax - audioGainMin)) * 100}%`,
                  } as CSSProperties
                }
                disabled={!supported}
                onChange={event => changeGain(Number(event.target.value))}
              />
              <button
                type="button"
                className="dialog-secondary"
                aria-label="提高 1 dB"
                title="提高 1 dB"
                disabled={!supported || audioGain >= audioGainMax}
                onClick={() => changeGain(audioGain + 1)}
              >
                <Plus size={16} />
              </button>
              <div className="audio-test-gain-scale" aria-hidden="true">
                <span>{audioGainMin}</span>
                <span>0</span>
                <span>+{audioGainMax}</span>
              </div>
            </div>
            {completed && maximum < 0.999 && suggestedGain !== null && (
              <div className="audio-test-suggestion">
                <span>
                  建议 {suggestedGain > 0 ? '+' : ''}
                  {suggestedGain} dB
                </span>
                <button
                  type="button"
                  className="dialog-secondary"
                  disabled={!ready || suggestedGain === audioGain}
                  onClick={() => changeGain(suggestedGain)}
                >
                  应用建议
                </button>
              </div>
            )}
            {gainError && (
              <p role="alert" className="audio-test-gain-error">
                {gainError}
              </p>
            )}
          </section>
        </div>
        <AudioTestWaveform
          points={level.waveform ?? []}
          now={level.nowMs ?? 0}
          gain={audioGain}
          forwarding={!!status?.forwarding}
          available={ready}
        />
        <details className="audio-test-details">
          <summary>测量详情</summary>
          <dl>
            <div>
              <dt>原始峰值</dt>
              <dd>{decibels(level.peak)}</dd>
            </div>
            <div>
              <dt>增益后估算</dt>
              <dd>{decibels(adjustedPeak)}</dd>
            </div>
            <div>
              <dt>本次最高估算</dt>
              <dd>{decibels(adjustedMaximum)}</dd>
            </div>
          </dl>
          <dl>
            <div>
              <dt>原始 RMS</dt>
              <dd>{decibels(level.rms)}</dd>
            </div>
            <div>
              <dt>估算 RMS</dt>
              <dd>{decibels(gainAdjustedLevel(level.rms, audioGain))}</dd>
            </div>
            <div>
              <dt>参考峰值范围</dt>
              <dd>−24 至 −6 dBFS</dd>
            </div>
          </dl>
          <div className="audio-test-stage-list" aria-label="语音通道状态">
            <span>音频驱动：{!status ? '未检测' : status.driverInstalled ? '已安装' : '未安装'}</span>
            <span>语音连接：{!status ? '未检测' : status.bluetoothConnected ? '已连接' : '等待连接'}</span>
            <span>收音：{!status ? '未检测' : status.forwarding ? '已收到数据' : '暂无数据'}</span>
            <span>转发：{!status ? '未检测' : status.forwarding ? '进行中' : '未转发'}</span>
          </div>
          <p className="audio-test-note">
            测试忽略开头 200ms 的按键声，并剔除每批振幅最高的 1% 样本（不足 100 个时不剔除）；后者不改变
            RMS。过滤只影响测量，不改变实际音频，但可能漏掉短暂削波。建议无法区分语音与噪声。
          </p>
        </details>
        <footer>
          <button type="button" className="dialog-secondary" onClick={onClose}>
            关闭
          </button>
        </footer>
      </div>
    </dialog>
  )
}
