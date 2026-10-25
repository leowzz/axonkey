import { SystemMouseSettingsPage } from './SystemMouseSettingsPage'

export const systemMouseDevice = {
  id: 'mouse' as const,
  name: '系统鼠标',
  model: 'SYSTEM-MOUSE',
  settingsPage: SystemMouseSettingsPage,
}
