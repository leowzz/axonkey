import { Component, type ErrorInfo, type ReactNode } from 'react'
import { logError } from '../runtimeLogging'

/** Recover a damaged React tree without discarding saved settings or restarting native services. */
export class AppErrorBoundary extends Component<{ children: ReactNode }, { failed: boolean; retried: boolean }> {
  state = { failed: false, retried: false }

  static getDerivedStateFromError() {
    return { failed: true }
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    logError('Application render failed', `${error.message}\n${info.componentStack}`)
    if (!this.state.retried) this.setState({ failed: false, retried: true })
  }

  render() {
    if (!this.state.failed) return this.props.children
    return <main className="app-recovery" role="alert">
      <h1>界面暂时无法显示</h1>
      <p>已保存的按键设置会保留，可以尝试恢复界面。</p>
      <button type="button" onClick={() => this.setState({ failed: false, retried: false })}>恢复界面</button>
    </main>
  }
}
