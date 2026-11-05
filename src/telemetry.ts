import Aegis from 'aegis-web-sdk'

let tencentRum: Aegis | null = null

export function initializeTencentRum(id: string | undefined) {
  const rumId = id?.trim()
  if (!rumId) return

  try {
    tencentRum = new Aegis({
      id: rumId,
      reportApiSpeed: true,
      reportAssetSpeed: true,
      spa: true,
    })
  } catch {
    tencentRum = null
  }
}

export function reportTencentEvent(name: string) {
  const report = () => {
    try {
      tencentRum?.reportEvent(name)
    } catch {
      // Telemetry must never interfere with the application flow.
    }
  }

  globalThis.setTimeout(report, 0)
}
