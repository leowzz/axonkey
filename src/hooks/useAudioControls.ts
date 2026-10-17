import { invoke } from '@tauri-apps/api/core'
import { useEffect, useRef, useState } from 'react'
import {
  audioGainMax,
  audioGainMin,
  audioSettingsStorageKey,
  getStoredAudioGain,
  getStoredAudioStretchCompensation,
} from '../appConfig'
import type { Platform } from '../appTypes'
import { logError, logInfo } from '../runtimeLogging'

type UseAudioControlsOptions = {
  platform: Platform
  nativeRuntime: boolean
  onToast: (message: string) => void
}

export function useAudioControls({ platform, nativeRuntime, onToast }: UseAudioControlsOptions) {
  const [audioGain, setAudioGain] = useState(getStoredAudioGain)
  const [gainError, setGainError] = useState('')
  const [stretchCompensation, setStretchCompensation] = useState(getStoredAudioStretchCompensation)
  const [stretchError, setStretchError] = useState('')
  const [stretchUpdating, setStretchUpdating] = useState(true)
  const stretchRunning = useRef(true)
  const [audioRestarting, setAudioRestarting] = useState(false)
  const [audioRestartError, setAudioRestartError] = useState('')
  const audioRestartRunning = useRef(false)

  const restartAudio = async () => {
    if (!nativeRuntime || platform !== 'macos' || audioRestartRunning.current) return
    audioRestartRunning.current = true
    setAudioRestarting(true)
    setAudioRestartError('')
    try {
      await invoke('restart_audio_service')
      logInfo('Manually rebuilt macOS audio connections')
      onToast('已重新连接 MiRemoteV 2ch，遥控器语音通道正在重新连接')
      window.setTimeout(() => onToast(''), 3200)
    } catch (error) {
      logError('Failed to restart macOS audio connections', error)
      setAudioRestartError(`重启失败：${String(error)}`)
    } finally {
      audioRestartRunning.current = false
      setAudioRestarting(false)
    }
  }

  useEffect(() => {
    window.localStorage.setItem(audioSettingsStorageKey, JSON.stringify({ gain: audioGain, stretchCompensation }))
  }, [audioGain, stretchCompensation])

  useEffect(() => {
    if (platform === 'unsupported' || !nativeRuntime) return
    void invoke('set_audio_gain', { gain: audioGain }).catch((error) => {
      logError('Failed to initialize audio gain', error)
      setGainError(`音频增益未生效：${String(error)}`)
    })
  }, [nativeRuntime, platform])

  useEffect(() => {
    if (!nativeRuntime || platform !== 'macos') {
      stretchRunning.current = false
      setStretchUpdating(false)
      return
    }
    stretchRunning.current = true
    setStretchUpdating(true)
    void invoke('set_audio_stretch_compensation', { enabled: stretchCompensation })
      .catch((error) => setStretchError(`拉伸补偿未生效：${String(error)}`))
      .finally(() => { stretchRunning.current = false; setStretchUpdating(false) })
  }, [nativeRuntime, platform])

  const updateStretchCompensation = async (enabled: boolean) => {
    if (!nativeRuntime || platform !== 'macos' || stretchRunning.current) return
    stretchRunning.current = true
    setStretchUpdating(true)
    setStretchError('')
    try {
      await invoke('set_audio_stretch_compensation', { enabled })
      setStretchCompensation(enabled)
    } catch (error) {
      setStretchError(`拉伸补偿未生效：${String(error)}`)
    } finally {
      stretchRunning.current = false
      setStretchUpdating(false)
    }
  }

  const updateAudioGain = (value: number) => {
    const next = Math.max(audioGainMin, Math.min(audioGainMax, Math.round(value)))
    setAudioGain(next)
    setGainError('')
    if (platform === 'unsupported' || !nativeRuntime) return
    logInfo(`Updating audio gain from frontend: ${next} dB`)
    void invoke('set_audio_gain', { gain: next }).catch((error) => {
      logError('Failed to update audio gain', error)
      setGainError(`音频增益未生效：${String(error)}`)
      onToast(`音频增益未生效：${String(error)}`)
      window.setTimeout(() => onToast(''), 2600)
    })
  }

  return { stretchCompensation, stretchError, stretchUpdating, updateStretchCompensation, audioGain, gainError, updateAudioGain, audioRestarting, audioRestartError, restartAudio }
}
