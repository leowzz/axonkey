import type { DeviceSnapshot } from './devices/integration/model.ts'

const personalDataKeys = [
  'axonkey.settings.v1',
  'axonkey.cloud-profile-metadata.v1',
  'axonkey.mapping-profiles.v1',
  'axonkey.mapping-profiles.v2',
  'axonkey.saved-sequences.v1',
  'axonkey.audio-settings.v2',
  'axonkey.ui-state.v1',
  'axonkey.device-instances.preview.v1',
  'axonkey.remote-interaction-hint.v1',
  'axonkey.device-hub-discovered-expanded.v1',
]

export async function clearLocalData(
  storage: Pick<Storage, 'removeItem'>,
  devices: { snapshot: DeviceSnapshot; remove: (id: string) => Promise<unknown> },
): Promise<void> {
  let removed = 0
  try {
    for (const instance of devices.snapshot.store.instances) {
      await devices.remove(instance.id)
      removed++
    }
    for (const key of personalDataKeys) storage.removeItem(key)
  } catch (error) {
    throw new Error(`清除未完成（已移除 ${removed} 个设备），请重试：${String(error)}`)
  }
}
