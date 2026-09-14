import { invoke } from '@tauri-apps/api/core'
import type { MouseEvent } from 'react'
import { logError } from './runtimeLogging'

export function openGitHub(event: MouseEvent<HTMLAnchorElement>) {
  openGitHubPage(event, 'github')
}

export function openReleases(event: MouseEvent<HTMLAnchorElement>) {
  openGitHubPage(event, 'releases')
}

function openGitHubPage(event: MouseEvent<HTMLAnchorElement>, page: 'github' | 'releases') {
  if (!('__TAURI_INTERNALS__' in window)) return
  event.preventDefault()
  void invoke('open_external_page', { page }).catch((error) => {
    logError('Failed to open GitHub in the default browser', error)
    window.alert('无法打开系统浏览器，请手动访问 https://github.com/leowzz/axonkey')
  })
}
