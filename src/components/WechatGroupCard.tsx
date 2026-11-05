import { useEffect, useState } from 'react'
import { LoaderCircle, MessageCircle } from 'lucide-react'
import { QRCodeSVG } from 'qrcode.react'

type GroupQrState = { status: 'loading' | 'empty' | 'error' } | { status: 'ready'; content: string }

export function WechatGroupCard() {
  const [state, setState] = useState<GroupQrState>({ status: 'loading' })
  const [request, setRequest] = useState(0)

  useEffect(() => {
    const controller = new AbortController()
    setState({ status: 'loading' })
    fetchGroupQr(AbortSignal.any([controller.signal, AbortSignal.timeout(15000)]))
      .then(content => {
        if (!controller.signal.aborted) setState(content ? { status: 'ready', content } : { status: 'empty' })
      })
      .catch(() => {
        if (!controller.signal.aborted) setState({ status: 'error' })
      })
    return () => controller.abort()
  }, [request])

  return (
    <aside className="about-wechat" aria-labelledby="about-wechat-title">
      <h3 id="about-wechat-title">
        <MessageCircle size={20} aria-hidden="true" /> 微信用户群
      </h3>
      <p>交流玩法，反馈问题</p>
      <div className="about-wechat-qr" role="status" aria-live="polite" aria-busy={state.status === 'loading'}>
        {state.status === 'ready' ? (
          <QRCodeSVG
            value={state.content}
            size={208}
            level="M"
            marginSize={4}
            bgColor="#ffffff"
            fgColor="#000000"
            role="img"
            title="微信用户群入群二维码"
          />
        ) : (
          <div className="about-wechat-status">
            {state.status === 'loading' && <LoaderCircle size={24} aria-hidden="true" />}
            <span>
              {state.status === 'loading'
                ? '正在加载二维码…'
                : state.status === 'empty'
                  ? '暂无群二维码，请稍后再试'
                  : '二维码加载失败，请重试'}
            </span>
          </div>
        )}
      </div>
      {state.status === 'ready' && <p className="about-wechat-scan">微信扫一扫，加入用户群</p>}
      <button
        type="button"
        className="about-wechat-refresh"
        disabled={state.status === 'loading'}
        onClick={() => setRequest(value => value + 1)}
      >
        {state.status === 'error' ? '重试' : state.status === 'empty' ? '重新获取' : '刷新二维码'}
      </button>
    </aside>
  )
}

async function fetchGroupQr(signal: AbortSignal): Promise<string> {
  const response = await fetch('https://relay.wleo.cn/api/axonkey/wechat-group-qr', {
    credentials: 'omit',
    cache: 'no-store',
    signal,
  })
  if (!response.ok) throw new Error('二维码请求失败')
  const data: unknown = await response.json()
  if (!data || typeof data !== 'object' || !('content' in data) || typeof data.content !== 'string') {
    throw new Error('二维码内容格式错误')
  }
  return data.content.trim()
}
