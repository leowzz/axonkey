import type { Application } from '../../applications'
import type { DeviceInstance } from './model'

export function activeApplicationProfile(instance: DeviceInstance, appId: string | undefined) {
  return instance.appProfileSwitching
    ? instance.applicationProfiles?.find(binding => binding.application.id === appId)
    : undefined
}

export function setApplicationProfile(
  instance: DeviceInstance,
  application: Application,
  profileId: string,
): DeviceInstance {
  const bindings = instance.applicationProfiles ?? []
  const existing = bindings.find(binding => binding.application.id === application.id)
  return {
    ...instance,
    appProfileSwitching: bindings.length ? instance.appProfileSwitching : true,
    applicationProfiles: existing
      ? bindings.map(binding => (binding === existing ? { application, profileId } : binding))
      : [...bindings, { application, profileId }],
  }
}

export function selectInstanceProfile(instance: DeviceInstance, profileId: string, appId?: string): DeviceInstance {
  const binding = activeApplicationProfile(instance, appId)
  return binding
    ? {
        ...instance,
        applicationProfiles: instance.applicationProfiles!.map(item =>
          item === binding ? { ...item, profileId } : item,
        ),
      }
    : { ...instance, activeProfileId: profileId }
}
