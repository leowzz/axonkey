import type { ComponentProps } from 'react'
import { RemoteControl } from '../../components/RemoteControl'
import { cmiotA15RemoteView } from './index.ts'

export function CmiotA15RemoteControl(props: Omit<ComponentProps<typeof RemoteControl>, 'remoteView'>) {
  return <RemoteControl {...props} remoteView={cmiotA15RemoteView} />
}
