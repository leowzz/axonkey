import { useState } from 'react'
import { releasesUrl } from '../releaseUpdate'
import type { useReleaseUpdate } from '../hooks/useReleaseUpdate'
import { openGitHub, openReleases } from '../openGitHub'
import { Check, Copy, Github, Terminal } from 'lucide-react'
import { writeClipboardText } from '../clipboard'
import appPackage from '../../package.json'
import { WechatGroupCard } from './WechatGroupCard'

const appIconUrl = new URL('../../src-tauri/icons/128x128@2x.png', import.meta.url).href

export function AboutPage({ update }: { update: ReturnType<typeof useReleaseUpdate> }) {
  const busy = ['downloading', 'installing', 'restarting'].includes(update.phase)
  const progress = update.total
    ? `${Math.min(100, Math.floor((update.downloaded / update.total) * 100))}%`
    : `${(update.downloaded / 1024 / 1024).toFixed(1)} MB`
  const status =
    update.phase === 'downloading'
      ? `正在下载更新… ${progress}`
      : update.phase === 'installing'
        ? '正在验证并安装更新…'
        : update.phase === 'restarting'
          ? '更新已安装，正在重启…'
          : update.phase === 'ready'
            ? '更新已安装，等待重启'
            : update.hasUpdate
              ? `发现新版本 ${update.latestVersion}`
              : update.checking
                ? '正在检查更新…'
                : update.error
                  ? '检查更新失败'
                  : update.checkedAt
                    ? '当前主版本已是最新'
                    : '等待检查更新'
  return (
    <div className="about-page">
      <section className="about-intro" aria-labelledby="about-title">
        <img className="about-app-icon" src={appIconUrl} alt="Axonkey 应用图标" width={64} height={64} />
        <div>
          <h2 id="about-title">Axonkey</h2>
          <span className="about-version">{appPackage.version}</span>
        </div>
        <div className="about-github-support">
          <a
            className="about-github-button"
            href="https://github.com/leowzz/axonkey"
            onClick={openGitHub}
            target="_blank"
            rel="noopener noreferrer"
          >
            <Github size={17} aria-hidden="true" /> GitHub
          </a>
          <span>给个 Star ⭐</span>
        </div>
      </section>
      <div className="about-details">
        <div className="about-details-main">
          <section className={`about-update ${update.hasUpdate ? 'available' : ''}`} aria-label="版本更新">
            <div role="status">
              <strong>{status}</strong>
              <p>
                {update.error ??
                  (update.hasUpdate ? (
                    update.canInstall ? (
                      '可继续使用当前版本。点击“更新并重启”后才会下载并安装新版，完成后重启应用。'
                    ) : (
                      `当前版本 ${appPackage.version}，可前往 GitHub 下载更新。`
                    )
                  ) : (
                    <>
                      跨主版本更新需
                      <a
                        className="about-update-link"
                        href={releasesUrl}
                        onClick={openReleases}
                        target="_blank"
                        rel="noopener noreferrer"
                      >
                        下载
                      </a>
                      并手动安装。
                    </>
                  ))}
              </p>
              {update.phase === 'downloading' && (
                <progress
                  aria-label="更新下载进度"
                  max={update.total ?? undefined}
                  value={update.total ? update.downloaded : undefined}
                />
              )}
            </div>
            <div className="about-update-actions">
              <button
                type="button"
                disabled={update.checking || update.phase !== 'idle'}
                onClick={() => update.check(true)}
              >
                {update.checking ? '检查中…' : '检查更新'}
              </button>
              {update.hasUpdate && !busy && (
                <a href={releasesUrl} onClick={openReleases} target="_blank" rel="noopener noreferrer">
                  前往下载
                </a>
              )}
              {update.canInstall && (
                <button
                  className="about-install-update"
                  type="button"
                  disabled={busy || update.checking}
                  onClick={update.install}
                >
                  {update.phase === 'ready' ? '重启应用' : busy ? '更新中…' : '更新并重启'}
                </button>
              )}
            </div>
          </section>
          <AgentConfigurationCard />
        </div>
        <WechatGroupCard />
      </div>
    </div>
  )
}

function AgentConfigurationCard() {
  const [copyState, setCopyState] = useState<'idle' | 'copied' | 'error'>('idle')
  const text = '请先了解 axonkey-cli，再按我的需求查看和调整设备按键设置。'

  return (
    <section className="about-cli" aria-labelledby="about-cli-title">
      <div className="about-cli-header">
        <h3 id="about-cli-title">
          <Terminal size={22} aria-hidden="true" /> 用 Agent 配置
        </h3>
        <button
          type="button"
          aria-label="复制提示词"
          onClick={() => {
            void writeClipboardText(text)
              .then(() => setCopyState('copied'))
              .catch(() => setCopyState('error'))
          }}
        >
          {copyState === 'copied' ? <Check size={14} aria-hidden="true" /> : <Copy size={14} aria-hidden="true" />}
          <span role="status">{copyState === 'copied' ? '已复制' : '复制提示词'}</span>
        </button>
      </div>
      <p>复制给 Agent，再描述你的需求。</p>
      <div className="about-cli-snippet">
        <pre>
          <code>{text}</code>
        </pre>
        {copyState === 'error' && <p role="alert">复制失败，请拖选文本后使用系统复制快捷键。</p>}
      </div>
    </section>
  )
}
