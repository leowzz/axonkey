import { useEffect, useRef, useState } from 'react'
import type { StepDefinition } from 'sequential-workflow-designer'
import type { Platform } from '../appTypes'
import type { RelayClient } from './relayClient'
import { fetchLibraryPage } from './behaviorLibrary'
import type { LibraryPage, LibraryView } from './behaviorLibrary'

const empty: LibraryPage = { steps: [], nextCursor: '', skipped: 0 }
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
  const current = state.key === key ? state : { ...empty, key, loading: !!view, error: '' }
  const generation = useRef(0)

  useEffect(() => {
    const request = ++generation.current
    if (!client || !view) return
    setState(previous => ({ ...(previous.key === key ? previous : empty), key, loading: true, error: '' }))
    const timer = window.setTimeout(
      () => {
        void fetchLibraryPage(client, platform, view, query, '', builtinsRef.current)
          .then(page => {
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
      const page = await fetchLibraryPage(client, platform, view, query, current.nextCursor, builtinsRef.current)
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
  return { ...current, retry: () => retry(value => value + 1), more }
}
