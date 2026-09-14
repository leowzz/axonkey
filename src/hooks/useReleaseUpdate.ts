import { useCallback, useEffect, useRef, useState } from 'react'
import { createReleaseChecker, isNewerRelease } from '../releaseUpdate'
import { createNativeReleaseChecker, initialUpdateState } from '../nativeReleaseUpdate'
import { check as checkUpdate } from '@tauri-apps/plugin-updater'
import { relaunch } from '@tauri-apps/plugin-process'
import appPackage from '../../package.json'

export function useReleaseUpdate(activePage: string, debugMode = false) {
  const native = typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window
  const [state, setState] = useState(initialUpdateState)
  const checker = useRef<ReturnType<typeof createReleaseChecker> | ReturnType<typeof createNativeReleaseChecker> | null>(null)
  const check = useCallback((force = false) => { void checker.current?.check(force) }, [])
  const install = useCallback(() => {
    if (!debugMode && checker.current && 'install' in checker.current) void checker.current.install()
  }, [debugMode])

  useEffect(() => {
    const service = native
      ? createNativeReleaseChecker(setState, { checkUpdate: () => checkUpdate({ timeout: 15_000 }), relaunch })
      : createReleaseChecker(next => setState({ ...initialUpdateState, ...next }))
    checker.current = service
    const onWake = () => check()
    const onVisible = () => { if (document.visibilityState === 'visible') check() }
    window.addEventListener('focus', onWake)
    window.addEventListener('online', onWake)
    document.addEventListener('visibilitychange', onVisible)
    check()
    return () => {
      service.dispose()
      checker.current = null
      window.removeEventListener('focus', onWake)
      window.removeEventListener('online', onWake)
      document.removeEventListener('visibilitychange', onVisible)
    }
  }, [check, native])

  useEffect(() => { if (activePage === 'about') check() }, [activePage, check])
  const hasUpdate = Boolean(state.latestVersion && isNewerRelease(state.latestVersion, appPackage.version))
  if (debugMode) {
    const [major, minor, patch] = appPackage.version.split('.').map(Number)
    return {
      ...state,
      latestVersion: `v${major}.${minor}.${patch + 1}（调试预览）`,
      hasUpdate: true,
      error: null,
      check,
      install,
      canInstall: true,
    }
  }
  return { ...state, hasUpdate, check, install, canInstall: native && hasUpdate }
}
