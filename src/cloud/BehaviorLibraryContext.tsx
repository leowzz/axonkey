import { createContext } from 'react'
import type { RelayClient } from './relayClient'

export const BehaviorLibraryContext = createContext<{
  client: RelayClient
  userId: string | null
  accountReady: boolean
  onLogin: () => void
} | null>(null)
