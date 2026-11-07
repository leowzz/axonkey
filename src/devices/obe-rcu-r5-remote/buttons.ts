import { remoteViewFor } from '../packages.ts'

export const obeRcuR5RemoteButtons = [...remoteViewFor('obeRcuR5').buttons]
export const obeRcuR5RemoteButtonIds = obeRcuR5RemoteButtons.map(button => button.id)
export type ObeRcuR5RemoteButtonId = string
