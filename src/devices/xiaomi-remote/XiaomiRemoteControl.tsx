import type { ComponentProps } from 'react'
import { RemoteControl } from '../../components/RemoteControl'
import { xiaomiRemoteView } from './index.ts'

/** Xiaomi RC003 device page control, kept next to the device definition. */
export function XiaomiRemoteControl(props: Omit<ComponentProps<typeof RemoteControl>, 'remoteView'>) {
  return <RemoteControl {...props} remoteView={xiaomiRemoteView} />
}
