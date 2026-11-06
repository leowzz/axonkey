export type CaptchaConfig = { enabled: boolean; api_endpoint?: string; assets_url?: string }

type CapInstance = {
  solve(): Promise<{ success: boolean; token: string }>
  widget: HTMLElement
}
type CapWindow = Window & {
  Cap?: new (config: { apiEndpoint: string; 'data-cap-worker-count': string }) => CapInstance
  CAP_CUSTOM_WASM_URL?: string
  CAP_CUSTOM_HASHWX_URL?: string
  CAP_PAKO_URL?: string
}

let loading: Promise<void> | undefined

export async function solveCaptcha(config: CaptchaConfig): Promise<string> {
  if (!config.enabled) return ''
  const runtime = window as CapWindow
  if (!config.api_endpoint || !config.assets_url) throw new Error('人机验证配置不可用，请稍后重试。')
  const assets = config.assets_url
  runtime.CAP_CUSTOM_WASM_URL = `${assets}cap-wasm/0.0.8/cap_wasm_bg.wasm`
  runtime.CAP_CUSTOM_HASHWX_URL = `${assets}cap-wasm/0.0.8/hashwx.wasm`
  runtime.CAP_PAKO_URL = `${assets}pako/2.1.0/pako_inflate.min.js`
  if (!loading) {
    loading = new Promise<void>((resolve, reject) => {
      const script = document.createElement('script')
      script.src = `${assets}cap-widget/0.1.58/cap.min.js`
      script.async = true
      const timer = window.setTimeout(() => {
        script.remove()
        reject(new Error('人机验证加载超时，请重试。'))
      }, 15000)
      script.onload = () => {
        window.clearTimeout(timer)
        resolve()
      }
      script.onerror = () => {
        window.clearTimeout(timer)
        script.remove()
        reject(new Error('人机验证加载失败，请重试。'))
      }
      document.head.appendChild(script)
    }).catch(error => {
      loading = undefined
      throw error
    })
  }
  await loading
  if (!runtime.Cap) throw new Error('人机验证加载失败，请重试。')
  const cap = new runtime.Cap({ apiEndpoint: config.api_endpoint, 'data-cap-worker-count': '4' })
  let timer: number | undefined
  try {
    const result = await Promise.race([
      cap.solve(),
      new Promise<never>((_, reject) => {
        timer = window.setTimeout(() => reject(new Error('timeout')), 30000)
      }),
    ])
    if (!result?.success || !result.token) throw new Error()
    return result.token
  } catch {
    throw new Error('人机验证未完成，请检查网络后重试。')
  } finally {
    window.clearTimeout(timer)
    cap.widget.remove()
  }
}
