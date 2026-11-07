import { remoteViewFor } from '../packages.ts'

export const xiaomiRemoteButtons = [...remoteViewFor('rc003').buttons]
export const xiaomiRemoteButtonIds = xiaomiRemoteButtons.map(button => button.id)
export type XiaomiRemoteButtonId = string
