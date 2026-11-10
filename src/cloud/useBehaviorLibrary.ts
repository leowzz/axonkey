import { useEffect, useRef, useState } from 'react'
import type { StepDefinition } from 'sequential-workflow-designer'
import type { Platform } from '../appTypes'
import type { RelayClient } from './relayClient'
import {
  clearCachedLibraryPages,
  fetchLibraryPage,
  readCachedLibraryPage,
  writeCachedLibraryPage,
} from './behaviorLibrary'
import type { LibraryPage, LibraryView } from './behaviorLibrary'

const empty: LibraryPage = { steps: [], nextCursor: '', skipped: 0 }

function localStorageOrUndefined() {
  try {
    return typeof window === 'undefined' ? undefined : window.localStorage
  } catch {
    return undefined
  }
}

export function useBehaviorLibrary(
  client: RelayClient | undefined,
  platform: Platform,
  view: LibraryView | null,
  query: string,
  builtins: StepDefinition[],
) {
  const key = `${platform}/${view}/${query}`
  const currentKey = useRef(key)
  currentKey.current = key
  const builtinsRef = useRef(builtins)
  builtinsRef.current = builtins
  const [attempt, retry] = useState(0)
  const [state, setState] = useState({ ...empty, key: '', loading: false, error: '' })
  const cached = view ? readCachedLibraryPage(platform, view, query, '', localStorageOrUndefined()) : null
  const current =
    state.key === key
      ? state
      : cached
        ? { ...cached, key, loading: false, error: '' }
        : { ...empty, key, loading: !!view, error: '' }
  const generation = useRef(0)
  const forceRefreshKey = useRef<string | null>(null)

  useEffect(() => {
    const request = ++generation.current
    if (!client || !view) return
    const forceRefresh = forceRefreshKey.current === key
    if (forceRefresh) forceRefreshKey.current = null
    const storage = localStorageOrUndefined()
    const cached = forceRefresh ? null : readCachedLibraryPage(platform, view, query, '', storage)
    if (cached) {
      setState({ ...cached, key, loading: false, error: '' })
      return
    }
    setState(previous => ({ ...(previous.key === key ? previous : empty), key, loading: true, error: '' }))
    const timer = window.setTimeout(
      () => {
        if (forceRefresh) clearCachedLibraryPages(platform, view, query, storage)
        void fetchLibraryPage(client, platform, view, query, '', builtinsRef.current)
          .then(page => {
            writeCachedLibraryPage(platform, view, query, '', page, storage)
            if (generation.current === request) setState({ ...page, key, loading: false, error: '' })
          })
          .catch(() => {
            if (generation.current === request)
              setState(previous => ({ ...previous, loading: false, error: '云端暂时不可用' }))
          })
      },
      query ? 250 : 0,
    )
    return () => {
      window.clearTimeout(timer)
      generation.current++
    }
  }, [client, platform, view, query, attempt, key])

  async function more() {
    if (!client || !view || current.loading || !current.nextCursor) return
    const request = generation.current
    setState(previous => ({ ...previous, loading: true, error: '' }))
    try {
      const storage = localStorageOrUndefined()
      const cursor = current.nextCursor
      const cached = readCachedLibraryPage(platform, view, query, cursor, storage)
      const page = cached ?? (await fetchLibraryPage(client, platform, view, query, cursor, builtinsRef.current))
      if (!cached) writeCachedLibraryPage(platform, view, query, cursor, page, storage)
      if (generation.current !== request || currentKey.current !== key) return
      setState(previous => {
        const ids = new Set(previous.steps.map(step => step.properties.libraryItemId))
        return {
          ...page,
          key,
          loading: false,
          error: '',
          skipped: previous.skipped + page.skipped,
          steps: [...previous.steps, ...page.steps.filter(step => !ids.has(step.properties.libraryItemId))],
        }
      })
    } catch {
      if (generation.current === request && currentKey.current === key)
        setState(previous => ({ ...previous, loading: false, error: '加载更多失败' }))
    }
  }
  return {
    ...current,
    retry: () => {
      forceRefreshKey.current = key
      retry(value => value + 1)
    },
    more,
  }
}
