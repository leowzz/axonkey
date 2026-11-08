import { useState } from 'react'
import { releasesUrl } from '../releaseUpdate'
import type { useReleaseUpdate } from '../hooks/useReleaseUpdate'
import { openGitHub, openReleases } from '../openGitHub'
import { AudioLines, Check, Copy, Github, Keyboard, Terminal } from 'lucide-react'
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
                    ? '当前主版本已是最新版本'
                    : '等待检查更新'
  return (
    <div className="about-page">
      <section className="about-intro" aria-labelledby="about-title">
        <img className="about-app-icon" src={appIconUrl} alt="Axonkey 应用图标" width={64} height={64} />
        <div>
          <span className="about-version">版本 {appPackage.version}</span>
          <h2 id="about-title">关于 Axonkey</h2>
          <p>本地设备映射工具，为不同设备配置快捷键、文本与多步操作。</p>
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
          <span>如果觉得好用，欢迎给个 Star ⭐</span>
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
                      仅检查当前主版本的更新。跨主版本请
                      <a
                        className="about-update-link"
                        href={releasesUrl}
                        onClick={openReleases}
                        target="_blank"
                        rel="noopener noreferrer"
                      >
                        前往下载
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
          <section className="about-features" aria-label="应用功能">
            <article>
              <Keyboard size={22} />
              <h3>自定义按键</h3>
              <p>为单击、双击和长按配置按键、组合键、文本与多步操作。</p>
            </article>
            <article>
              <AudioLines size={22} />
              <h3>遥控器语音</h3>
              <p>使用遥控器语音键采集音频，通过虚拟麦克风提供给语音输入应用，支持增益调整与音频测试。</p>
            </article>
          </section>
          <section className="about-cli" aria-labelledby="about-cli-title">
            <h3 id="about-cli-title">
              <Terminal size={22} aria-hidden="true" /> 让 Agent 帮你配置
            </h3>
            <p>复制给你的 Agent，再告诉它你想怎么设置。</p>
            <CopyableSnippet
              label="示例 Prompt"
              text="我在用 Axonkey 设置设备按键。请先了解它的命令行工具 axonkey-cli，之后根据我的需求，帮我查看和调整按键设置。"
            />
          </section>
        </div>
        <WechatGroupCard />
      </div>
      <p className="about-note">首次使用请完成设备连接、权限与驱动设置，再在设置页左侧开启软件总开关。</p>
    </div>
  )
}

function CopyableSnippet({ label, text }: { label: string; text: string }) {
  const [copyState, setCopyState] = useState<'idle' | 'copied' | 'error'>('idle')

  return (
    <div className="about-cli-snippet">
      <div className="about-cli-snippet-header">
        <h4>{label}</h4>
        <button
          type="button"
          aria-label={`复制${label}`}
          onClick={() => {
            void writeClipboardText(text)
              .then(() => setCopyState('copied'))
              .catch(() => setCopyState('error'))
          }}
        >
          {copyState === 'copied' ? <Check size={14} aria-hidden="true" /> : <Copy size={14} aria-hidden="true" />}
          <span role="status">{copyState === 'copied' ? '已复制' : '复制'}</span>
        </button>
      </div>
      <pre>
        <code>{text}</code>
      </pre>
      {copyState === 'error' && <p role="alert">复制失败，请拖选文本后使用系统复制快捷键。</p>}
    </div>
  )
}
