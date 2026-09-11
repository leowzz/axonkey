import { AudioLines, Github, Keyboard, ShieldCheck } from 'lucide-react'
import appPackage from '../../package.json'

const appIconUrl = new URL('../../src-tauri/icons/128x128@2x.png', import.meta.url).href

export function AboutPage() {
  return <div className="about-page">
    <section className="about-intro" aria-labelledby="about-title">
      <img className="about-app-icon" src={appIconUrl} alt="Axonkey 应用图标" width={64} height={64} />
      <div>
        <span className="about-version">版本 {appPackage.version}</span>
        <h2 id="about-title">关于 Axonkey</h2>
        <p>面向小米 RC003 蓝牙遥控器的本地控制台，让遥控器成为易于配置的快捷键控制器。</p>
      </div>
      <a className="about-github-button" href="https://github.com/leowzz/axonkey" target="_blank" rel="noopener noreferrer"><Github size={17} aria-hidden="true" /> GitHub</a>
    </section>
    <section className="about-features" aria-label="应用功能">
      <article><Keyboard size={22} /><h3>自定义按键</h3><p>为单击、双击和长按配置按键、组合键、文本与多步操作。</p></article>
      <article><AudioLines size={22} /><h3>遥控器语音</h3><p>长按语音键采集音频，通过虚拟麦克风提供给语音输入应用，支持增益调整与音频测试。</p></article>
      <article><ShieldCheck size={22} /><h3>本地运行</h3><p>映射配置与诊断信息保存在本机，支持 macOS 和 Windows。</p></article>
    </section>
    <p className="about-note">首次使用请完成设备连接、权限与驱动设置，再开启顶栏的自定义按键功能。</p>
  </div>
}
