import type { ComponentType } from 'react'
import type { DeviceId, DeviceSettingsPageProps } from './types'
import { XiaomiRemoteSettingsPage } from './xiaomi-remote/XiaomiRemoteSettingsPage'
import { CmiotA15SettingsPage } from './cmiot-a15-remote/CmiotA15SettingsPage'
import { SystemMouseSettingsPage } from './system-mouse/SystemMouseSettingsPage'

export const deviceSettingsPages: Record<DeviceId, ComponentType<DeviceSettingsPageProps>> = {
  rc003: XiaomiRemoteSettingsPage,
  cmiotA15: CmiotA15SettingsPage,
  mouse: SystemMouseSettingsPage,
}
