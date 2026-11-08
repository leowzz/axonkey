import { useEffect, useRef, useState } from 'react'
import type { StepDefinition } from 'sequential-workflow-designer'
import type { Platform } from '../appTypes'
import {
  fetchRecommendationItems,
  publishRecommendation,
  recommendationCatalogKey,
  setRecommendation,
} from './behaviorLibrary'
import type { RecommendationItem } from './behaviorLibrary'
import { RelayError } from './relayClient'
import type { RelayClient } from './relayClient'

const empty = { isAdmin: false, items: [] as RecommendationItem[], loading: false, busy: false, error: '', notice: '' }

export function useLibraryRecommendations(
  client: RelayClient | undefined,
  userId: string | null | undefined,
  enabled: boolean,
  platform: Platform,
) {
  const key = enabled && userId ? userId : ''
  const currentKey = useRef(key)
  currentKey.current = key
  const generation = useRef(0)
  const [attempt, retry] = useState(0)
  const [state, setState] = useState({ ...empty, key: '' })
  const current = key && state.key === key ? state : empty

  useEffect(() => {
    const request = ++generation.current
    if (!client || !key) return
    setState({ ...empty, key, loading: true })
    void (async () => {
      try {
        const user = await client.request<{ is_admin: boolean }>('GET', '/v2/me')
        if (request !== generation.current) return
        const isAdmin = user.is_admin === true
        const items = isAdmin ? await fetchRecommendationItems(client) : []
        if (request === generation.current) setState({ ...empty, key, isAdmin, items })
      } catch {
        if (request === generation.current) setState({ ...empty, key, error: '无法加载推荐管理权限，请重试' })
      }
    })()
    return () => {
      generation.current++
    }
  }, [client, key, attempt])

  function itemFor(step: StepDefinition) {
    return typeof step.properties.libraryItemId === 'string'
      ? current.items.find(item => item.id === step.properties.libraryItemId)
      : current.items.find(item => item.catalog_key === recommendationCatalogKey(step, platform))
  }

  async function toggle(step: StepDefinition, category: string): Promise<boolean> {
    if (!client || !current.isAdmin || current.busy) return false
    const request = generation.current
    const item = itemFor(step)
    if (typeof step.properties.libraryItemId === 'string' && !item) {
      setState(previous => ({ ...previous, error: '云端行为已变化，请刷新后重试', notice: '' }))
      return false
    }
    const enabled = !item?.recommend_enabled
    setState(previous => ({ ...previous, busy: true, error: '', notice: '' }))
    try {
      const updated =
        item && (!enabled || typeof step.properties.libraryItemId === 'string')
          ? await setRecommendation(client, item, enabled)
          : await publishRecommendation(client, step, platform, category)
      if (request !== generation.current || currentKey.current !== key) return false
      setState(previous => ({
        ...previous,
        items: [...previous.items.filter(entry => entry.id !== updated.id), updated],
        busy: false,
        notice: enabled ? `已推荐“${step.name}”` : `已取消推荐“${step.name}”`,
      }))
      return true
    } catch (error) {
      if (request !== generation.current || currentKey.current !== key) return false
      const denied = error instanceof RelayError && (error.status === 401 || error.status === 403)
      const conflict = error instanceof RelayError && (error.status === 409 || error.status === 412)
      setState(previous => ({
        ...previous,
        isAdmin: denied ? false : previous.isAdmin,
        busy: false,
        error: denied
          ? '管理员权限已失效，请重新检查'
          : conflict
            ? '云端推荐已变化，请刷新后重试'
            : '推荐设置未完成，请重试',
      }))
      return false
    }
  }

  return { ...current, itemFor, toggle, retry: () => retry(value => value + 1) }
}
