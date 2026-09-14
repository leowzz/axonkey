import type { DownloadEvent, Update } from '@tauri-apps/plugin-updater'
import type { ReleaseUpdateState } from './releaseUpdate'

export type NativeUpdateState = ReleaseUpdateState & {
  phase: 'idle' | 'downloading' | 'installing' | 'ready' | 'restarting'
  downloaded: number
  total: number | null
}

export const initialUpdateState: NativeUpdateState = {
  checking: false, latestVersion: null, checkedAt: null, error: null,
  phase: 'idle', downloaded: 0, total: null,
}

type PendingUpdate = Pick<Update, 'version' | 'downloadAndInstall' | 'close'>

export function createNativeReleaseChecker(onChange: (state: NativeUpdateState) => void, {
  checkUpdate,
  relaunch,
  now = Date.now,
}: {
  checkUpdate: () => Promise<PendingUpdate | null>
  relaunch: () => Promise<void>
  now?: () => number
}) {
  let state = { ...initialUpdateState }
  let pending: PendingUpdate | null = null
  let disposed = false
  let nextCheckAt = 0
  let installing = false
  const publish = () => { if (!disposed) onChange({ ...state }) }
  const close = (update: PendingUpdate | null) => { void update?.close().catch(() => {}) }

  return {
    async check(force = false) {
      if (disposed || state.checking || state.phase !== 'idle' || (!force && now() < nextCheckAt)) return
      state = { ...state, checking: true, error: null }
      publish()
      try {
        const update = await checkUpdate()
        if (disposed) { close(update); return }
        close(pending)
        pending = update
        state = { ...state, latestVersion: update?.version ?? null, checkedAt: now() }
        nextCheckAt = now() + 60 * 60 * 1000
      } catch {
        state = { ...state, error: '暂时无法检查更新，请稍后重试或前往 GitHub 下载。' }
        nextCheckAt = now() + 60 * 1000
      } finally {
        state = { ...state, checking: false }
        publish()
      }
    },
    async install() {
      if (disposed || state.checking || installing || !['idle', 'ready'].includes(state.phase)) return
      if (state.phase === 'idle' && !pending) return
      installing = true
      state = { ...state, error: null }
      try {
        if (state.phase !== 'ready') {
          state = { ...state, phase: 'downloading', downloaded: 0, total: null }
          publish()
          await pending!.downloadAndInstall((event: DownloadEvent) => {
            if (event.event === 'Started') state = { ...state, total: event.data.contentLength ?? null }
            if (event.event === 'Progress') state = { ...state, downloaded: state.downloaded + event.data.chunkLength }
            if (event.event === 'Finished') state = { ...state, phase: 'installing' }
            publish()
          })
          state = { ...state, phase: 'ready' }
        }
        state = { ...state, phase: 'restarting' }
        publish()
        await relaunch()
      } catch {
        const installed = state.phase === 'restarting'
        state = { ...state, phase: installed ? 'ready' : 'idle', error: installed
          ? '更新已安装，请重试重启或手动退出并重新打开应用。'
          : '更新安装失败，请重试或前往 GitHub 下载。' }
        publish()
      } finally {
        installing = false
        if (disposed) { close(pending); pending = null }
      }
    },
    dispose() {
      disposed = true
      if (!installing) { close(pending); pending = null }
    },
  }
}
