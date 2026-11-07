import { remoteViewFor } from '../packages.ts'

export const cmiotA15RemoteButtons = [...remoteViewFor('cmiotA15').buttons]
export const cmiotA15RemoteButtonIds = cmiotA15RemoteButtons.map(button => button.id)
export type CmiotA15RemoteButtonId = string
