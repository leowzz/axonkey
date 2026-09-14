import { releasesUrl } from '../releaseUpdate'
import type { useReleaseUpdate } from '../hooks/useReleaseUpdate'
import { openGitHub, openReleases } from '../openGitHub'
import { AudioLines, Github, Keyboard, ShieldCheck } from 'lucide-react'
import appPackage from '../../package.json'

const appIconUrl = new URL('../../src-tauri/icons/128x128@2x.png', import.meta.url).href

export function AboutPage({ update }: { update: ReturnType<typeof useReleaseUpdate> }) {
  const busy = ['downloading', 'installing', 'restarting'].includes(update.phase)
  const progress = update.total ? `${Math.min(100, Math.floor(update.downloaded / update.total * 100))}%` : `${(update.downloaded / 1024 / 1024).toFixed(1)} MB`
  const status = update.phase === 'downloading' ? `正在下载更新… ${progress}`
    : update.phase === 'installing' ? '正在验证并安装更新…'
    : update.phase === 'restarting' ? '更新已安装，正在重启…'
    : update.phase === 'ready' ? '更新已安装，等待重启'
    : update.hasUpdate ? `发现新版本 ${update.latestVersion}` : update.checking ? '正在检查更新…' : update.error ? '检查更新失败' : update.checkedAt ? '当前已是最新版本' : '等待检查更新'
  return <div className="about-page">
    <section className="about-intro" aria-labelledby="about-title">
      <img className="about-app-icon" src={appIconUrl} alt="Axonkey 应用图标" width={64} height={64} />
      <div>
        <span className="about-version">版本 {appPackage.version}</span>
        <h2 id="about-title">关于 Axonkey</h2>
        <p>面向小米 RC003 蓝牙遥控器的本地控制台，让遥控器成为易于配置的快捷键控制器。</p>
      </div>
      <div className="about-github-support">
        <a className="about-github-button" href="https://github.com/leowzz/axonkey" onClick={openGitHub} target="_blank" rel="noopener noreferrer"><Github size={17} aria-hidden="true" /> GitHub</a>
        <span>如果觉得好用，欢迎给个 Star ⭐</span>
      </div>
    </section>
    <section className={`about-update ${update.hasUpdate ? 'available' : ''}`} aria-label="版本更新">
      <div role="status">
        <strong>{status}</strong>
        {(update.error || update.hasUpdate) && <p>{update.error ?? (update.canInstall ? '可继续使用当前版本。点击“更新并重启”后才会下载并安装新版，完成后重启应用。' : `当前版本 ${appPackage.version}，可前往 GitHub 下载更新。`)}</p>}
        {update.phase === 'downloading' && <progress aria-label="更新下载进度" max={update.total ?? undefined} value={update.total ? update.downloaded : undefined} />}
      </div>
      <div className="about-update-actions">
        <button type="button" disabled={update.checking || update.phase !== 'idle'} onClick={() => update.check(true)}>{update.checking ? '检查中…' : '检查更新'}</button>
        {!busy && (update.hasUpdate || update.error) && <a href={releasesUrl} onClick={openReleases} target="_blank" rel="noopener noreferrer">前往下载</a>}
        {update.canInstall && <button className="about-install-update" type="button" disabled={busy || update.checking} onClick={update.install}>{update.phase === 'ready' ? '重启应用' : busy ? '更新中…' : '更新并重启'}</button>}
      </div>
    </section>
    <section className="about-features" aria-label="应用功能">
      <article><Keyboard size={22} /><h3>自定义按键</h3><p>为单击、双击和长按配置按键、组合键、文本与多步操作。</p></article>
      <article><AudioLines size={22} /><h3>遥控器语音</h3><p>长按语音键采集音频，通过虚拟麦克风提供给语音输入应用，支持增益调整与音频测试。</p></article>
      <article><ShieldCheck size={22} /><h3>本地运行</h3><p>映射配置与诊断信息保存在本机，支持 macOS 和 Windows。</p></article>
    </section>
    <p className="about-note">首次使用请完成设备连接、权限与驱动设置，再开启顶栏的自定义按键功能。</p>
  </div>
}
