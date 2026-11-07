import { remoteViewFor } from '../packages.ts'

export const xmBt29RemoteButtons = [...remoteViewFor('xmBt29').buttons]
export const xmBt29RemoteButtonIds = xmBt29RemoteButtons.map(button => button.id)
export type XmBt29RemoteButtonId = string
