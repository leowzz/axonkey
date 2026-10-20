export const releasesUrl = 'https://github.com/leowzz/axonkey/releases'

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
  if (!next || !installed || next.prerelease || next.parts[0] !== installed.parts[0]) return false
  for (let i = 0; i < 3; i++) {
    if (next.parts[i] !== installed.parts[i]) return next.parts[i] > installed.parts[i]
  }
  return installed.prerelease
}

export function updateManifestUrl(currentVersion: string): string {
  const current = parseVersion(currentVersion)
  if (!current) throw new Error('Invalid current version')
  return `https://raw.githubusercontent.com/leowzz/axonkey/updates/v${current.parts[0]}/latest.json`
}

export function createReleaseChecker(onChange: (state: ReleaseUpdateState) => void, {
  currentVersion,
  request = fetch,
  now = Date.now,
}: {
  currentVersion: string
  request?: typeof fetch
  now?: () => number
}) {
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
        const response = await request(updateManifestUrl(currentVersion), {
          signal: controller.signal,
          credentials: 'omit',
          cache: 'no-cache',
        })
        if (!response.ok) throw new Error(`Update manifest HTTP ${response.status}`)
        const manifest = await response.json()
        const latest = typeof manifest?.version === 'string' ? parseVersion(manifest.version) : null
        const current = parseVersion(currentVersion)!
        if (!latest || latest.prerelease || latest.parts[0] !== current.parts[0]) throw new Error('Invalid update manifest')
        const latestVersion = manifest.version as string
        state = { checking: false, latestVersion, checkedAt: now(), error: null }
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
