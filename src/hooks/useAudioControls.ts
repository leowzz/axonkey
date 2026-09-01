import { invoke } from '@tauri-apps/api/core'
import { useEffect, useState } from 'react'
import {
  audioGainMax,
  audioGainMin,
  audioSettingsStorageKey,
  getStoredAudioGain,
} from '../appConfig'
import type { Platform } from '../appTypes'

type UseAudioControlsOptions = {
  platform: Platform
  nativeRuntime: boolean
  onToast: (message: string) => void
}

export function useAudioControls({ platform, nativeRuntime, onToast }: UseAudioControlsOptions) {
  const [audioGain, setAudioGain] = useState(getStoredAudioGain)

  useEffect(() => {
    window.localStorage.setItem(audioSettingsStorageKey, JSON.stringify({ gain: audioGain }))
  }, [audioGain])

  useEffect(() => {
    if (platform === 'unsupported' || !nativeRuntime) return
    void invoke('set_audio_gain', { gain: audioGain }).catch(() => undefined)
  }, [nativeRuntime, platform])

  const updateAudioGain = (value: number) => {
    const next = Math.max(audioGainMin, Math.min(audioGainMax, Math.round(value)))
    setAudioGain(next)
    if (platform === 'unsupported' || !nativeRuntime) return
    void invoke('set_audio_gain', { gain: next }).catch((error) => {
      onToast(`音频增益未生效：${String(error)}`)
      window.setTimeout(() => onToast(''), 2600)
    })
  }

  return { audioGain, updateAudioGain }
}
