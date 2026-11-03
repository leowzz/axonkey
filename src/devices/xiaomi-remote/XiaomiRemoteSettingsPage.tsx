type XiaomiRemoteSettingsPageProps = {
  onOpenAudioDriver: () => void
}

export function XiaomiRemoteSettingsPage({ onOpenAudioDriver }: XiaomiRemoteSettingsPageProps) {
  return (
    <section className="device-settings-drawer-panel" aria-label="设备概览">
      <div className="settings-form-fields">
        <div className="settings-form-row">
          <span className="settings-form-label">虚拟麦克风：</span>
          <div className="settings-form-control">
            <button type="button" className="dialog-secondary" onClick={onOpenAudioDriver}>
              管理驱动
            </button>
          </div>
        </div>
      </div>
    </section>
  )
}
