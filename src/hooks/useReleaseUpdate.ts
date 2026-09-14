import { useCallback, useEffect, useRef, useState } from 'react'
import { createReleaseChecker, isNewerRelease, type ReleaseUpdateState } from '../releaseUpdate'
import appPackage from '../../package.json'

export function useReleaseUpdate(activePage: string, debugMode = false) {
  const [state, setState] = useState<ReleaseUpdateState>({ checking: false, latestVersion: null, checkedAt: null, error: null })
  const checker = useRef<ReturnType<typeof createReleaseChecker> | null>(null)
  const check = useCallback((force = false) => { void checker.current?.check(force) }, [])

  useEffect(() => {
    const service = createReleaseChecker(setState)
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
  }, [check])

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
    }
  }
  return { ...state, hasUpdate, check }
}
