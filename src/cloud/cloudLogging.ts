import { logError, logInfo } from '../runtimeLogging.ts'

type Fields = Record<string, string | number | boolean | null | undefined>

export function logCloud(event: string, fields: Fields = {}, level: 'info' | 'error' = 'info') {
  const message = `[relay] ${JSON.stringify({ event, ...fields })}`
  if (level === 'error') logError(message)
  else logInfo(message)
}
