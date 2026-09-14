export const releasesUrl = 'https://github.com/leowzz/axonkey/releases/latest'
const latestReleaseApi = 'https://api.github.com/repos/leowzz/axonkey/releases/latest'

export type ReleaseUpdateState = {
  checking: boolean
  latestVersion: string | null
  checkedAt: number | null
  error: string | null
}

// Stable release tags use major.minor.patch; build metadata does not affect precedence.
function parseVersion(version: string) {
  const match = /^[vV]?(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.exec(version)
  return match ? { parts: match.slice(1, 4).map(Number), prerelease: Boolean(match[4]) } : null
}

export function isNewerRelease(latest: string, current: string): boolean {
  const next = parseVersion(latest)
  const installed = parseVersion(current)
  if (!next || !installed || next.prerelease) return false
  for (let i = 0; i < 3; i++) {
    if (next.parts[i] !== installed.parts[i]) return next.parts[i] > installed.parts[i]
  }
  return installed.prerelease
}

export function createReleaseChecker(onChange: (state: ReleaseUpdateState) => void, {
  request = fetch,
  now = Date.now,
} = {}) {
  let state: ReleaseUpdateState = { checking: false, latestVersion: null, checkedAt: null, error: null }
  let nextCheckAt = 0
  let disposed = false
  let controller: AbortController | null = null
  const publish = () => { if (!disposed) onChange({ ...state }) }
  return {
    async check(force = false) {
      if (disposed || state.checking || (!force && now() < nextCheckAt)) return
      state = { ...state, checking: true, error: null }
      publish()
      controller = new AbortController()
      const timeout = setTimeout(() => controller?.abort(), 10_000)
      try {
        const response = await request(latestReleaseApi, {
          headers: { Accept: 'application/vnd.github+json' },
          signal: controller.signal,
          credentials: 'omit',
        })
        if (!response.ok) throw new Error(`GitHub HTTP ${response.status}`)
        const release = await response.json()
        if (!release || release.draft !== false || release.prerelease !== false
          || typeof release.tag_name !== 'string' || !parseVersion(release.tag_name)
          || parseVersion(release.tag_name)?.prerelease) throw new Error('Invalid release')
        state = { checking: false, latestVersion: release.tag_name, checkedAt: now(), error: null }
        nextCheckAt = now() + 60 * 60 * 1000
      } catch {
        // Preserve a previously discovered update through temporary network failures.
        state = { ...state, checking: false, error: '暂时无法检查更新，请稍后重试。' }
        nextCheckAt = now() + 60 * 1000
      } finally {
        clearTimeout(timeout)
        controller = null
        publish()
      }
    },
    dispose() {
      disposed = true
      controller?.abort()
    },
  }
}
